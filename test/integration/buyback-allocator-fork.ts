import { ethers, network } from 'hardhat'
import { expect } from 'chai'
import { parseEther, TransactionReceipt, Signer, ZeroAddress } from 'ethers'
import { takeSnapshot, SnapshotRestorer, time } from '@nomicfoundation/hardhat-network-helpers'

import {
  BuybackAllocator,
  BuybackExecutor,
  IERC20,
  OracleRouter,
  StakingRevenueSource,
  StakingRevenueSource__factory,
} from '../../typechain-types'
import { getContracts } from '../../utils/contracts'
import { MAX_BASIS_POINTS } from '../../utils/gpv2-helpers'
import { QuoteDenomination } from '../../utils/oracle-router'
import {
  ALLOCATION_STATUS,
  ALLOCATOR_ROLE,
  DEFAULT_ADMIN_ROLE,
  EMERGENCY_ROLE,
  MANAGER_ROLE,
  PAUSED_REVERT,
  PRICE_UNIT,
  impersonateWithBalance,
  isForkNetwork,
  missingRoleMessage,
  mulDiv,
  saturatedSub,
} from '../helpers/buyback-executor'
import {
  ALLOCATOR_PARAMS,
  LIDO_LOCATOR_ADDRESS,
  ONE_DAY,
  ONE_YEAR,
  ORACLE_ROUTER_ADDRESS,
  configureRealOracleRouter,
  driveRebase,
  fundStEth,
  reserveAccruedUSD,
  rolledWindowEndTS,
  tryRegisterObserver,
} from '../helpers/buyback-scenario'

// Fork tests for the deployed BuybackAllocator, bound to the live onchain NEST contracts. The
// full lifecycle mirror (allocate -> executor hook -> Stonks/CoW/Curve legs) is owned by
// buyback-scenario.ts in deployed mode; this suite isolates the allocator-scoped surfaces that
// framing does not: the deployed OracleRouter's failure and recovery shapes, the price-floor
// boundary against a live quote, balance-clamp behavior on real rebasing stETH, deficit
// accounting over a history-carrying baseline, multi-source baseline arithmetic with real
// StakingRevenueSource instances, calendar-time reserve accrual, executor-guard revert
// propagation, and asset recovery to the real Agent.
//
// Prerequisites: a mainnet fork node (`npm run node`), run via `npm run test:integration`. The
// rebase path is detected from the fork exactly as in buyback-scenario.ts: the NEST
// TokenRateNotifier fan-out when available, otherwise a direct authorized `pushTokenRate`.

// Fill these from the live deployment before running. An empty allocator address skips the whole
// suite; the other fields are guarded so a half-filled template fails loudly.
const BUYBACK_ALLOCATOR_ADDRESS: string = '0xAA568141c051f2D1132b110f8391F18D48E8D889'
const BUYBACK_EXECUTOR_ADDRESS: string = '0x6c213ca5A10Cc26548C742229569B4AeD2A9C9B7'
const STAKING_REVENUE_SOURCE_ADDRESS: string = '0x6220212a33a87Ed7Cc386B67eB2c393974F28C38'

// Required only while the fork predates the vote wiring Stonks into the executor: without a
// staged `setStonks`, the release hook forwards stETH to the zero address and every eligible
// allocation reverts with stETH's TRANSFER_TO_ZERO_ADDR.
const STONKS_ADDRESS: string = '0xb368586CB980895E51e1D82102E63b3F69d3F151'

// Fee shares whose treasury slice saturates the $50k daily cap past any plausible stETH price.
const SATURATING_SHARES = parseEther('1000000')

// Fee shares whose ~50% treasury slice stays below one day's $109,589 reserve even at the top
// of the plausible price band, so the checkpoint banks a budget deficit.
const UNDER_RESERVE_SHARES = parseEther('1')

// Small pre-activation report left unconverted by staging, consumed by the baseline test.
const ACTIVATION_SEED_SHARES = parseEther('100')

// Distinct per-source amounts for the multi-source summation, so equal addends cannot mask a
// double-count or a single-source read.
const FIRST_SOURCE_TOPUP_SHARES = parseEther('30000')
const SECOND_SOURCE_SEED_SHARES = parseEther('50000')
const SECOND_SOURCE_TOPUP_SHARES = parseEther('60000')

// Mis-scaling tripwire for the live 1e18-scaled stETH/USD quote (a 1e8-scaled Chainlink answer
// is off by ten orders of magnitude).
const MIN_PLAUSIBLE_STETH_USD = parseEther('100')
const MAX_PLAUSIBLE_STETH_USD = parseEther('100000')

// Balance stagings: between the $1k minimum spend and the $50k daily cap, so the stETH balance
// is the binding constraint where a test needs the clamp.
const SMALL_BALANCE_USD = parseEther('25000')
const RETAINED_BALANCE_USD = parseEther('20000')

// Surplus-share lever value for the checkpoint-first governance test.
const REDUCED_SURPLUS_SHARE_BP = 2500n

// Slack added to the daily-headroom regime pins: the USD->stETH->USD double floor and stETH
// share rounding shave wei-level USD off an amount sitting exactly on the pin.
const HEADROOM_MARGIN_USD = parseEther('1')

const contracts = getContracts()

const minBigInt = (...values: bigint[]): bigint => values.reduce((a, b) => (a < b ? a : b))

interface SpendWindowState {
  endTS: bigint
  spentUSD: bigint
}

interface CheckpointPreState {
  budgetUSD: bigint
  baselineRevenueUSD: bigint
  reserveAnchorTS: bigint
  reserveDailyRateUSD: bigint
  surplusShareBP: bigint
  totalRevenueUSD: bigint
}

interface AllocatePreState extends CheckpointPreState {
  dailyCapUSD: bigint
  yearlyCapUSD: bigint
  minSpendPerCallUSD: bigint
  minStEthPriceUSD: bigint
  daily: SpendWindowState
  yearly: SpendWindowState
  activationTS: bigint
  allocatorStEth: bigint
}

interface AllocateOutcome {
  receipt: TransactionReceipt
  blockTimestamp: bigint
  status: bigint
  spendUSD: bigint
  spendStEth: bigint
  reserveUSD: bigint
  budgetDeltaUSD: bigint
  budgetCheckpointed: bigint
  dailyUnspent: bigint
  yearlyUnspent: bigint
}

