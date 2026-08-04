import { ethers, network } from 'hardhat'
import { expect } from 'chai'
import { Contract, Signer, parseEther } from 'ethers'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'

import {
  BuybackAllocator,
  BuybackExecutor,
  IERC20,
  IWstETH,
  Order,
  OracleRouter,
  StakingRevenueSource,
  Stonks,
} from '../../typechain-types'
import { getContracts } from '../../utils/contracts'
import { MAGIC_VALUE, MAX_BASIS_POINTS } from '../../utils/gpv2-helpers'
import {
  ALLOCATION_STATUS,
  ALLOCATOR_ROLE,
  DEFAULT_ADMIN_ROLE,
  PRICE_UNIT,
  impersonateWithBalance,
  isForkNetwork,
  mulDiv,
  saturatedSub,
} from '../helpers/buyback-executor'
import {
  ALLOCATOR_PARAMS,
  AMOUNT_CONVERTER_ADDRESS,
  CURVE_POOL_AND_TOKEN_ADDRESS,
  DeployedNestAddresses,
  EXECUTOR_PARAMS,
  LIDO_LOCATOR_ADDRESS,
  ONE_DAY,
  ONE_YEAR,
  ORACLE_ROUTER_ADDRESS,
  STONKS_PARAMS,
  bindNestStack,
  bindRealCurvePool,
  captureTrackedOrderState,
  configureRealOracleRouter,
  deployNestStack,
  driveRebase,
  expectedTreasuryStEth,
  fundStEth,
  reserveAccruedUSD,
  rolledWindowEndTS,
  simulateCowFill,
  tryRegisterObserver,
} from '../helpers/buyback-scenario'

// Stage the NEST buyback system exactly as the deploy scripts put it on mainnet — the real
// OracleRouter 0x79ef (configured here by impersonating its admin, since it ships unconfigured),
// the real ETH-anchored AmountConverter 0x70dA, the real empty Curve LDO/wstETH pool 0xD7f1, and
// production caps/bounds — then drive the full lifecycle in both operating modes:
//
//   rebase -> StakingRevenueSource (pending stETH) -> convertPendingRevenueToUSD (cumulative USD)
//     -> BuybackAllocator.allocate (stETH to executor, capped by the $50k/day budget)
//       -> BuybackExecutor.onStEthAllocated (half to Stonks in LP mode, all in treasury mode)
//         -> placeOrder (one CoW order for the forwarded balance, capped at the 20 stETH
//            production order maximum) -> [settlement simulated]
//           -> LP mode: addLiquidity bootstraps the empty production pool, LP to the executor
//           -> treasury mode: bought LDO settles straight to the Aragon Agent
//
// Prerequisites: a mainnet fork node (`npm run node-hardhat`), run via `npm run test:integration`.
// The rebase path is detected from the fork: when `LidoLocator.postTokenRebaseReceiver()` is the
// NEST TokenRateNotifier (CI applies the lidofinance/core mock-upgrade, see
// .github/workflows/integration-tests.yml; mainnet will carry it post-launch), the test drives the
// real `handlePostTokenRebase` fan-out. On a plain fork with the legacy notifier it falls back —
// with a warning — to pushing the rebase straight into the source by impersonating the receiver,
// which the source authorizes against, exercising the same accounting with no notifier dependency.
//
// Post-launch, fill `deployedNest` with the live addresses to run the identical lifecycle over the
// deployed contracts instead of a fresh staging (the `setupOverDeployedContracts` idiom from
// ./scenario.ts). Staging steps that governance already executed detect the applied state and
// skip, except the oracle router configuration: its setters overwrite, and the fork-generous
// staleness must be re-applied anyway because fork blocks age past production thresholds.
const deployedNest: DeployedNestAddresses[] = []

// Fee shares minted on the simulated rebase. Sized so the resulting treasury revenue dwarfs the
// daily reserve and saturates the $50k daily cap, making the cap the binding constraint.
const SHARES_MINTED_AS_FEES = parseEther('1000000')

// Fee shares for the under-reserve day: the ~50% treasury slice of 10 stETH-worth of shares stays
// far below one day's $109,589 reserve at any plausible stETH price, so the checkpoint banks a
// budget deficit and the allocation is skipped.
const UNDER_RESERVE_SHARES = parseEther('10')

const contracts = getContracts()

const minBigInt = (...values: bigint[]): bigint => values.reduce((a, b) => (a < b ? a : b))

const testItems: Array<DeployedNestAddresses | null> = deployedNest.length ? deployedNest : [null] // null => fresh production-fidelity deploy