describe('BuybackAllocator — deployed contracts (mainnet fork)', function () {
  this.timeout(180000)

  let snapshot: SnapshotRestorer
  let snapshotStaged: SnapshotRestorer

  let deployer: Signer
  let deployerAddress: string
  let adminSigner: Signer // Aragon Voting, the production admin of every NEST contract

  let allocator: BuybackAllocator
  let executor: BuybackExecutor
  let revenueSource: StakingRevenueSource
  let stEth: IERC20
  let oracleRouter: OracleRouter

  let allocatorAddress: string
  let executorAddress: string
  let revenueSourceAddress: string

  // Live stETH/USD quote, read once after the router is configured. Chainlink answers are frozen
  // on the fork, so every later expectation derives from this deterministically.
  let stEthUsdPrice: bigint

  // Detected in `before`: true when the fork carries the NEST TokenRateNotifier.
  let viaNotifier: boolean

  // Activation staging record, consumed by the Group 1 tests. Set only when the fork state left
  // the allocator unactivated and staging performed the activation itself.
  let wasActivatedByStaging = false
  let activationReceipt: TransactionReceipt | undefined
  let pendingAtActivation = 0n
  let cumulativeAtActivation = 0n

  before(async function () {
    if (!isForkNetwork()) {
      return this.skip()
    }
    if (BUYBACK_ALLOCATOR_ADDRESS === '') {
      return this.skip()
    }
    expect(BUYBACK_EXECUTOR_ADDRESS, 'half-filled address template').to.not.equal('')
    expect(STAKING_REVENUE_SOURCE_ADDRESS, 'half-filled address template').to.not.equal('')

    snapshot = await takeSnapshot()

    // A fork can land on a base fee the node's own fee estimation undershoots, bouncing every
    // staging transaction. Pin it low once; the staged snapshot then carries it to every test.
    await network.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x1'])
    ;[deployer] = await ethers.getSigners()
    deployerAddress = await deployer.getAddress()

    allocatorAddress = ethers.getAddress(BUYBACK_ALLOCATOR_ADDRESS)
    executorAddress = ethers.getAddress(BUYBACK_EXECUTOR_ADDRESS)
    revenueSourceAddress = ethers.getAddress(STAKING_REVENUE_SOURCE_ADDRESS)

    allocator = await ethers.getContractAt('BuybackAllocator', allocatorAddress)
    executor = await ethers.getContractAt('BuybackExecutor', executorAddress)
    revenueSource = await ethers.getContractAt('StakingRevenueSource', revenueSourceAddress)
    stEth = await ethers.getContractAt('IERC20', contracts.STETH)

    // Fail-fast wiring gates, asserted once here rather than as tests: the acceptance suite owns
    // the deployed-state snapshot; a drifted field fails staging by name instead of corrupting
    // every downstream expectation.
    expect(await allocator.STETH()).to.hexEqual(contracts.STETH)
    expect(await allocator.ORACLE_ROUTER()).to.hexEqual(ORACLE_ROUTER_ADDRESS)
    expect(await allocator.executor()).to.hexEqual(executorAddress)
    expect(await allocator.TREASURY()).to.hexEqual(contracts.AGENT)
    expect(await allocator.hasRole(DEFAULT_ADMIN_ROLE, contracts.ADMIN)).to.equal(true)
    expect(await allocator.revenueSources()).to.deep.equal([revenueSourceAddress])
    expect(await allocator.dailyCapUSD()).to.equal(ALLOCATOR_PARAMS.dailyCapUSD)
    expect(await allocator.yearlyCapUSD()).to.equal(ALLOCATOR_PARAMS.yearlyCapUSD)
    expect(await allocator.reserveDailyRateUSD()).to.equal(ALLOCATOR_PARAMS.reserveDailyRateUSD)
    expect(await allocator.minStEthPriceUSD()).to.equal(ALLOCATOR_PARAMS.minStEthPriceUSD)
    expect(await allocator.minSpendPerCallUSD()).to.equal(ALLOCATOR_PARAMS.minSpendPerCallUSD)
    expect(await allocator.surplusShareBP()).to.equal(ALLOCATOR_PARAMS.surplusShareBP)

    // Re-applied deliberately even over a governance-configured router: fork blocks age past any
    // production staleness window, and the setters overwrite.
    oracleRouter = await configureRealOracleRouter({
      stEth: contracts.STETH,
      ldo: contracts.LDO,
    })
    expect(await oracleRouter.PRICE_UNIT()).to.equal(PRICE_UNIT)
    ;[stEthUsdPrice] = await oracleRouter.getUsdPrices(contracts.STETH, contracts.STETH)
    expect(stEthUsdPrice, 'stETH/USD price out of the plausible 1e18-scaled range').to.be.gte(
      MIN_PLAUSIBLE_STETH_USD
    )
    expect(stEthUsdPrice, 'stETH/USD price out of the plausible 1e18-scaled range').to.be.lte(
      MAX_PLAUSIBLE_STETH_USD
    )

    adminSigner = await impersonateWithBalance(contracts.ADMIN)

    // Rebase-path detection, as in buyback-scenario.ts: notifier fan-out when the fork carries
    // the NEST TokenRateNotifier, direct authorized push otherwise.
    const locator = await ethers.getContractAt('ILidoLocator', LIDO_LOCATOR_ADDRESS)
    const notifier = await ethers.getContractAt(
      'ITokenRateNotifier',
      await locator.postTokenRebaseReceiver()
    )
    viaNotifier = await tryRegisterObserver(notifier, revenueSourceAddress)
    if (!viaNotifier) {
      console.warn(
        '      ⚠ Legacy TokenRateNotifier on the fork (no NEST mock-upgrade applied): ' +
          'driving rebases via direct pushTokenRate instead of the notifier fan-out.'
      )
    }

    // Guarded governance wiring: steps governance already executed onchain are no-ops.
    if (!(await executor.hasRole(ALLOCATOR_ROLE, allocatorAddress))) {
      await executor.connect(adminSigner).grantRole(ALLOCATOR_ROLE, allocatorAddress)
    }
    if (!(await allocator.hasRole(MANAGER_ROLE, deployerAddress))) {
      await allocator.connect(adminSigner).grantRole(MANAGER_ROLE, deployerAddress)
    }
    if ((await executor.stonks()) === ZeroAddress) {
      expect(
        STONKS_ADDRESS,
        'executor.stonks() is unset on this fork — fill STONKS_ADDRESS'
      ).to.not.equal('')
      await executor.connect(adminSigner).setStonks(ethers.getAddress(STONKS_ADDRESS))
    }
    if ((await allocator.activationTS()) === 0n) {
      // Land a report without converting it, so the activation-baseline test can prove the
      // pending slice was excluded and later surfaces as fresh surplus.
      await driveRebase(revenueSource, ACTIVATION_SEED_SHARES, { viaNotifier })
      pendingAtActivation = await revenueSource.pendingRevenueStEth()
      cumulativeAtActivation = await revenueSource.getCumulativeRevenueUSD()
      activationReceipt = (await (await allocator.connect(adminSigner).activate()).wait())!
      wasActivatedByStaging = true
    }

    // Fund the allocator with twice the daily cap in stETH so the cap, not the balance, binds
    // by default; the clamp tests re-stage a small balance themselves.
    await fundStEth(deployer, allocatorAddress, 2n * stEthOfUsd(ALLOCATOR_PARAMS.dailyCapUSD))

    snapshotStaged = await takeSnapshot()
  })

  after(async function () {
    if (snapshot) {
      await snapshot.restore()
    }
  })

  // --- Shared helpers ---

  function stEthOfUsd(usdAmount: bigint): bigint {
    return mulDiv(usdAmount, PRICE_UNIT, stEthUsdPrice)
  }

  function usdOfStEth(stEthAmount: bigint): bigint {
    return mulDiv(stEthAmount, stEthUsdPrice, PRICE_UNIT)
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

  // Lands one rebase into the registered source and settles it into cumulative USD. The non-zero
  // delta gate matters: `pushTokenRate` exits silently on a zero fee split, and a zero delta
  // would make every downstream summation equality pass vacuously.
  async function earnBudget(shares: bigint = SATURATING_SHARES): Promise<void> {
    const cumulativeBefore = await revenueSource.getCumulativeRevenueUSD()
    await driveRebase(revenueSource, shares, { viaNotifier })
    await revenueSource.convertPendingRevenueToUSD()
    expect(
      await revenueSource.getCumulativeRevenueUSD(),
      'rebase produced no revenue — zero staking fee split at this fork block?'
    ).to.be.gt(cumulativeBefore)
  }

  // Regime pin for tests that hardcode an Eligible outcome: the deployed daily window must
  // still have this much headroom at the fork block.
  async function expectDailyHeadroom(minimumUSD: bigint): Promise<void> {
    const daily = await allocator.daily()
    const nowTS = BigInt(await time.latest())
    const unspent = saturatedSub(
      await allocator.dailyCapUSD(),
      nowTS >= daily.endTS ? 0n : daily.spentUSD
    )
    expect(unspent, 'daily window headroom regime broke at this fork block').to.be.gte(minimumUSD)
  }

  // Regime pin for time-warping tests: the warp must stay inside the staged staleness budget or
  // every allocate collapses to QuoteUnavailable and the mirror mismatches confusingly.
  async function expectQuoteFresh(): Promise<void> {
    const [price] = await oracleRouter.getUsdPrices(contracts.STETH, contracts.STETH)
    expect(price, 'stETH/USD quote went stale — fork block too old for the warp').to.equal(
      stEthUsdPrice
    )
  }

  async function captureCheckpointPreState(): Promise<CheckpointPreState> {
    return {
      budgetUSD: await allocator.budgetUSD(),
      baselineRevenueUSD: await allocator.lastTotalRevenueUSD(),
      reserveAnchorTS: await allocator.reserveAnchorTS(),
      reserveDailyRateUSD: await allocator.reserveDailyRateUSD(),
      surplusShareBP: await allocator.surplusShareBP(),
      totalRevenueUSD: await totalRevenueAcrossSources(),
    }
  }

  async function captureAllocatePreState(): Promise<AllocatePreState> {
    const daily = await allocator.daily()
    const yearly = await allocator.yearly()
    return {
      ...(await captureCheckpointPreState()),
      dailyCapUSD: await allocator.dailyCapUSD(),
      yearlyCapUSD: await allocator.yearlyCapUSD(),
      minSpendPerCallUSD: await allocator.minSpendPerCallUSD(),
      minStEthPriceUSD: await allocator.minStEthPriceUSD(),
      daily: { endTS: daily.endTS, spentUSD: daily.spentUSD },
      yearly: { endTS: yearly.endTS, spentUSD: yearly.spentUSD },
      activationTS: await allocator.activationTS(),
      allocatorStEth: await stEth.balanceOf(allocatorAddress),
    }
  }

  // Exact off-chain mirror of `_budgetable`: signed surplus times the share, floor toward zero
  // on both sides of the sign, matching Solidity int256 division.
  function mirrorCheckpoint(pre: CheckpointPreState, blockTimestamp: bigint) {
    const reserveUSD = reserveAccruedUSD(
      pre.reserveDailyRateUSD,
      pre.reserveAnchorTS,
      blockTimestamp
    )
    const budgetDeltaUSD =
      ((pre.totalRevenueUSD - pre.baselineRevenueUSD - reserveUSD) * pre.surplusShareBP) /
      MAX_BASIS_POINTS
    return { reserveUSD, budgetDeltaUSD, budgetCheckpointed: pre.budgetUSD + budgetDeltaUSD }
  }

  /**
   * Drives `allocate()` and asserts the full `_checkpoint` + `_spendable` sequence against an
   * exact off-chain mirror: the Checkpoint event, the derived status, the release or skip
   * events, the executor hook, both spend windows, the reserve cursor, and the stETH movement.
   * `quoteAvailable: false` mirrors the QuoteUnavailable branch the allocator's bare catch
   * produces while the router reverts.
   */
  async function expectAllocateMirror(
    pre: AllocatePreState,
    options: { quoteAvailable?: boolean } = {}
  ): Promise<AllocateOutcome> {
    const quoteAvailable = options.quoteAvailable ?? true

    const receipt = (await (await allocator.allocate()).wait())!
    const blockNumber = receipt.blockNumber
    const blockTimestamp = BigInt((await ethers.provider.getBlock(blockNumber))!.timestamp)

    // Checkpoint banks the surplus share of new revenue net of the accrued reserve, on both the
    // release and the skip path.
    const { reserveUSD, budgetDeltaUSD, budgetCheckpointed } = mirrorCheckpoint(pre, blockTimestamp)
    const [checkpoint] = await allocator.queryFilter(
      allocator.filters.Checkpoint(),
      blockNumber,
      blockNumber
    )
    expect(checkpoint.args.lastTotalRevenueUSD).to.equal(pre.totalRevenueUSD)
    expect(checkpoint.args.reserveUSD).to.equal(reserveUSD)
    expect(checkpoint.args.budgetDeltaUSD).to.equal(budgetDeltaUSD)
    expect(checkpoint.args.budgetUSD).to.equal(budgetCheckpointed)

    // The `_spendable` decision sequence: budget clamp, quote, price floor, year cap, day cap,
    // balance clamp with USD restatement from the floored stETH amount, minimum spend.
    const availableUSD = budgetCheckpointed > 0n ? budgetCheckpointed : 0n
    const yearlyUnspent = saturatedSub(
      pre.yearlyCapUSD,
      blockTimestamp >= pre.yearly.endTS ? 0n : pre.yearly.spentUSD
    )
    const dailyUnspent = saturatedSub(
      pre.dailyCapUSD,
      blockTimestamp >= pre.daily.endTS ? 0n : pre.daily.spentUSD
    )

    let status: bigint
    let spendUSD = 0n
    let spendStEth = 0n
    if (availableUSD === 0n) {
      status = ALLOCATION_STATUS.NoAvailableBudget
    } else if (!quoteAvailable) {
      status = ALLOCATION_STATUS.QuoteUnavailable
    } else if (stEthUsdPrice < pre.minStEthPriceUSD) {
      status = ALLOCATION_STATUS.StEthPriceBelowMin
    } else {
      const cappedUSD = minBigInt(availableUSD, yearlyUnspent, dailyUnspent)
      if (cappedUSD === 0n) {
        status = ALLOCATION_STATUS.WindowCapReached
      } else {
        spendStEth = minBigInt(stEthOfUsd(cappedUSD), pre.allocatorStEth)
        spendUSD = usdOfStEth(spendStEth)
        if (spendUSD < pre.minSpendPerCallUSD) {
          status = ALLOCATION_STATUS.AllocationBelowMin
          spendUSD = 0n
          spendStEth = 0n
        } else {
          status = ALLOCATION_STATUS.Eligible
        }
      }
    }

    const allocated = await allocator.queryFilter(
      allocator.filters.Allocated(),
      blockNumber,
      blockNumber
    )
    const skipped = await allocator.queryFilter(
      allocator.filters.AllocationSkipped(),
      blockNumber,
      blockNumber
    )
    const processed = await executor.queryFilter(
      executor.filters.AllocationProcessed(),
      blockNumber,
      blockNumber
    )
    const rolled = await allocator.queryFilter(
      allocator.filters.WindowRolled(),
      blockNumber,
      blockNumber
    )
    const dailyAfter = await allocator.daily()
    const yearlyAfter = await allocator.yearly()

    if (status === ALLOCATION_STATUS.Eligible) {
      expect(allocated.length).to.equal(1)
      expect(allocated[0].args.triggeredBy).to.equal(deployerAddress)
      expect(allocated[0].args.executor).to.equal(executorAddress)
      expect(allocated[0].args.spendUSD).to.equal(spendUSD)
      expect(allocated[0].args.spendStEth).to.equal(spendStEth)
      expect(skipped.length).to.equal(0)
      // The hook fired. Which branch it takes (forward vs. retain) depends on the live price
      // regime and the executor's own state — that is the executor suites' property; the
      // allocator's release is unconditional.
      expect(processed.length).to.equal(1)

      // stETH conservation per release, pinned on the transfer itself so post-hook forwarding
      // inside the same tx cannot blur the executor-side receipt.
      const transfers = await stEth.queryFilter(
        stEth.filters.Transfer(allocatorAddress, executorAddress),
        blockNumber,
        blockNumber
      )
      expect(transfers.length).to.equal(1)
      expect(transfers[0].args.value).to.equal(spendStEth)
      expect(await stEth.balanceOf(allocatorAddress)).to.be.closeTo(
        pre.allocatorStEth - spendStEth,
        2n
      )

      // Windows carry the spend, rolled to the activation-aligned boundary where expired.
      expect(dailyAfter.endTS).to.equal(
        rolledWindowEndTS(pre.activationTS, ONE_DAY, pre.daily.endTS, blockTimestamp)
      )
      expect(dailyAfter.spentUSD).to.equal(
        (blockTimestamp >= pre.daily.endTS ? 0n : pre.daily.spentUSD) + spendUSD
      )
      expect(yearlyAfter.endTS).to.equal(
        rolledWindowEndTS(pre.activationTS, ONE_YEAR, pre.yearly.endTS, blockTimestamp)
      )
      expect(yearlyAfter.spentUSD).to.equal(
        (blockTimestamp >= pre.yearly.endTS ? 0n : pre.yearly.spentUSD) + spendUSD
      )
      const dailyRolls = rolled.filter((e) => e.args.windowDurationSeconds === ONE_DAY)
      const yearlyRolls = rolled.filter((e) => e.args.windowDurationSeconds === ONE_YEAR)
      expect(dailyRolls.length).to.equal(blockTimestamp >= pre.daily.endTS ? 1 : 0)
      if (dailyRolls.length === 1) {
        expect(dailyRolls[0].args.newEndTS).to.equal(dailyAfter.endTS)
        expect(dailyRolls[0].args.previousSpentUSD).to.equal(pre.daily.spentUSD)
      }
      expect(yearlyRolls.length).to.equal(blockTimestamp >= pre.yearly.endTS ? 1 : 0)
      if (yearlyRolls.length === 1) {
        expect(yearlyRolls[0].args.newEndTS).to.equal(yearlyAfter.endTS)
        expect(yearlyRolls[0].args.previousSpentUSD).to.equal(pre.yearly.spentUSD)
      }
    } else {
      // A skip advances accounting only: no release, no hook, no window movement.
      expect(skipped.length).to.equal(1)
      expect(skipped[0].args.caller).to.equal(deployerAddress)
      expect(skipped[0].args.reason).to.equal(status)
      expect(allocated.length).to.equal(0)
      expect(processed.length).to.equal(0)
      expect(rolled.length).to.equal(0)
      expect(await stEth.balanceOf(allocatorAddress)).to.equal(pre.allocatorStEth)
      expect(dailyAfter.endTS).to.equal(pre.daily.endTS)
      expect(dailyAfter.spentUSD).to.equal(pre.daily.spentUSD)
      expect(yearlyAfter.endTS).to.equal(pre.yearly.endTS)
      expect(yearlyAfter.spentUSD).to.equal(pre.yearly.spentUSD)
    }

    // Accounting common to both paths: the budget nets out the spend, the revenue baseline
    // advances, and the reserve cursor moves to the next day's start.
    expect(await allocator.budgetUSD()).to.equal(budgetCheckpointed - spendUSD)
    expect(await allocator.lastTotalRevenueUSD()).to.equal(pre.totalRevenueUSD)
    expect(await allocator.reserveAnchorTS()).to.equal((blockTimestamp / ONE_DAY + 1n) * ONE_DAY)

    return {
      receipt,
      blockTimestamp,
      status,
      spendUSD,
      spendStEth,
      reserveUSD,
      budgetDeltaUSD,
      budgetCheckpointed,
      dailyUnspent,
      yearlyUnspent,
    }
  }

  // --- Group 1: activate() on the deployed contract ---

  context('activate()', function () {
    before(async function () {
      await snapshotStaged.restore()
    })

    it('should be activated with a midnight-aligned timestamp and activation-aligned windows', async function () {
      const activationTS = await allocator.activationTS()
      expect(activationTS).to.be.gt(0n)
      expect(activationTS % ONE_DAY).to.equal(0n)

      const daily = await allocator.daily()
      const yearly = await allocator.yearly()
      expect(daily.endTS).to.be.gt(activationTS)
      expect((daily.endTS - activationTS) % ONE_DAY).to.equal(0n)
      expect(yearly.endTS).to.be.gt(activationTS)
      expect((yearly.endTS - activationTS) % ONE_YEAR).to.equal(0n)
    })

    it('should have emitted the activation baseline, reserve anchor, and both window rolls', async function () {
      // Testable only when staging performed the activation: a historical activation's receipt
      // is not reachable from the fork.
      if (!wasActivatedByStaging) return this.skip()

      const blockNumber = activationReceipt!.blockNumber
      const blockTimestamp = BigInt((await ethers.provider.getBlock(blockNumber))!.timestamp)
      const alignedTS = (blockTimestamp / ONE_DAY) * ONE_DAY

      const [activated] = await allocator.queryFilter(
        allocator.filters.Activated(),
        blockNumber,
        blockNumber
      )
      expect(activated.args.activationTS).to.equal(alignedTS)
      expect(activated.args.lastTotalRevenueUSD).to.equal(cumulativeAtActivation)

      // The activation day's reserve is charged, not forgiven: the anchor lands on the
      // activation day itself, unlike the post-checkpoint re-anchor to the next day.
      const [anchored] = await allocator.queryFilter(
        allocator.filters.ReserveAnchored(),
        blockNumber,
        blockNumber
      )
      expect(anchored.args.anchorTS).to.equal(alignedTS)

      const rolled = await allocator.queryFilter(
        allocator.filters.WindowRolled(),
        blockNumber,
        blockNumber
      )
      expect(rolled.length).to.equal(2)
      expect(rolled[0].args.windowDurationSeconds).to.equal(ONE_DAY)
      expect(rolled[0].args.newEndTS).to.equal(alignedTS + ONE_DAY)
      expect(rolled[0].args.previousSpentUSD).to.equal(0n)
      expect(rolled[1].args.windowDurationSeconds).to.equal(ONE_YEAR)
      expect(rolled[1].args.newEndTS).to.equal(alignedTS + ONE_YEAR)
      expect(rolled[1].args.previousSpentUSD).to.equal(0n)
    })

    it('should exclude unconverted pending revenue from the activation baseline and bank it as later surplus', async function () {
      // The property is untestable once activation is history; staging drove a rebase without
      // converting it before activating exactly for this test.
      if (!wasActivatedByStaging) return this.skip()

      expect(pendingAtActivation).to.be.gt(0n)
      expect(await revenueSource.pendingRevenueStEth()).to.equal(pendingAtActivation)
      expect(await allocator.lastTotalRevenueUSD()).to.equal(cumulativeAtActivation)

      // Settle the pre-activation slice now. It was excluded from the baseline, so it surfaces
      // as fresh surplus — the NatSpec-documented behavior behind the deploy runbook's
      // settle-before-activate ordering.
      const cumulativeBefore = await revenueSource.getCumulativeRevenueUSD()
      await revenueSource.convertPendingRevenueToUSD()
      const convertedUSD = (await revenueSource.getCumulativeRevenueUSD()) - cumulativeBefore
      expect(convertedUSD).to.be.gt(0n)

      const pre = await captureAllocatePreState()
      expect(pre.totalRevenueUSD - pre.baselineRevenueUSD).to.equal(convertedUSD)

      const out = await expectAllocateMirror(pre)
      expect(out.budgetDeltaUSD).to.equal(
        ((convertedUSD - out.reserveUSD) * pre.surplusShareBP) / MAX_BASIS_POINTS
      )
    })

    it('should revert re-activation', async function () {
      await expect(allocator.connect(adminSigner).activate()).to.be.revertedWithCustomError(
        allocator,
        'AlreadyActivated'
      )
    })
  })

  // --- Group 2: price quote through the deployed OracleRouter ---

  context('price quote through the deployed OracleRouter', function () {
    before(async function () {
      await snapshotStaged.restore()
    })

    it('should quote a sane non-zero stETH/USD price', async function () {
      const [basePrice, quotePrice] = await oracleRouter.getUsdPrices(
        contracts.STETH,
        contracts.STETH
      )
      expect(basePrice).to.equal(quotePrice)
      expect(basePrice).to.be.gte(MIN_PLAUSIBLE_STETH_USD)
      expect(basePrice).to.be.lte(MAX_PLAUSIBLE_STETH_USD)
    })

    it('should skip with QuoteUnavailable while the feed is unusable and retain the budget', async function () {
      // Budget first: NoAvailableBudget short-circuits ahead of the quote check.
      await earnBudget()

      // One second of allowed staleness makes the frozen fork-block answer stale immediately,
      // with no time warp, so windows and the reserve cursor stay put. One failure shape
      // suffices: the allocator's bare catch collapses stale and deactivated feeds into the
      // same observable status.
      const routerAdmin = await impersonateWithBalance(await oracleRouter.ADMIN())
      await oracleRouter
        .connect(routerAdmin)
        .setTokenFeed(contracts.STETH, QuoteDenomination.USD, 1, true)
      await expect(
        oracleRouter.getUsdPrices(contracts.STETH, contracts.STETH),
        'router still answers with 1-second staleness — fork block too fresh?'
      ).to.be.reverted

      const preOutage = await captureAllocatePreState()
      const outage = await expectAllocateMirror(preOutage, { quoteAvailable: false })
      // The mirror already verified the Checkpoint, the skip event, untouched balances and
      // windows, and that the budget moved only by the checkpoint delta. Pin the branch: the
      // staged budget must be what kept NoAvailableBudget from shadowing the quote check.
      expect(outage.status).to.equal(ALLOCATION_STATUS.QuoteUnavailable)
      expect(outage.budgetCheckpointed).to.be.gt(0n)

      // Restore the feed set (the setters overwrite; the original staleness is not readable
      // back) and release from the retained budget: a Chainlink outage is a pause, not a loss.
      await configureRealOracleRouter({ stEth: contracts.STETH, ldo: contracts.LDO })
      await expectDailyHeadroom(ALLOCATOR_PARAMS.minSpendPerCallUSD + HEADROOM_MARGIN_USD)

      const preRestored = await captureAllocatePreState()
      expect(preRestored.budgetUSD).to.equal(outage.budgetCheckpointed)
      const restored = await expectAllocateMirror(preRestored)
      expect(restored.status).to.equal(ALLOCATION_STATUS.Eligible)
      expect(restored.spendUSD).to.be.gt(0n)
    })
  })

  context('price floor at the live-quote boundary', function () {
    before(async function () {
      await snapshotStaged.restore()
    })

    it('should enforce the price floor exactly at the live-quote boundary', async function () {
      await earnBudget()
      await expectDailyHeadroom(ALLOCATOR_PARAMS.minSpendPerCallUSD + HEADROOM_MARGIN_USD)

      const [quote] = await oracleRouter.getUsdPrices(contracts.STETH, contracts.STETH)

      // One above the live quote skips. The read-back guards a silent uint128 truncation of a
      // governance-set floor.
      await allocator.connect(adminSigner).setMinStEthPriceUSD(quote + 1n)
      expect(await allocator.minStEthPriceUSD()).to.equal(quote + 1n)

      const [statusBelow, spendableBelowUSD, spendableBelowStEth] = await allocator.spendable()
      expect(statusBelow).to.equal(ALLOCATION_STATUS.StEthPriceBelowMin)
      expect(spendableBelowUSD).to.equal(0n)
      expect(spendableBelowStEth).to.equal(0n)

      const preBelow = await captureAllocatePreState()
      const below = await expectAllocateMirror(preBelow)
      expect(below.status).to.equal(ALLOCATION_STATUS.StEthPriceBelowMin)

      // The guard is strict `<`, so a floor equal to the quote passes.
      await allocator.connect(adminSigner).setMinStEthPriceUSD(quote)
      expect(await allocator.minStEthPriceUSD()).to.equal(quote)

      const previewDay = BigInt(await time.latest()) / ONE_DAY
      const [statusAt, spendableAtUSD, spendableAtStEth] = await allocator.spendable()
      expect(statusAt).to.equal(ALLOCATION_STATUS.Eligible)
      expect(spendableAtUSD).to.be.gt(0n)

      const preAt = await captureAllocatePreState()
      const at = await expectAllocateMirror(preAt)
      expect(
        at.blockTimestamp / ONE_DAY,
        'crossed UTC midnight between preview and release'
      ).to.equal(previewDay)
      expect(at.status).to.equal(ALLOCATION_STATUS.Eligible)
      expect(at.spendUSD).to.equal(spendableAtUSD)
      expect(at.spendStEth).to.equal(spendableAtStEth)

      await allocator.connect(adminSigner).setMinStEthPriceUSD(ALLOCATOR_PARAMS.minStEthPriceUSD)
    })
  })

  // --- Group 3: allocate() — release mirror on the deployed stack ---

  context('allocate(): checkpoint and release', function () {
    before(async function () {
      await snapshotStaged.restore()
    })

    // Saved by the release test, consumed by the residual test of this context.
    let releaseOutcome: AllocateOutcome

    it('should bank the revenue sum and release real stETH to the executor', async function () {
      await earnBudget()
      await expectQuoteFresh()

      const pre = await captureAllocatePreState()
      const out = await expectAllocateMirror(pre)
      expect(out.status).to.equal(ALLOCATION_STATUS.Eligible)

      // Regime pins: the daily cap must be the binding constraint, or a broken budget or
      // funding path could quietly shrink the release with every downstream check following it.
      expect(out.budgetCheckpointed, 'budget no longer saturates the daily cap').to.be.gte(
        out.dailyUnspent
      )
      expect(out.yearlyUnspent, 'yearly window binds before the daily cap').to.be.gte(
        out.dailyUnspent
      )
      expect(
        stEthOfUsd(out.dailyUnspent),
        'allocator stETH balance binds before the daily cap'
      ).to.be.lte(pre.allocatorStEth)

      releaseOutcome = out
    })

    it('should skip the post-saturation residual without consuming state', async function () {
      // The USD->stETH->USD round-trip floors the spend, so the window closes with a remainder
      // below one stETH-wei's worth of USD: an exact saturation skips as WindowCapReached, a
      // dust residual as AllocationBelowMin (it converts to zero stETH).
      const dailyRemainderUSD = releaseOutcome.dailyUnspent - releaseOutcome.spendUSD
      const expectedStatus =
        dailyRemainderUSD === 0n
          ? ALLOCATION_STATUS.WindowCapReached
          : ALLOCATION_STATUS.AllocationBelowMin

      const [previewStatus, previewUSD, previewStEth] = await allocator.spendable()
      expect(previewStatus).to.equal(expectedStatus)
      expect(previewUSD).to.equal(0n)
      expect(previewStEth).to.equal(0n)

      // The scenario suite stops at the preview here — this drives the second release attempt
      // for real. The mirror asserts no transfer, no hook, and untouched windows.
      const pre = await captureAllocatePreState()
      const out = await expectAllocateMirror(pre)
      expect(out.blockTimestamp / ONE_DAY, 'crossed UTC midnight after the saturation').to.equal(
        releaseOutcome.blockTimestamp / ONE_DAY
      )
      expect(out.status).to.equal(expectedStatus)
    })
  })

  context('allocate(): preview parity', function () {
    before(async function () {
      await snapshotStaged.restore()
    })

    it('should preview exactly what the release delivers', async function () {
      await earnBudget()
      await expectDailyHeadroom(ALLOCATOR_PARAMS.minSpendPerCallUSD + HEADROOM_MARGIN_USD)

      const previewDay = BigInt(await time.latest()) / ONE_DAY
      const [previewStatus, previewUSD, previewStEth] = await allocator.spendable()
      expect(previewStatus).to.equal(ALLOCATION_STATUS.Eligible)

      const pre = await captureAllocatePreState()
      const out = await expectAllocateMirror(pre)
      // Across midnight the reserve and the daily window move and the parity is void.
      expect(
        out.blockTimestamp / ONE_DAY,
        'crossed UTC midnight between preview and release'
      ).to.equal(previewDay)
      expect(out.status).to.equal(ALLOCATION_STATUS.Eligible)
      expect(out.spendUSD).to.equal(previewUSD)
      expect(out.spendStEth).to.equal(previewStEth)
    })
  })

  // --- Group 4: conversion consistency under balance changes ---

  // The allocator has no share accounting — its only view of stETH is `balanceOf(this)`, so a
  // share-rate move and an inbound transfer are indistinguishable to it. Balance-level staging
  // therefore covers the whole "rebase" surface; genuine oracle-report rebases live in
  // buyback-happy-path.ts.

  context('balance clamp and USD restatement', function () {
    before(async function () {
      await snapshotStaged.restore()
      // Small-balance staging: the stETH balance, not the daily cap, binds.
      const stagedBalance = await stEth.balanceOf(allocatorAddress)
      if (stagedBalance > 0n) {
        await allocator.recoverERC20(contracts.STETH, stagedBalance)
      }
      await fundStEth(deployer, allocatorAddress, stEthOfUsd(SMALL_BALANCE_USD))
      await earnBudget()
    })

    it('should clamp to the real stETH balance and restate USD from the floored amount', async function () {
      await expectDailyHeadroom(SMALL_BALANCE_USD + HEADROOM_MARGIN_USD)

      const balance = await stEth.balanceOf(allocatorAddress)
      expect(usdOfStEth(balance)).to.be.lt(ALLOCATOR_PARAMS.dailyCapUSD)
      expect(usdOfStEth(balance)).to.be.gte(ALLOCATOR_PARAMS.minSpendPerCallUSD)

      const [previewStatus, previewUSD, previewStEth] = await allocator.spendable()
      expect(previewStatus).to.equal(ALLOCATION_STATUS.Eligible)
      expect(previewStEth).to.equal(balance)
      expect(previewUSD).to.equal(usdOfStEth(balance))

      const pre = await captureAllocatePreState()
      const out = await expectAllocateMirror(pre)
      expect(out.status).to.equal(ALLOCATION_STATUS.Eligible)
      expect(out.budgetCheckpointed, 'budget no longer exceeds the small balance').to.be.gt(
        out.spendUSD
      )
      expect(out.spendStEth).to.equal(balance)
      expect(out.spendUSD).to.equal(usdOfStEth(balance))

      // The release drains to dust and the residual budget stays banked.
      expect(await stEth.balanceOf(allocatorAddress)).to.be.lte(2n)
      expect(out.budgetCheckpointed - out.spendUSD).to.be.gt(0n)
    })
  })

  context('balance increase between preview and release', function () {
    before(async function () {
      await snapshotStaged.restore()
      const stagedBalance = await stEth.balanceOf(allocatorAddress)
      if (stagedBalance > 0n) {
        await allocator.recoverERC20(contracts.STETH, stagedBalance)
      }
      await fundStEth(deployer, allocatorAddress, stEthOfUsd(SMALL_BALANCE_USD))
      await earnBudget()
    })

    it('should track a balance increase between preview and release without minting budget', async function () {
      await expectDailyHeadroom(ALLOCATOR_PARAMS.dailyCapUSD)

      const balanceBefore = await stEth.balanceOf(allocatorAddress)
      const [firstStatus, firstUSD, firstStEth] = await allocator.spendable()
      expect(firstStatus).to.equal(ALLOCATION_STATUS.Eligible)
      expect(firstStEth).to.equal(balanceBefore)

      // Unsolicited stETH relaxes the clamp but never becomes budget: the USD accounting basis
      // must not move with the inbound transfer.
      const basisBefore = await captureCheckpointPreState()
      await fundStEth(deployer, allocatorAddress, 2n * stEthOfUsd(ALLOCATOR_PARAMS.dailyCapUSD))
      const basisAfter = await captureCheckpointPreState()
      expect(basisAfter.totalRevenueUSD).to.equal(basisBefore.totalRevenueUSD)
      expect(basisAfter.baselineRevenueUSD).to.equal(basisBefore.baselineRevenueUSD)
      expect(basisAfter.budgetUSD).to.equal(basisBefore.budgetUSD)

      const previewDay = BigInt(await time.latest()) / ONE_DAY
      const [secondStatus, secondUSD, secondStEth] = await allocator.spendable()
      expect(secondStatus).to.equal(ALLOCATION_STATUS.Eligible)
      expect(secondStEth).to.be.gt(firstStEth)
      expect(secondUSD).to.be.gt(firstUSD)

      const pre = await captureAllocatePreState()
      const out = await expectAllocateMirror(pre)
      expect(
        out.blockTimestamp / ONE_DAY,
        'crossed UTC midnight between preview and release'
      ).to.equal(previewDay)
      expect(out.status).to.equal(ALLOCATION_STATUS.Eligible)
      expect(out.spendUSD).to.equal(secondUSD)
      expect(out.spendStEth).to.equal(secondStEth)
      // The stETH leg re-derived from the topped-up balance is now cap-bound, not balance-bound.
      expect(out.spendStEth).to.be.lt(pre.allocatorStEth)
    })
  })

  context('one oracle for booking and spending', function () {
    before(async function () {
      await snapshotStaged.restore()
    })

    it('should book source revenue at the same price the allocator spends at', async function () {
      await expectDailyHeadroom(ALLOCATOR_PARAMS.minSpendPerCallUSD + HEADROOM_MARGIN_USD)

      // The source books pending stETH into USD at the router's live answer.
      await driveRebase(revenueSource, SATURATING_SHARES, { viaNotifier })
      const pending = await revenueSource.pendingRevenueStEth()
      const expectedRevenueUSD = mulDiv(pending, stEthUsdPrice, PRICE_UNIT)
      await expect(revenueSource.convertPendingRevenueToUSD())
        .to.emit(revenueSource, 'PendingRevenueConverted')
        .withArgs(pending, stEthUsdPrice, expectedRevenueUSD)

      // The allocator spends through the same oracle at the same frozen answer, so USD in and
      // USD out of the system agree.
      const pre = await captureAllocatePreState()
      const out = await expectAllocateMirror(pre)
      expect(out.status).to.equal(ALLOCATION_STATUS.Eligible)
      expect(out.spendUSD).to.equal(usdOfStEth(out.spendStEth))

      const [priceAtSpend] = await oracleRouter.getUsdPrices(contracts.STETH, contracts.STETH)
      expect(priceAtSpend).to.equal(stEthUsdPrice)
    })
  })

  // --- Group 5: calendar time — windows and reserve ---

  context('spend windows and reserve over calendar time', function () {
    before(async function () {
      await snapshotStaged.restore()
    })

    it('should roll the daily window at the activation-aligned boundary', async function () {
      // Saturate day 1 first, so the roll observably resets a consumed window.
      await earnBudget()
      await expectQuoteFresh()
      const saturation = await expectAllocateMirror(await captureAllocatePreState())
      expect(saturation.status).to.equal(ALLOCATION_STATUS.Eligible)

      await time.increaseTo((await allocator.daily()).endTS + 1n)
      await earnBudget()
      await expectQuoteFresh()

      const pre = await captureAllocatePreState()
      const out = await expectAllocateMirror(pre)
      expect(out.status).to.equal(ALLOCATION_STATUS.Eligible)
      // The window reset to the full cap and its new end stays activation-aligned. The mirror
      // already verified the WindowRolled args; the yearly window must not have moved.
      expect(out.dailyUnspent).to.equal(pre.dailyCapUSD)
      const daily = await allocator.daily()
      expect((daily.endTS - pre.activationTS) % ONE_DAY).to.equal(0n)
      expect(daily.endTS).to.be.gt(out.blockTimestamp)
      const rolls = await allocator.queryFilter(
        allocator.filters.WindowRolled(),
        out.receipt.blockNumber,
        out.receipt.blockNumber
      )
      expect(rolls.length).to.equal(1)
      expect(rolls[0].args.windowDurationSeconds).to.equal(ONE_DAY)
    })

    it('should charge one reserve rate per elapsed day', async function () {
      await time.increase(3n * ONE_DAY)
      await expectQuoteFresh()

      const pre = await captureAllocatePreState()
      const out = await expectAllocateMirror(pre)

      const expectedDaysCharged = (out.blockTimestamp - pre.reserveAnchorTS) / ONE_DAY + 1n
      expect(expectedDaysCharged).to.be.gte(3n)
      expect(out.reserveUSD).to.equal(pre.reserveDailyRateUSD * expectedDaysCharged)
    })

    it('should bank a negative delta on an under-reserve day and net it against later surplus', async function () {
      await time.increase(ONE_DAY)
      await expectQuoteFresh()
      await earnBudget(UNDER_RESERVE_SHARES)

      // The small report trails the accrued reserve, so the checkpoint banks a deficit. The
      // post-checkpoint outcome is derived by the mirror, not hardcoded: a deployed allocator
      // may carry banked surplus, so the clamped budget can still be positive.
      const preDeficit = await captureAllocatePreState()
      const deficit = await expectAllocateMirror(preDeficit)
      expect(deficit.budgetDeltaUSD).to.be.lt(0n)

      // Later surplus nets against the recorded signed budget before any spend: the next
      // mirror starts from the stored post-deficit value.
      await fundStEth(deployer, allocatorAddress, 2n * stEthOfUsd(ALLOCATOR_PARAMS.dailyCapUSD))
      await earnBudget()
      const preSurplus = await captureAllocatePreState()
      expect(preSurplus.budgetUSD).to.equal(deficit.budgetCheckpointed - deficit.spendUSD)
      const surplus = await expectAllocateMirror(preSurplus)
      expect(surplus.status).to.equal(ALLOCATION_STATUS.Eligible)
    })
  })

  // --- Group 6: revenue source management against real contracts ---

  context('revenue source management', function () {
    let secondSource: StakingRevenueSource
    let secondSourceAddress: string

    // Saved by the summation release, consumed by the post-removal residual derivation.
    let sumOutcome: AllocateOutcome

    before(async function () {
      await snapshotStaged.restore()
      // A second real StakingRevenueSource, not a stub: the ERC165 gate and the cumulative
      // reads run against live bytecode. Its rebases go through the direct authorized push —
      // the notifier fans out only to registered observers.
      secondSource = await new StakingRevenueSource__factory(deployer).deploy(
        ORACLE_ROUTER_ADDRESS,
        LIDO_LOCATOR_ADDRESS
      )
      await secondSource.waitForDeployment()
      secondSourceAddress = await secondSource.getAddress()
    })

    it('should add a second live StakingRevenueSource without banking its prior earnings', async function () {
      // Pre-load the source so registration demonstrably excludes pre-registration earnings.
      await driveRebase(secondSource, SECOND_SOURCE_SEED_SHARES, { viaNotifier: false })
      await secondSource.convertPendingRevenueToUSD()
      const secondCumulative = await secondSource.getCumulativeRevenueUSD()
      expect(secondCumulative).to.be.gt(0n)
      expect(secondCumulative).to.not.equal(await revenueSource.getCumulativeRevenueUSD())

      const pre = await captureCheckpointPreState()
      const receipt = (await (
        await allocator.connect(adminSigner).addRevenueSource(secondSourceAddress)
      ).wait())!
      const blockTimestamp = BigInt(
        (await ethers.provider.getBlock(receipt.blockNumber))!.timestamp
      )
      const { budgetCheckpointed } = mirrorCheckpoint(pre, blockTimestamp)

      // Checkpoint first, over the old source set only, then the registration: the new source's
      // pre-registration earnings extend the baseline, never the budget.
      const [checkpoint] = await allocator.queryFilter(
        allocator.filters.Checkpoint(),
        receipt.blockNumber,
        receipt.blockNumber
      )
      expect(checkpoint.args.lastTotalRevenueUSD).to.equal(pre.totalRevenueUSD)
      expect(checkpoint.args.budgetUSD).to.equal(budgetCheckpointed)
      const [added] = await allocator.queryFilter(
        allocator.filters.RevenueSourceAdded(),
        receipt.blockNumber,
        receipt.blockNumber
      )
      expect(added.args.source).to.equal(secondSourceAddress)
      expect(checkpoint.index).to.be.lt(added.index)

      expect(await allocator.lastTotalRevenueUSD()).to.equal(pre.totalRevenueUSD + secondCumulative)
      expect(await allocator.budgetUSD()).to.equal(budgetCheckpointed)
      expect(await allocator.revenueSources()).to.deep.equal([
        revenueSourceAddress,
        secondSourceAddress,
      ])
    })

    it('should sum revenue across both deployed sources', async function () {
      // Distinct non-zero addends, so a double-count or a single-source read cannot pass.
      await driveRebase(revenueSource, FIRST_SOURCE_TOPUP_SHARES, { viaNotifier })
      await revenueSource.convertPendingRevenueToUSD()
      await driveRebase(secondSource, SECOND_SOURCE_TOPUP_SHARES, { viaNotifier: false })
      await secondSource.convertPendingRevenueToUSD()

      const firstCumulative = await revenueSource.getCumulativeRevenueUSD()
      const secondCumulative = await secondSource.getCumulativeRevenueUSD()
      expect(firstCumulative).to.be.gt(0n)
      expect(secondCumulative).to.be.gt(0n)
      expect(firstCumulative).to.not.equal(secondCumulative)

      await expectDailyHeadroom(ALLOCATOR_PARAMS.minSpendPerCallUSD + HEADROOM_MARGIN_USD)
      const pre = await captureAllocatePreState()
      expect(pre.totalRevenueUSD).to.equal(firstCumulative + secondCumulative)
      sumOutcome = await expectAllocateMirror(pre)
      expect(sumOutcome.status).to.equal(ALLOCATION_STATUS.Eligible)
    })

    it('should remove a source keeping the banked budget', async function () {
      const secondCumulative = await secondSource.getCumulativeRevenueUSD()

      const pre = await captureCheckpointPreState()
      const receipt = (await (
        await allocator.connect(adminSigner).removeRevenueSource(secondSourceAddress)
      ).wait())!
      const blockTimestamp = BigInt(
        (await ethers.provider.getBlock(receipt.blockNumber))!.timestamp
      )
      const { budgetCheckpointed } = mirrorCheckpoint(pre, blockTimestamp)

      // Checkpoint first, over both sources, banking the removed source's surplus; then the
      // baseline drops by exactly its cumulative while the banked budget stays.
      const [checkpoint] = await allocator.queryFilter(
        allocator.filters.Checkpoint(),
        receipt.blockNumber,
        receipt.blockNumber
      )
      expect(checkpoint.args.lastTotalRevenueUSD).to.equal(pre.totalRevenueUSD)
      const [removed] = await allocator.queryFilter(
        allocator.filters.RevenueSourceRemoved(),
        receipt.blockNumber,
        receipt.blockNumber
      )
      expect(removed.args.source).to.equal(secondSourceAddress)

      expect(await allocator.lastTotalRevenueUSD()).to.equal(pre.totalRevenueUSD - secondCumulative)
      expect(await allocator.budgetUSD()).to.equal(budgetCheckpointed)
      expect(await allocator.revenueSources()).to.deep.equal([revenueSourceAddress])

      // A later rebase into the removed source no longer moves the allocator's accounting.
      await driveRebase(secondSource, SECOND_SOURCE_SEED_SHARES, { viaNotifier: false })
      await secondSource.convertPendingRevenueToUSD()
      const preAfter = await captureAllocatePreState()
      expect(preAfter.totalRevenueUSD).to.equal(await revenueSource.getCumulativeRevenueUSD())
      const after = await expectAllocateMirror(preAfter)
      expect(
        after.blockTimestamp / ONE_DAY,
        'crossed UTC midnight after the summation release'
      ).to.equal(sumOutcome.blockTimestamp / ONE_DAY)
      // The summation release consumed the day: an exact saturation skips as WindowCapReached,
      // a double-floor dust residual as AllocationBelowMin, as in the residual test of Group 3.
      expect(after.status).to.equal(
        sumOutcome.dailyUnspent - sumOutcome.spendUSD === 0n
          ? ALLOCATION_STATUS.WindowCapReached
          : ALLOCATION_STATUS.AllocationBelowMin
      )
    })

    it('should reject a non-IRevenueSource contract and a duplicate registration', async function () {
      // Real token bytecode with no ERC165 support trips the interface gate.
      await expect(allocator.connect(adminSigner).addRevenueSource(contracts.STETH))
        .to.be.revertedWithCustomError(allocator, 'RevenueSourceUnsupported')
        .withArgs(contracts.STETH)

      await expect(
        allocator.connect(adminSigner).addRevenueSource(revenueSourceAddress)
      ).to.be.revertedWithCustomError(allocator, 'RevenueSourceAlreadyRegistered')
    })
  })

  // --- Group 7: governance lever with checkpoint-first semantics ---

  context('setSurplusShareBP()', function () {
    before(async function () {
      await snapshotStaged.restore()
    })

    it('should apply a surplus-share change only to later revenue', async function () {
      // Land real revenue that is still uncheckpointed when the lever moves.
      await earnBudget()

      const pre = await captureCheckpointPreState()
      expect(pre.surplusShareBP).to.equal(ALLOCATOR_PARAMS.surplusShareBP)

      const receipt = (await (
        await allocator.connect(adminSigner).setSurplusShareBP(REDUCED_SURPLUS_SHARE_BP)
      ).wait())!
      const blockTimestamp = BigInt(
        (await ethers.provider.getBlock(receipt.blockNumber))!.timestamp
      )
      const { reserveUSD, budgetDeltaUSD, budgetCheckpointed } = mirrorCheckpoint(
        pre,
        blockTimestamp
      )

      // The embedded checkpoint banks the pending surplus at the old share before the new one
      // lands.
      const [checkpoint] = await allocator.queryFilter(
        allocator.filters.Checkpoint(),
        receipt.blockNumber,
        receipt.blockNumber
      )
      expect(checkpoint.args.lastTotalRevenueUSD).to.equal(pre.totalRevenueUSD)
      expect(checkpoint.args.reserveUSD).to.equal(reserveUSD)
      expect(checkpoint.args.budgetDeltaUSD).to.equal(budgetDeltaUSD)
      expect(checkpoint.args.budgetUSD).to.equal(budgetCheckpointed)
      const [shareSet] = await allocator.queryFilter(
        allocator.filters.SurplusShareBPSet(),
        receipt.blockNumber,
        receipt.blockNumber
      )
      expect(shareSet.args.surplusShareBP).to.equal(REDUCED_SURPLUS_SHARE_BP)
      expect(await allocator.surplusShareBP()).to.equal(REDUCED_SURPLUS_SHARE_BP)

      // Revenue earned after the change banks at the reduced share — the mirror reads the live
      // share, so its exact Checkpoint assertions prove the new rate applied.
      await earnBudget()
      await expectDailyHeadroom(ALLOCATOR_PARAMS.minSpendPerCallUSD + HEADROOM_MARGIN_USD)
      const preAfter = await captureAllocatePreState()
      expect(preAfter.surplusShareBP).to.equal(REDUCED_SURPLUS_SHARE_BP)
      const reducedShareRelease = await expectAllocateMirror(preAfter)
      expect(reducedShareRelease.status).to.equal(ALLOCATION_STATUS.Eligible)
    })
  })

  // --- Group 8: executor-side failure surfaces ---

  // The hook's modifier order is pause-then-role, so each test stages the other guard green or
  // it reverts on the wrong string.
  context('executor-side failure surfaces', function () {
    before(async function () {
      await snapshotStaged.restore()
      if (!(await executor.hasRole(EMERGENCY_ROLE, deployerAddress))) {
        await executor.connect(adminSigner).grantRole(EMERGENCY_ROLE, deployerAddress)
      }
    })

    it('should revert the whole allocation while the executor is paused', async function () {
      expect(await executor.hasRole(ALLOCATOR_ROLE, allocatorAddress)).to.equal(true)
      await executor.pause()
      expect(await executor.paused()).to.equal(true)

      await earnBudget()
      await expectDailyHeadroom(ALLOCATOR_PARAMS.minSpendPerCallUSD + HEADROOM_MARGIN_USD)
      const budgetBefore = await allocator.budgetUSD()

      await expect(allocator.allocate()).to.be.revertedWith(PAUSED_REVERT)
      // The tx reverts atomically, so the checkpoint did not persist.
      expect(await allocator.budgetUSD()).to.equal(budgetBefore)

      await executor.unpause()
      const out = await expectAllocateMirror(await captureAllocatePreState())
      expect(out.status).to.equal(ALLOCATION_STATUS.Eligible)
    })

    it('should revert when the allocator loses ALLOCATOR_ROLE on the executor', async function () {
      expect(await executor.paused()).to.equal(false)
      await executor.connect(adminSigner).revokeRole(ALLOCATOR_ROLE, allocatorAddress)

      // A fresh day and fresh budget, so the release path actually reaches the hook.
      await time.increaseTo((await allocator.daily()).endTS + 1n)
      await expectQuoteFresh()
      await earnBudget()

      await expect(allocator.allocate()).to.be.revertedWith(
        missingRoleMessage(allocatorAddress, ALLOCATOR_ROLE)
      )
    })
  })

  // --- Group 9: asset recovery to the real treasury ---

  context('asset recovery', function () {
    before(async function () {
      await snapshotStaged.restore()
    })

    it('should recover stETH to the Agent without touching accounting', async function () {
      await earnBudget()
      await expectDailyHeadroom(RETAINED_BALANCE_USD + HEADROOM_MARGIN_USD)

      const balance = await stEth.balanceOf(allocatorAddress)
      const recoverAmount = balance - stEthOfUsd(RETAINED_BALANCE_USD)
      expect(recoverAmount).to.be.gt(0n)

      const agentBefore = await stEth.balanceOf(contracts.AGENT)
      const budgetBefore = await allocator.budgetUSD()
      const dailyBefore = await allocator.daily()
      const yearlyBefore = await allocator.yearly()

      // The MANAGER_ROLE signer recovers to the immutable TREASURY (the Agent) only.
      await expect(allocator.recoverERC20(contracts.STETH, recoverAmount))
        .to.emit(allocator, 'ERC20Recovered')
        .withArgs(contracts.STETH, recoverAmount)
      expect(await stEth.balanceOf(contracts.AGENT)).to.be.closeTo(agentBefore + recoverAmount, 2n)

      // Recovery is invisible to the budget and the windows.
      expect(await allocator.budgetUSD()).to.equal(budgetBefore)
      const dailyAfter = await allocator.daily()
      const yearlyAfter = await allocator.yearly()
      expect(dailyAfter.endTS).to.equal(dailyBefore.endTS)
      expect(dailyAfter.spentUSD).to.equal(dailyBefore.spentUSD)
      expect(yearlyAfter.endTS).to.equal(yearlyBefore.endTS)
      expect(yearlyAfter.spentUSD).to.equal(yearlyBefore.spentUSD)

      // The smaller balance surfaces through the clamp only.
      const remaining = await stEth.balanceOf(allocatorAddress)
      const [status, spendableUSD, spendableStEth] = await allocator.spendable()
      expect(status).to.equal(ALLOCATION_STATUS.Eligible)
      expect(spendableStEth).to.equal(remaining)
      expect(spendableUSD).to.equal(usdOfStEth(remaining))
    })
  })
})