testItems.forEach((deployedItem) => {
  const isDeployed = deployedItem !== null
  const stackName = isDeployed ? deployedItem.name : 'fresh production-fidelity deploy'

  describe(`NEST buyback scenario — ${stackName} (mainnet fork)`, function () {
    let snapshot: SnapshotRestorer
    let snapshotStaged: SnapshotRestorer

    let deployer: Signer
    let deployerAddress: string
    let adminSigner: Signer // Aragon Voting, the production admin of every NEST contract

    let stEth: IERC20
    let ldo: IERC20
    let wstEth: IWstETH
    let pool: Contract
    let oracleRouter: OracleRouter
    let notifierAddress: string

    let revenueSource: StakingRevenueSource
    let executor: BuybackExecutor
    let allocator: BuybackAllocator
    let stonksLp: Stonks
    let stonksTreasury: Stonks

    let revenueSourceAddress: string
    let executorAddress: string
    let allocatorAddress: string
    let stonksLpAddress: string
    let stonksTreasuryAddress: string

    // Live oracle prices, read once after the router is configured. Chainlink answers are frozen
    // on the fork, so every later expectation derives from these deterministically.
    let ldoUsdPrice: bigint
    let stEthUsdPrice: bigint

    // Detected in `before`: true when the fork carries the NEST TokenRateNotifier, so rebases
    // drive the real fan-out; false falls back to the direct authorized push.
    let viaNotifier: boolean

    // Set by the placeOrder stage, consumed by the settlement stage of the same mode context.
    let order: Order
    let orderBuyAmount: bigint
    let orderValidTo: bigint

    before(async function () {
      if (!isForkNetwork()) {
        return this.skip()
      }

      snapshot = await takeSnapshot()

      // A fork can land on a base fee the node's own fee estimation undershoots, bouncing every
      // staging transaction. Pin it low once; the staged snapshot then carries it to every test.
      await network.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x1'])
      ;[deployer] = await ethers.getSigners()
      deployerAddress = await deployer.getAddress()

      const locator = await ethers.getContractAt('ILidoLocator', LIDO_LOCATOR_ADDRESS)
      expect(await locator.lido()).to.equal(contracts.STETH)
      notifierAddress = await locator.postTokenRebaseReceiver()

      stEth = await ethers.getContractAt('IERC20', contracts.STETH)
      ldo = await ethers.getContractAt('IERC20', contracts.LDO)
      wstEth = await ethers.getContractAt('IWstETH', contracts.WSTETH)
      pool = bindRealCurvePool(deployer)

      // The real router ships unconfigured; set the production feed set as its admin (Voting).
      oracleRouter = await configureRealOracleRouter({
        stEth: contracts.STETH,
        ldo: contracts.LDO,
      })

      // Verify gate: the staging math below divides by these prices, so fail fast when a feed
      // path is broken. The bands are wide enough for any plausible market, but tight enough to
      // catch a mis-scaled answer (a 1e8-scaled Chainlink price is off by ten orders of
      // magnitude). The full oracle surface, including the ETH-anchored converter path, is
      // asserted in the wiring context.
      ;[stEthUsdPrice] = await oracleRouter.getUsdPrices(contracts.STETH, contracts.STETH)
      ;[ldoUsdPrice] = await oracleRouter.getUsdPrices(contracts.LDO, contracts.STETH)
      expect(stEthUsdPrice, 'stETH/USD price out of the plausible 1e18-scaled range').to.be.gte(
        parseEther('100')
      )
      expect(stEthUsdPrice, 'stETH/USD price out of the plausible 1e18-scaled range').to.be.lte(
        parseEther('100000')
      )
      expect(ldoUsdPrice, 'LDO/USD price out of the plausible 1e18-scaled range').to.be.gte(
        parseEther('0.1')
      )
      expect(ldoUsdPrice, 'LDO/USD price out of the plausible 1e18-scaled range').to.be.lte(
        parseEther('1000')
      )

      const nest = isDeployed ? await bindNestStack(deployedItem) : await deployNestStack(deployer)
      ;({ revenueSource, executor, allocator, stonksLp, stonksTreasury } = nest)
      revenueSourceAddress = await revenueSource.getAddress()
      executorAddress = await executor.getAddress()
      allocatorAddress = await allocator.getAddress()
      stonksLpAddress = await stonksLp.getAddress()
      stonksTreasuryAddress = await stonksTreasury.getAddress()

      adminSigner = await impersonateWithBalance(contracts.ADMIN)

      // Post-deploy governance wiring, guarded so already-applied steps are no-ops in deployed
      // mode: allocator role on the executor, LP Stonks as the active instance, activation.
      if (!(await executor.hasRole(ALLOCATOR_ROLE, allocatorAddress))) {
        await executor.connect(adminSigner).grantRole(ALLOCATOR_ROLE, allocatorAddress)
      }
      if ((await executor.stonks()) !== stonksLpAddress) {
        await executor.connect(adminSigner).setStonks(stonksLpAddress)
      }
      if ((await allocator.activationTS()) === 0n) {
        await allocator.connect(adminSigner).activate()
      }
      // Rebase-path detection: register on the notifier when the fork carries the NEST
      // TokenRateNotifier (CI mock-upgrade, or mainnet post-launch); otherwise push rebases
      // straight into the source, which authorizes against the receiver address itself.
      const notifier = await ethers.getContractAt('ITokenRateNotifier', notifierAddress)
      viaNotifier = await tryRegisterObserver(notifier, revenueSourceAddress)
      if (!viaNotifier) {
        console.warn(
          '      ⚠ Legacy TokenRateNotifier on the fork (no NEST mock-upgrade applied): ' +
            'driving rebases via direct pushTokenRate instead of the notifier fan-out.'
        )
      }

      // Fund the allocator with twice the daily cap in stETH so the cap, not the balance, binds.
      const allocatorFunding = 2n * mulDiv(ALLOCATOR_PARAMS.dailyCapUSD, PRICE_UNIT, stEthUsdPrice)
      await fundStEth(deployer, allocatorAddress, allocatorFunding)

      // LDO war chest for the simulated CoW fills, sized off the order cap at live prices with
      // double headroom (LDO is a MiniMe token, so an underfunded fill would no-op silently
      // instead of reverting). Sourcing it from the Agent keeps treasury-mode deliveries
      // observable as a balance delta rather than an Agent self-transfer.
      const ldoFillReserve = mulDiv(
        2n * EXECUTOR_PARAMS.maxAllowedOrderAmount,
        stEthUsdPrice,
        ldoUsdPrice
      )
      const agent = await impersonateWithBalance(contracts.AGENT)
      await ldo.connect(agent).transfer(deployerAddress, ldoFillReserve)

      snapshotStaged = await takeSnapshot()
    })

    after(async function () {
      if (snapshot) {
        await snapshot.restore()
      }
    })

    // --- Lifecycle stages, shared verbatim by both operating modes ---

    // Stage 1: one fee-minting rebase lands the treasury slice in the pending stETH bucket.
    async function runRebaseStage(sharesMintedAsFees: bigint): Promise<void> {
      const pendingBefore = await revenueSource.pendingRevenueStEth()
      const cumulativeBefore = await revenueSource.getCumulativeRevenueUSD()

      // The mainnet treasury slice is ~50% of the fee shares and one share is worth more than one
      // stETH, so a slice under a tenth of the minted shares signals broken fee-split math rather
      // than a plausible configuration.
      const expectedStEth = await expectedTreasuryStEth(sharesMintedAsFees)
      expect(expectedStEth, 'fee split yields an implausibly small treasury slice').to.be.gt(
        sharesMintedAsFees / 10n
      )

      const receipt = await driveRebase(revenueSource, sharesMintedAsFees, { viaNotifier })

      const accumulated = await revenueSource.queryFilter(
        revenueSource.filters.RevenueAccumulatedInStEth(),
        receipt.blockNumber,
        receipt.blockNumber
      )
      expect(accumulated.length).to.equal(1)
      expect(accumulated[0].args.stEthAmount).to.equal(expectedStEth)
      expect(accumulated[0].args.pendingRevenueStEth).to.equal(pendingBefore + expectedStEth)

      // The notifier isolates observer reverts as PushTokenRateFailed; ours must not be among
      // them. On the direct-push path the call itself would have reverted, so the filter is empty.
      const notifier = await ethers.getContractAt('ITokenRateNotifier', notifierAddress)
      const failures = await notifier.queryFilter(
        notifier.filters.PushTokenRateFailed(revenueSourceAddress),
        receipt.blockNumber,
        receipt.blockNumber
      )
      expect(failures.length).to.equal(0)

      expect(await revenueSource.pendingRevenueStEth()).to.equal(pendingBefore + expectedStEth)
      expect(await revenueSource.getCumulativeRevenueUSD()).to.equal(cumulativeBefore)
    }

    // Stage 2: the pending bucket settles into the cumulative USD accumulator at the oracle price.
    async function runConvertStage(): Promise<void> {
      const pending = await revenueSource.pendingRevenueStEth()
      const cumulativeBefore = await revenueSource.getCumulativeRevenueUSD()
      const expectedUSD = mulDiv(pending, stEthUsdPrice, PRICE_UNIT)
      expect(expectedUSD).to.be.gt(0n)

      await expect(revenueSource.convertPendingRevenueToUSD())
        .to.emit(revenueSource, 'PendingRevenueConverted')
        .withArgs(pending, stEthUsdPrice, expectedUSD)
        .and.to.emit(revenueSource, 'RevenueAdded')
        .withArgs(expectedUSD, cumulativeBefore + expectedUSD)

      expect(await revenueSource.pendingRevenueStEth()).to.equal(0n)
      expect(await revenueSource.getCumulativeRevenueUSD()).to.equal(cumulativeBefore + expectedUSD)
    }

    // Sums cumulative revenue across the registered sources, as `_revenueSumUSD` does.
    async function totalRevenueAcrossSources(): Promise<bigint> {
      let totalRevenueUSD = 0n
      for (const sourceAddress of await allocator.revenueSources()) {
        const source = await ethers.getContractAt('IRevenueSource', sourceAddress)
        totalRevenueUSD += await source.getCumulativeRevenueUSD()
      }
      return totalRevenueUSD
    }

    // Stage 3: allocate() banks the surplus, releases stETH capped by the daily budget, and the
    // executor hook forwards it to the active Stonks — half in LP mode, all in treasury mode.
    // The keeper preview `spendable()` is asserted against the actual release on both sides.
    async function runAllocateStage(mode: 'lp' | 'treasury'): Promise<void> {
      const targetStonksAddress = mode === 'lp' ? stonksLpAddress : stonksTreasuryAddress

      // Pre-state for an exact off-chain mirror of the budget and spend math.
      const budgetBefore = await allocator.budgetUSD()
      const baselineRevenue = await allocator.lastTotalRevenueUSD()
      const reserveAnchor = await allocator.reserveAnchorTS()
      const reserveRate = await allocator.reserveDailyRateUSD()
      const surplusShareBP = await allocator.surplusShareBP()
      const dailyCap = await allocator.dailyCapUSD()
      const yearlyCap = await allocator.yearlyCapUSD()
      const dailyBefore = await allocator.daily()
      const yearlyBefore = await allocator.yearly()
      const activationTS = await allocator.activationTS()
      const totalRevenueUSD = await totalRevenueAcrossSources()

      const allocatorStEthBefore = await stEth.balanceOf(allocatorAddress)
      const executorStEthBefore = await stEth.balanceOf(executorAddress)
      const executorLdoBefore = await ldo.balanceOf(executorAddress)
      const stonksStEthBefore = await stEth.balanceOf(targetStonksAddress)
      const trackedOrder = await captureTrackedOrderState(executor)
      const minResidualToRecover = await executor.MIN_ORDER_RESIDUAL_TO_RECOVER()

      // Keeper preview: allocate() must deliver exactly what spendable() promises.
      const [previewStatus, previewSpendableUSD, previewSpendableStEth] =
        await allocator.spendable()
      expect(previewStatus).to.equal(ALLOCATION_STATUS.Eligible)

      const receipt = (await (await allocator.allocate()).wait())!
      const blockTimestamp = BigInt(
        (await ethers.provider.getBlock(receipt.blockNumber))!.timestamp
      )

      // Checkpoint banks the surplus share of new revenue net of the accrued reserve.
      const reserveUSD = reserveAccruedUSD(reserveRate, reserveAnchor, blockTimestamp)
      const budgetDeltaUSD =
        ((totalRevenueUSD - baselineRevenue - reserveUSD) * surplusShareBP) / MAX_BASIS_POINTS
      const budgetCheckpointed = budgetBefore + budgetDeltaUSD

      const [checkpoint] = await allocator.queryFilter(
        allocator.filters.Checkpoint(),
        receipt.blockNumber,
        receipt.blockNumber
      )
      expect(checkpoint.args.lastTotalRevenueUSD).to.equal(totalRevenueUSD)
      expect(checkpoint.args.reserveUSD).to.equal(reserveUSD)
      expect(checkpoint.args.budgetDeltaUSD).to.equal(budgetDeltaUSD)
      expect(checkpoint.args.budgetUSD).to.equal(budgetCheckpointed)

      // Spendable: the budget clamped by the yearly window, the daily window, and the balance,
      // restated in USD from the floored stETH amount — the exact `_spendable` sequence.
      const availableUSD = budgetCheckpointed > 0n ? budgetCheckpointed : 0n
      const yearlyUnspent = saturatedSub(
        yearlyCap,
        blockTimestamp >= yearlyBefore.endTS ? 0n : yearlyBefore.spentUSD
      )
      const dailyUnspent = saturatedSub(
        dailyCap,
        blockTimestamp >= dailyBefore.endTS ? 0n : dailyBefore.spentUSD
      )
      // The scenario premise: the saturating rebase fills the budget past the caps and the staging
      // funded the allocator past the daily cap, so the daily window is the binding constraint.
      // Pinning the binding term keeps the mirror below honest — without this, a broken budget or
      // funding path could quietly shrink the release and every downstream check would follow it.
      expect(availableUSD, 'budget no longer saturates the daily cap').to.be.gte(dailyUnspent)
      expect(yearlyUnspent, 'yearly window binds before the daily cap').to.be.gte(dailyUnspent)
      expect(
        mulDiv(dailyUnspent, PRICE_UNIT, stEthUsdPrice),
        'allocator stETH balance binds before the daily cap'
      ).to.be.lte(allocatorStEthBefore)

      const spendStEth = minBigInt(
        mulDiv(minBigInt(availableUSD, yearlyUnspent, dailyUnspent), PRICE_UNIT, stEthUsdPrice),
        allocatorStEthBefore
      )
      const spendUSD = mulDiv(spendStEth, stEthUsdPrice, PRICE_UNIT)

      const [allocated] = await allocator.queryFilter(
        allocator.filters.Allocated(),
        receipt.blockNumber,
        receipt.blockNumber
      )
      expect(allocated.args.triggeredBy).to.equal(deployerAddress)
      expect(allocated.args.executor).to.equal(executorAddress)
      expect(allocated.args.spendUSD).to.equal(spendUSD)
      expect(allocated.args.spendStEth).to.equal(spendStEth)

      // The preview and the release read the same frozen state, so they agree exactly.
      expect(previewSpendableUSD).to.equal(spendUSD)
      expect(previewSpendableStEth).to.equal(spendStEth)

      const skipped = await allocator.queryFilter(
        allocator.filters.AllocationSkipped(),
        receipt.blockNumber,
        receipt.blockNumber
      )
      expect(skipped.length).to.equal(0)

      // Executor hook: an expired tracked order is swept first (residual recovered to its
      // creating Stonks), then LP mode reserves the stETH value of held LDO, the target Stonks
      // balance, and a live order's balance, forwarding half of the remainder; treasury mode
      // forwards the whole balance. Fresh staging tracks no order, zeroing the order terms.
      const orderExpired = trackedOrder !== null && blockTimestamp > trackedOrder.validTo
      const sweptResidual =
        trackedOrder !== null && orderExpired && trackedOrder.stEthBalance >= minResidualToRecover
          ? trackedOrder.stEthBalance
          : 0n
      const liveOrderReserve = trackedOrder !== null && !orderExpired ? trackedOrder.stEthBalance : 0n
      const stonksStEthAtHook =
        trackedOrder !== null && trackedOrder.recoveryStonks === targetStonksAddress
          ? stonksStEthBefore + sweptResidual
          : stonksStEthBefore

      const executorLdoInStEth = mulDiv(executorLdoBefore, ldoUsdPrice, stEthUsdPrice)
      const expectedFreeStEth =
        mode === 'lp'
          ? saturatedSub(
              saturatedSub(
                saturatedSub(executorStEthBefore + spendStEth, executorLdoInStEth),
                stonksStEthAtHook
              ),
              liveOrderReserve
            )
          : executorStEthBefore + spendStEth

      const [processed] = await executor.queryFilter(
        executor.filters.AllocationProcessed(),
        receipt.blockNumber,
        receipt.blockNumber
      )
      expect(processed.args.stonks).to.equal(targetStonksAddress)
      expect(processed.args.freeStEth).to.be.closeTo(expectedFreeStEth, 2n)

      const freeStEth = processed.args.freeStEth
      const forwarded = processed.args.forwardedToStonks
      expect(forwarded).to.equal(mode === 'lp' ? freeStEth / 2n : freeStEth)
      // Below the order minimum the hook would return without transferring — the happy path
      // must actually move the sell-side stETH.
      expect(forwarded).to.be.gte(EXECUTOR_PARAMS.minAllowedOrderAmount)

      // Both sides of every stETH hop (2 wei tolerance per transfer for shares rounding; the
      // Stonks side allows one extra hop for a swept-order residual).
      expect(await stEth.balanceOf(allocatorAddress)).to.be.closeTo(
        allocatorStEthBefore - spendStEth,
        2n
      )
      expect(await stEth.balanceOf(targetStonksAddress)).to.be.closeTo(
        stonksStEthAtHook + forwarded,
        4n
      )
      expect(await stEth.balanceOf(executorAddress)).to.be.closeTo(
        executorStEthBefore + spendStEth - forwarded,
        4n
      )

      // Accounting: the budget nets out the spend, the revenue baseline advances, both windows
      // carry the spend with their ends on the activation-aligned boundaries, and the reserve
      // cursor moves to the next day's start.
      expect(await allocator.budgetUSD()).to.equal(budgetCheckpointed - spendUSD)
      expect(await allocator.lastTotalRevenueUSD()).to.equal(totalRevenueUSD)
      expect(await allocator.reserveAnchorTS()).to.equal((blockTimestamp / ONE_DAY + 1n) * ONE_DAY)
      const dailyAfter = await allocator.daily()
      const yearlyAfter = await allocator.yearly()
      expect(dailyAfter.spentUSD).to.equal(saturatedSub(dailyCap, dailyUnspent) + spendUSD)
      expect(yearlyAfter.spentUSD).to.equal(saturatedSub(yearlyCap, yearlyUnspent) + spendUSD)
      expect(dailyAfter.endTS).to.equal(
        rolledWindowEndTS(activationTS, ONE_DAY, dailyBefore.endTS, blockTimestamp)
      )
      expect(yearlyAfter.endTS).to.equal(
        rolledWindowEndTS(activationTS, ONE_YEAR, yearlyBefore.endTS, blockTimestamp)
      )

      // Keeper preview after the release: nothing is spendable until the daily window rolls at
      // its next activation-aligned day boundary. The USD->stETH->USD round-trip floors the
      // spend, so the window closes with a remainder below one stETH wei's worth of USD: an exact
      // saturation previews as WindowCapReached, a residual previews as AllocationBelowMin (it
      // converts to zero stETH).
      const dailyRemainderUSD = dailyUnspent - spendUSD
      const expectedStatusAfter =
        dailyRemainderUSD === 0n
          ? ALLOCATION_STATUS.WindowCapReached
          : ALLOCATION_STATUS.AllocationBelowMin
      const [statusAfter, spendableUSDAfter, spendableStEthAfter] = await allocator.spendable()
      expect(statusAfter).to.equal(expectedStatusAfter)
      expect(spendableUSDAfter).to.equal(0n)
      expect(spendableStEthAfter).to.equal(0n)
    }

    // Stage 4: placeOrder() sells the forwarded Stonks balance, capped at the production
    // 20 stETH order maximum, into a fresh CoW order and tracks it. The keeper preview
    // `getPlacementStatus()` is asserted open-and-sized before the placement and closed after it.
    async function runPlaceOrderStage(
      targetStonks: Stonks,
      expectedReceiver: string
    ): Promise<void> {
      const targetStonksAddress = await targetStonks.getAddress()
      const stonksStEthBefore = await stEth.balanceOf(targetStonksAddress)

      // placeOrder sells the Stonks balance capped at the production 20 stETH order maximum.
      // Which side binds depends on the live stETH price: a $50k/day allocation exceeds the cap
      // below ~$2,500/stETH in treasury mode and ~$1,250 in LP mode (which forwards half). The
      // min() mirrors the contract's sizing rule exactly, so every downstream check pins the
      // actual amounts either way; only the order minimum is a hard regime requirement.
      expect(
        stonksStEthBefore,
        'forwarded stETH below the order minimum; stETH price regime outgrew the caps'
      ).to.be.gte(EXECUTOR_PARAMS.minAllowedOrderAmount)
      const expectedSellAmount = minBigInt(
        stonksStEthBefore,
        EXECUTOR_PARAMS.maxAllowedOrderAmount
      )

      // Cross-validate the ETH-anchored Stonks estimate against the router's oracle ratio: only
      // the 1.1% margin and the deviation between the Chainlink USD and ETH feed paths separate
      // them, so a gap outside this band means one of the two pricing paths is broken.
      const expectedMinBuy = await targetStonks.estimateTradeOutput(expectedSellAmount)
      const oracleEquivalentLdo = mulDiv(expectedSellAmount, stEthUsdPrice, ldoUsdPrice)
      expect(expectedMinBuy, 'estimate strayed below the oracle ratio').to.be.gte(
        mulDiv(oracleEquivalentLdo, 95n, 100n)
      )
      expect(expectedMinBuy, 'estimate strayed above the oracle ratio').to.be.lte(
        mulDiv(oracleEquivalentLdo, 102n, 100n)
      )

      // Keeper preview: the placement gate is open and sizes the sell exactly as placeOrder will.
      const placementBefore = await executor.getPlacementStatus()
      expect(placementBefore.canPlace).to.equal(true)
      expect(placementBefore.activeOrder).to.equal(ethers.ZeroAddress)
      expect(placementBefore.activeOrderValidTo).to.equal(0n)
      expect(placementBefore.isStonksCreationPaused).to.equal(false)
      expect(placementBefore.isStonksKilled).to.equal(false)
      expect(placementBefore.sellAmount).to.equal(expectedSellAmount)
      expect(placementBefore.estimatedBuyAmount).to.equal(expectedMinBuy)

      const receipt = (await (await executor.placeOrder()).wait())!
      const blockTimestamp = BigInt(
        (await ethers.provider.getBlock(receipt.blockNumber))!.timestamp
      )

      const [placed] = await executor.queryFilter(
        executor.filters.OrderPlaced(),
        receipt.blockNumber,
        receipt.blockNumber
      )
      expect(placed.args.order).to.not.equal(ethers.ZeroAddress)
      expect(placed.args.sellAmount).to.equal(expectedSellAmount)
      expect(placed.args.minBuyAmount).to.equal(expectedMinBuy)

      const orderAddress = placed.args.order
      const expectedValidTo = blockTimestamp + STONKS_PARAMS.orderDurationInSeconds
      expect(await executor.lastOrderAddress()).to.equal(orderAddress)
      expect(await executor.lastOrderValidTo()).to.equal(expectedValidTo)

      expect(await stEth.balanceOf(orderAddress)).to.be.closeTo(expectedSellAmount, 2n)
      expect(await stEth.balanceOf(targetStonksAddress)).to.be.closeTo(
        stonksStEthBefore - expectedSellAmount,
        4n
      )

      order = await ethers.getContractAt('Order', orderAddress)
      const [orderHash, tokenFrom, tokenTo, sellAmount, buyAmount, validTo, receiver] =
        await order.getOrderDetails()
      expect(orderHash).to.not.equal(ethers.ZeroHash)
      expect(tokenFrom).to.equal(contracts.STETH)
      expect(tokenTo).to.equal(contracts.LDO)
      // The order books its actual received balance, a few wei under the requested sell.
      expect(sellAmount).to.be.closeTo(expectedSellAmount, 2n)
      // The received balance never exceeds the estimate basis, so the floor is the min-buy.
      expect(buyAmount).to.equal(expectedMinBuy)
      expect(validTo).to.equal(expectedValidTo)
      expect(receiver).to.equal(expectedReceiver)
      orderBuyAmount = buyAmount
      orderValidTo = expectedValidTo

      // CoW settlement handshake: only the exact order hash validates.
      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)
      await expect(order.isValidSignature(ethers.ZeroHash, '0x'))
        .to.be.revertedWithCustomError(order, 'InvalidOrderHash')
        .withArgs(orderHash, ethers.ZeroHash)

      // Keeper preview: the live tracked order closes the gate until it expires or settles.
      const placementAfter = await executor.getPlacementStatus()
      expect(placementAfter.canPlace).to.equal(false)
      expect(placementAfter.activeOrder).to.equal(orderAddress)
      expect(placementAfter.activeOrderValidTo).to.equal(expectedValidTo)

      // One live order at a time.
      await expect(executor.placeOrder())
        .to.be.revertedWithCustomError(executor, 'LiveOrderInPlace')
        .withArgs(orderAddress, expectedValidTo)
    }

    // Stage 5: a stubbed CoW settlement — the vault relayer pulls the sell-side stETH and the
    // buy-side LDO lands on the order receiver: the executor in LP mode (feeding the next pool
    // deposit), the Agent treasury otherwise, with the executor out of the LDO flow entirely.
    async function runSettlementStage(mode: 'lp' | 'treasury'): Promise<void> {
      const receiver = mode === 'lp' ? executorAddress : contracts.AGENT
      const expectedExecutorLdoDelta = mode === 'lp' ? orderBuyAmount : 0n

      // The order still holds the full booked sell amount — nothing may have drained it between
      // placement and settlement.
      const orderAddress = await order.getAddress()
      const [, , , bookedSellAmount] = await order.getOrderDetails()
      expect(await stEth.balanceOf(orderAddress)).to.equal(bookedSellAmount)

      const receiverLdoBefore = await ldo.balanceOf(receiver)
      const executorLdoBefore = await ldo.balanceOf(executorAddress)

      await simulateCowFill({
        orderAddress,
        buyAmount: orderBuyAmount,
        receiver,
        ldoHolder: deployer,
      })

      expect(await stEth.balanceOf(orderAddress)).to.be.closeTo(0n, 1n)
      expect(await ldo.balanceOf(receiver)).to.equal(receiverLdoBefore + orderBuyAmount)
      expect(await ldo.balanceOf(executorAddress)).to.equal(
        executorLdoBefore + expectedExecutorLdoDelta
      )

      // The executor keeps tracking the settled order until it expires, so the placement gate
      // stays closed for the rest of its validity window.
      const placement = await executor.getPlacementStatus()
      expect(placement.canPlace).to.equal(false)
      expect(placement.activeOrder).to.equal(orderAddress)
      expect(placement.activeOrderValidTo).to.equal(orderValidTo)
    }

    // --- Wiring and configuration, asserted against the production deploy parameters ---

    context('Wiring and configuration', function () {
      it('should wire the executor immutables to the production dependencies', async function () {
        expect(await executor.WSTETH()).to.equal(contracts.WSTETH)
        expect(await executor.STETH()).to.equal(contracts.STETH)
        expect(await executor.LDO()).to.equal(contracts.LDO)
        expect(await executor.ORACLE_ROUTER()).to.equal(ORACLE_ROUTER_ADDRESS)
        expect(await executor.CURVE_POOL_AND_TOKEN()).to.equal(CURVE_POOL_AND_TOKEN_ADDRESS)
        expect(await executor.TREASURY()).to.equal(contracts.AGENT)
        expect(await executor.PRICE_UNIT()).to.equal(await oracleRouter.PRICE_UNIT())
        expect(await executor.PRICE_UNIT()).to.equal(PRICE_UNIT)
      })

      it('should hold the production executor bounds', async function () {
        expect(await executor.poolPriceDivergenceToleranceBps()).to.equal(
          EXECUTOR_PARAMS.poolPriceDivergenceToleranceBps
        )
        expect(await executor.minAllowedOrderAmount()).to.equal(
          EXECUTOR_PARAMS.minAllowedOrderAmount
        )
        expect(await executor.maxAllowedOrderAmount()).to.equal(
          EXECUTOR_PARAMS.maxAllowedOrderAmount
        )
        expect(await executor.minDepositValueUsd()).to.equal(EXECUTOR_PARAMS.minDepositValueUsd)
        expect(await executor.maxDepositValueUsd()).to.equal(EXECUTOR_PARAMS.maxDepositValueUsd)
        expect(await executor.poolBootstrapMinTvlUsd()).to.equal(
          EXECUTOR_PARAMS.poolBootstrapMinTvlUsd
        )
      })

      it('should grant the executor roles and derive LP mode from the staged Stonks', async function () {
        expect(await executor.hasRole(DEFAULT_ADMIN_ROLE, contracts.ADMIN)).to.equal(true)
        expect(await executor.hasRole(ALLOCATOR_ROLE, allocatorAddress)).to.equal(true)
        expect(await executor.stonks()).to.equal(stonksLpAddress)
        expect(await executor.lpModeEnabled()).to.equal(true)
        expect(await executor.stonksOrderDurationSeconds()).to.equal(
          STONKS_PARAMS.orderDurationInSeconds
        )
      })

      it('should hold the production allocator configuration and revenue sources', async function () {
        expect(await allocator.hasRole(DEFAULT_ADMIN_ROLE, contracts.ADMIN)).to.equal(true)
        expect(await allocator.STETH()).to.equal(contracts.STETH)
        expect(await allocator.ORACLE_ROUTER()).to.equal(ORACLE_ROUTER_ADDRESS)
        expect(await allocator.executor()).to.equal(executorAddress)
        expect(await allocator.dailyCapUSD()).to.equal(ALLOCATOR_PARAMS.dailyCapUSD)
        expect(await allocator.yearlyCapUSD()).to.equal(ALLOCATOR_PARAMS.yearlyCapUSD)
        expect(await allocator.reserveDailyRateUSD()).to.equal(ALLOCATOR_PARAMS.reserveDailyRateUSD)
        expect(await allocator.minStEthPriceUSD()).to.equal(ALLOCATOR_PARAMS.minStEthPriceUSD)
        expect(await allocator.minSpendPerCallUSD()).to.equal(ALLOCATOR_PARAMS.minSpendPerCallUSD)
        expect(await allocator.surplusShareBP()).to.equal(ALLOCATOR_PARAMS.surplusShareBP)
        expect(await allocator.revenueSources()).to.deep.equal([revenueSourceAddress])
        expect(await allocator.activationTS()).to.not.equal(0n)
      })

      it('should wire both Stonks instances with production trade parameters', async function () {
        async function assertBuybackStonks(stonks: Stonks, expectedReceiver: string) {
          expect(await stonks.manager()).to.equal(executorAddress)
          expect(await stonks.RECEIVER()).to.equal(expectedReceiver)
          expect(await stonks.TOKEN_FROM()).to.equal(contracts.STETH)
          expect(await stonks.TOKEN_TO()).to.equal(contracts.LDO)
          expect(await stonks.AMOUNT_CONVERTER()).to.equal(AMOUNT_CONVERTER_ADDRESS)
          expect(await stonks.ORDER_DURATION_IN_SECONDS()).to.equal(
            STONKS_PARAMS.orderDurationInSeconds
          )
          expect(await stonks.MARGIN_IN_BASIS_POINTS()).to.equal(STONKS_PARAMS.marginInBasisPoints)
          expect(await stonks.PRICE_TOLERANCE_IN_BASIS_POINTS()).to.equal(
            STONKS_PARAMS.priceToleranceInBasisPoints
          )
          expect(await stonks.MAX_IMPROVEMENT_IN_BASIS_POINTS()).to.equal(
            STONKS_PARAMS.maxImprovementInBasisPoints
          )
          expect(await stonks.ALLOW_PARTIAL_FILL()).to.equal(STONKS_PARAMS.allowPartialFill)
        }

        // The instances differ only in the settlement receiver, which selects the operating mode.
        await assertBuybackStonks(stonksLp, executorAddress)
        await assertBuybackStonks(stonksTreasury, contracts.AGENT)
      })

      it('should price every production oracle path', async function () {
        const [stEthUsd] = await oracleRouter.getUsdPrices(contracts.STETH, contracts.STETH)
        const [ldoUsd, quotedStEthUsd] = await oracleRouter.getUsdPrices(
          contracts.LDO,
          contracts.STETH
        )
        expect(stEthUsd).to.be.gt(0n)
        expect(ldoUsd).to.be.gt(0n)
        expect(quotedStEthUsd).to.equal(stEthUsd)

        const amountConverter = await ethers.getContractAt(
          'AmountConverter',
          AMOUNT_CONVERTER_ADDRESS
        )
        expect(
          await amountConverter.getExpectedOut(contracts.STETH, contracts.LDO, PRICE_UNIT)
        ).to.be.gt(0n)
      })

    })

    // --- LP mode: sell half, pair the bought LDO with the retained half into the Curve pool ---

    context('LP mode lifecycle', function () {
      before(async function () {
        await snapshotStaged.restore()
      })

      it('should accumulate the treasury slice of a fee-minting rebase', async function () {
        await runRebaseStage(SHARES_MINTED_AS_FEES)
      })

      it('should convert the pending stETH bucket to cumulative USD revenue', async function () {
        await runConvertStage()
      })

      it('should allocate the daily cap and forward half of the free stETH to Stonks', async function () {
        await runAllocateStage('lp')
      })

      it('should place a CoW order for the forwarded stETH, capped at the order maximum, with the executor as receiver', async function () {
        await runPlaceOrderStage(stonksLp, executorAddress)
      })

      it('should settle the order delivering the bought LDO to the executor', async function () {
        await runSettlementStage('lp')
      })

      it('should bootstrap the empty production Curve pool with a balanced deposit', async function () {
        expect(await executor.canAddLiquidity()).to.equal(true)

        // The settlement is the executor's only LDO source, so the whole bought amount is here.
        const executorLdoBefore = await ldo.balanceOf(executorAddress)
        const executorStEthBefore = await stEth.balanceOf(executorAddress)
        expect(executorLdoBefore).to.equal(orderBuyAmount)

        // The bought LDO (half the allocation minus margin) is the smaller-USD side, so it
        // deposits in full and sizes the paired stETH leg.
        const ldoUsdValue = mulDiv(executorLdoBefore, ldoUsdPrice, PRICE_UNIT)
        const stEthUsdValue = mulDiv(executorStEthBefore, stEthUsdPrice, PRICE_UNIT)
        expect(ldoUsdValue).to.be.lt(stEthUsdValue)

        // The deposit is twice the LDO bought for half the daily-cap allocation, so it lands just
        // under the cap itself at any stETH price: only the 1.1% margin and rounding trim it.
        // Above the 90%-of-cap floor a broken hop would show; under the per-call maximum the
        // balanced amounts deposit without down-scaling.
        const expectedStEthLeg = mulDiv(executorLdoBefore, ldoUsdPrice, stEthUsdPrice)
        const expectedDepositValueUsd = ldoUsdValue * 2n
        expect(expectedDepositValueUsd, 'deposit lost value on the way to the pool').to.be.gte(
          mulDiv(ALLOCATOR_PARAMS.dailyCapUSD, 90n, 100n)
        )
        expect(expectedDepositValueUsd).to.be.lte(EXECUTOR_PARAMS.maxDepositValueUsd)

        const [availableLdo, availableStEth] = await executor.getAvailableLiquidity()
        expect(availableLdo).to.equal(executorLdoBefore)
        expect(availableStEth).to.equal(expectedStEthLeg)

        const expectedWstEthLeg = await wstEth.getWstETHByStETH(expectedStEthLeg)
        const poolLdoBefore = await pool.balances(0)
        const poolWstEthBefore = await pool.balances(1)
        const totalSupplyBefore = await pool.totalSupply()
        const lpBalanceBefore = await executor.getLpTokenBalance()

        const receipt = (await (await executor.addLiquidity()).wait())!
        const [added] = await executor.queryFilter(
          executor.filters.LiquidityAdded(),
          receipt.blockNumber,
          receipt.blockNumber
        )
        expect(added.args.caller).to.equal(deployerAddress)
        expect(added.args.ldoAmount).to.equal(executorLdoBefore)
        expect(added.args.wstEthAmount).to.be.closeTo(expectedWstEthLeg, 2n)
        expect(added.args.lpTokensMinted).to.be.gt(0n)

        // The LP position lands on the executor and the pool supply grows by exactly the mint.
        expect(await executor.getLpTokenBalance()).to.equal(
          lpBalanceBefore + added.args.lpTokensMinted
        )
        expect(await pool.balanceOf(executorAddress)).to.equal(
          lpBalanceBefore + added.args.lpTokensMinted
        )
        expect(await pool.totalSupply()).to.equal(totalSupplyBefore + added.args.lpTokensMinted)

        // Pool reserves grow by exactly the deposited legs.
        expect(await pool.balances(0)).to.equal(poolLdoBefore + added.args.ldoAmount)
        expect(await pool.balances(1)).to.equal(poolWstEthBefore + added.args.wstEthAmount)

        // The executor spends the whole LDO leg plus the wrapped stETH leg, keeping the surplus
        // stETH for the next cycle.
        expect(await ldo.balanceOf(executorAddress)).to.equal(0n)
        expect(await stEth.balanceOf(executorAddress)).to.be.closeTo(
          executorStEthBefore - expectedStEthLeg,
          4n
        )

        // Keeper preview after the deposit: the LDO leg is exhausted, so liquidity previews go
        // idle until the next settlement delivers LDO.
        expect(await executor.canAddLiquidity()).to.equal(false)
        const [availableLdoAfter, availableStEthAfter] = await executor.getAvailableLiquidity()
        expect(availableLdoAfter).to.equal(0n)
        expect(availableStEthAfter).to.equal(0n)
      })
    })

    // --- Treasury mode: sell everything, LDO settles straight to the Aragon Agent ---

    context('Treasury mode lifecycle', function () {
      before(async function () {
        await snapshotStaged.restore()
      })

      it('should switch the executor to the treasury Stonks', async function () {
        await expect(executor.connect(adminSigner).setStonks(stonksTreasuryAddress))
          .to.emit(executor, 'StonksAndOperatingModeSet')
          .withArgs(stonksLpAddress, stonksTreasuryAddress, true, false)

        expect(await executor.stonks()).to.equal(stonksTreasuryAddress)
        expect(await executor.lpModeEnabled()).to.equal(false)
        expect(await executor.stonksOrderDurationSeconds()).to.equal(
          STONKS_PARAMS.orderDurationInSeconds
        )
      })

      it('should accumulate the treasury slice of a fee-minting rebase', async function () {
        await runRebaseStage(SHARES_MINTED_AS_FEES)
      })

      it('should convert the pending stETH bucket to cumulative USD revenue', async function () {
        await runConvertStage()
      })

      it('should allocate the daily cap and forward all free stETH to Stonks', async function () {
        await runAllocateStage('treasury')
        // Treasury mode retains nothing on the executor.
        expect(await stEth.balanceOf(executorAddress)).to.be.closeTo(0n, 4n)
      })

      it('should place a CoW order for the forwarded stETH, capped at the order maximum, with the Agent as receiver', async function () {
        await runPlaceOrderStage(stonksTreasury, contracts.AGENT)
      })

      it('should settle the order delivering the bought LDO to the Agent treasury', async function () {
        await runSettlementStage('treasury')
      })

      it('should reject pool deposits outside LP mode', async function () {
        expect(await executor.canAddLiquidity()).to.equal(false)
        await expect(executor.addLiquidity()).to.be.revertedWithCustomError(executor, 'NotInLpMode')
        expect(await executor.getLpTokenBalance()).to.equal(0n)
        expect(await pool.balanceOf(executorAddress)).to.equal(0n)
      })
    })

    // --- Under-reserve day: the report trails the daily reserve, so nothing is spendable ---

    // Generated only for the fresh staging: the deficit accounting asserts against the
    // launch-fresh zero baseline, which a live deployment's history does not provide.
    if (!isDeployed) {
      context('Under-reserve revenue day', function () {
        before(async function () {
          await snapshotStaged.restore()
        })

        it('should accumulate the treasury slice of a small fee-minting rebase', async function () {
          await runRebaseStage(UNDER_RESERVE_SHARES)
        })

        it('should convert the small pending bucket to cumulative USD revenue', async function () {
          await runConvertStage()
        })

        it('should report the whole keeper interface idle while revenue trails the reserve', async function () {
          // Revenue landed but stays under the reserve: nothing is spendable, nothing has been
          // forwarded for sale, and there is no LDO to pair — every keeper preview reads idle.
          const [status, spendableUSD, spendableStEth] = await allocator.spendable()
          expect(status).to.equal(ALLOCATION_STATUS.NoAvailableBudget)
          expect(spendableUSD).to.equal(0n)
          expect(spendableStEth).to.equal(0n)

          const placement = await executor.getPlacementStatus()
          expect(placement.canPlace).to.equal(false)
          expect(placement.sellAmount).to.equal(0n)
          expect(placement.estimatedBuyAmount).to.equal(0n)
          expect(placement.activeOrder).to.equal(ethers.ZeroAddress)
          expect(placement.isStonksCreationPaused).to.equal(false)
          expect(placement.isStonksKilled).to.equal(false)

          expect(await executor.canAddLiquidity()).to.equal(false)
          const [availableLdo, availableStEth] = await executor.getAvailableLiquidity()
          expect(availableLdo).to.equal(0n)
          expect(availableStEth).to.equal(0n)
        })

        it('should checkpoint a budget deficit and skip the allocation without moving stETH', async function () {
          const budgetBefore = await allocator.budgetUSD()
          const baselineRevenue = await allocator.lastTotalRevenueUSD()
          const reserveAnchor = await allocator.reserveAnchorTS()
          const reserveRate = await allocator.reserveDailyRateUSD()
          const surplusShareBP = await allocator.surplusShareBP()
          const dailyBefore = await allocator.daily()
          const yearlyBefore = await allocator.yearly()
          const totalRevenueUSD = await totalRevenueAcrossSources()

          const allocatorStEthBefore = await stEth.balanceOf(allocatorAddress)
          const executorStEthBefore = await stEth.balanceOf(executorAddress)

          const receipt = (await (await allocator.allocate()).wait())!
          const blockTimestamp = BigInt(
            (await ethers.provider.getBlock(receipt.blockNumber))!.timestamp
          )

          // The small report stays under the accrued reserve, so the checkpoint banks a deficit.
          const reserveUSD = reserveAccruedUSD(reserveRate, reserveAnchor, blockTimestamp)
          const budgetDeltaUSD =
            ((totalRevenueUSD - baselineRevenue - reserveUSD) * surplusShareBP) / MAX_BASIS_POINTS
          expect(budgetDeltaUSD).to.be.lt(0n)

          const [checkpoint] = await allocator.queryFilter(
            allocator.filters.Checkpoint(),
            receipt.blockNumber,
            receipt.blockNumber
          )
          expect(checkpoint.args.lastTotalRevenueUSD).to.equal(totalRevenueUSD)
          expect(checkpoint.args.reserveUSD).to.equal(reserveUSD)
          expect(checkpoint.args.budgetDeltaUSD).to.equal(budgetDeltaUSD)
          expect(checkpoint.args.budgetUSD).to.equal(budgetBefore + budgetDeltaUSD)

          const [skipped] = await allocator.queryFilter(
            allocator.filters.AllocationSkipped(),
            receipt.blockNumber,
            receipt.blockNumber
          )
          expect(skipped.args.caller).to.equal(deployerAddress)
          expect(skipped.args.reason).to.equal(ALLOCATION_STATUS.NoAvailableBudget)

          // No release and no executor hook: the skip advances accounting only.
          const allocated = await allocator.queryFilter(
            allocator.filters.Allocated(),
            receipt.blockNumber,
            receipt.blockNumber
          )
          expect(allocated.length).to.equal(0)
          const processed = await executor.queryFilter(
            executor.filters.AllocationProcessed(),
            receipt.blockNumber,
            receipt.blockNumber
          )
          expect(processed.length).to.equal(0)

          expect(await allocator.budgetUSD()).to.equal(budgetBefore + budgetDeltaUSD)
          expect(await allocator.lastTotalRevenueUSD()).to.equal(totalRevenueUSD)
          // The skip still checkpoints, so the reserve cursor moves to the next day's start.
          expect(await allocator.reserveAnchorTS()).to.equal(
            (blockTimestamp / ONE_DAY + 1n) * ONE_DAY
          )
          expect(await stEth.balanceOf(allocatorAddress)).to.equal(allocatorStEthBefore)
          expect(await stEth.balanceOf(executorAddress)).to.equal(executorStEthBefore)
          // A skipped allocation consumes no spend window.
          expect((await allocator.daily()).spentUSD).to.equal(dailyBefore.spentUSD)
          expect((await allocator.yearly()).spentUSD).to.equal(yearlyBefore.spentUSD)
        })

        it('should repay the deficit from later surplus before spending again', async function () {
          const deficitBudget = await allocator.budgetUSD()
          expect(deficitBudget).to.be.lt(0n)

          // A saturating rebase lands next. The allocate stage's mirror starts from the negative
          // budget, so it verifies the deficit nets against the new surplus before any spend, and
          // that the skip's future-anchored reserve cursor charges no reserve today.
          await runRebaseStage(SHARES_MINTED_AS_FEES)
          await runConvertStage()
          await runAllocateStage('lp')
        })
      })
    }
  })
})
