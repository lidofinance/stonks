import { ethers } from 'hardhat'
import { expect } from 'chai'
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs'
import { Signer } from 'ethers'
import {
  impersonateAccount,
  setBalance,
  takeSnapshot,
  SnapshotRestorer,
} from '@nomicfoundation/hardhat-network-helpers'

import {
  StakingRevenueSource,
  StakingRevenueSource__factory,
  OracleRouter,
  IStakingRouter,
  IStETH,
  ILidoLocator,
  ITokenRateNotifier,
  BuybackAllocator,
  BuybackAllocator__factory,
} from '../../typechain-types'
import { getTestOracleRouter, resetTestOracleRouter } from '../../utils/test-oracle-router'

// The only stable anchor is the canonical LidoLocator proxy. Everything else — the notifier, its
// owner, the rebase provider, stETH, the staking router — is resolved from it on the fork, so the
// test follows redeploys of the (test-deployed) TokenRateNotifier exactly as the contract does.
const LIDO_LOCATOR = '0xC1d0b3DE6792Bf6b4b37EccdcC24e45978Cfd2Eb'

const PRICE_UNIT = 10n ** 18n
const FUND = ethers.parseEther('10000')

// BuybackAllocator config — large caps so revenue accounting, not the caps, is what we observe.
const DAILY_CAP_USD = ethers.parseEther('1000000')
const YEARLY_CAP_USD = ethers.parseEther('10000000')
const MIN_SPEND_PER_CALL_USD = ethers.parseEther('1')
const SURPLUS_SHARE_BP = 5000n

// Observer kinds the notifier registers under (enum ObserverKind { NoArgs, WithArgs }).
const OBSERVER_KIND_NO_ARGS = 0n
const OBSERVER_KIND_WITH_ARGS = 1n

describe('StakingRevenueSource — fork (real TokenRateNotifier)', function () {
  let factory: StakingRevenueSource__factory
  let revenueSource: StakingRevenueSource
  let oracleRouter: OracleRouter
  let stakingRouter: IStakingRouter
  let stEth: IStETH
  let stEthAddress: string
  let notifier: ITokenRateNotifier
  let notifierOwner: Signer // owner, authorizes addObserver
  let rebaseProvider: Signer // TOKEN_RATE_PROVIDER, authorizes handlePostTokenRebase

  let topSnapshot: SnapshotRestorer
  let snapshot: SnapshotRestorer
  let reportTsCounter: bigint
  let deployer: Signer
  let executor: Signer

  // Compute the treasury slice exactly as the contract does, against live fork state.
  async function expectedTreasuryStEth(sharesMintedAsFees: bigint): Promise<bigint> {
    const [modulesFee, treasuryFee] = await stakingRouter.getStakingFeeAggregateDistribution()
    const totalFee = modulesFee + treasuryFee
    if (totalFee === 0n) return 0n
    const treasuryShares = (sharesMintedAsFees * treasuryFee) / totalFee
    return stEth.getPooledEthByShares(treasuryShares)
  }

  async function fireRebase(sharesMintedAsFees: bigint, reportTs?: bigint) {
    reportTsCounter = reportTs ?? reportTsCounter + 1n
    return notifier.connect(rebaseProvider).handlePostTokenRebase(
      reportTsCounter,
      1n, // timeElapsed
      1n, // preTotalShares
      1n, // preTotalEther
      1n, // postTotalShares
      1n, // postTotalEther
      sharesMintedAsFees
    )
  }

  async function deployAllocator(revenueSources: string[]): Promise<BuybackAllocator> {
    const allocator = await new BuybackAllocator__factory(deployer).deploy({
      admin: await deployer.getAddress(),
      treasury: await deployer.getAddress(),
      stEth: stEthAddress,
      oracleRouter: await oracleRouter.getAddress(),
      executor: await executor.getAddress(),
      dailyCapUSD: DAILY_CAP_USD,
      yearlyCapUSD: YEARLY_CAP_USD,
      reserveDailyRateUSD: 0n,
      minStEthPriceUSD: 0n,
      minSpendPerCallUSD: MIN_SPEND_PER_CALL_USD,
      surplusShareBP: SURPLUS_SHARE_BP,
      revenueSources,
    })
    await allocator.waitForDeployment()
    return allocator
  }

  before(async function () {
    ;[deployer, executor] = await ethers.getSigners()

    // Resolve the notifier from the locator, mirroring the contract's own lookup. Requires a
    // mainnet fork at a block where the locator points at the NEST TokenRateNotifier; against any
    // other environment the resolution or the tests below fail loudly — no skip.
    const locator: ILidoLocator = await ethers.getContractAt('ILidoLocator', LIDO_LOCATOR)
    const notifierAddress = await locator.postTokenRebaseReceiver()

    topSnapshot = await takeSnapshot()

    stEthAddress = await locator.lido()
    stEth = await ethers.getContractAt('IStETH', stEthAddress)
    stakingRouter = await ethers.getContractAt('IStakingRouter', await locator.stakingRouter())

    // One notifier instance; addObserver and handlePostTokenRebase are each .connect'd to their
    // authorized caller — owner() for the former, TOKEN_RATE_PROVIDER() for the latter.
    notifier = await ethers.getContractAt('ITokenRateNotifier', notifierAddress)
    const ownerAddress = await notifier.owner()
    const providerAddress = await notifier.TOKEN_RATE_PROVIDER()

    await impersonateAccount(ownerAddress)
    await impersonateAccount(providerAddress)
    await setBalance(ownerAddress, FUND)
    await setBalance(providerAddress, FUND)
    notifierOwner = await ethers.getSigner(ownerAddress)
    rebaseProvider = await ethers.getSigner(providerAddress)

    oracleRouter = await getTestOracleRouter({ tokens: [stEthAddress] })

    factory = await ethers.getContractFactory('StakingRevenueSource')
  })

  after(async function () {
    if (topSnapshot) await topSnapshot.restore()
    resetTestOracleRouter()
  })

  beforeEach(async function () {
    snapshot = await takeSnapshot()
    reportTsCounter = BigInt(Math.floor(Date.now() / 1000))

    revenueSource = await factory.deploy(await oracleRouter.getAddress(), LIDO_LOCATOR)
    await revenueSource.waitForDeployment()
  })

  afterEach(async function () {
    await snapshot.restore()
  })

  describe('addObserver registration:', function () {
    it('should register as a WithArgs observer (ERC165 validated against the requested kind)', async function () {
      const lengthBefore = await notifier.observersLength()

      await notifier
        .connect(notifierOwner)
        .addObserver(await revenueSource.getAddress(), OBSERVER_KIND_WITH_ARGS)

      const lengthAfter = await notifier.observersLength()
      expect(lengthAfter).to.equal(lengthBefore + 1n)

      const [addr, kind] = await notifier.observers(lengthAfter - 1n)
      expect(addr).to.equal(await revenueSource.getAddress())
      expect(kind).to.equal(OBSERVER_KIND_WITH_ARGS)
    })

    it('should reject registration under the NoArgs kind (source advertises only WithArgs)', async function () {
      // The notifier validates the source's ERC165 against the requested kind. Our source only
      // claims ITokenRatePusherWithArgs, so registering it as NoArgs must revert.
      await expect(
        notifier
          .connect(notifierOwner)
          .addObserver(await revenueSource.getAddress(), OBSERVER_KIND_NO_ARGS)
      ).to.be.revertedWithCustomError(notifier, 'ErrorBadObserverInterface')
    })
  })

  describe('rebase callback accumulation:', function () {
    beforeEach(async function () {
      await notifier
        .connect(notifierOwner)
        .addObserver(await revenueSource.getAddress(), OBSERVER_KIND_WITH_ARGS)
    })

    it('should accept a real notifier callback and accumulate treasury stETH', async function () {
      const sharesMintedAsFees = ethers.parseEther('100')
      const expected = await expectedTreasuryStEth(sharesMintedAsFees)
      expect(expected).to.be.gt(0n)

      await fireRebase(sharesMintedAsFees)

      expect(await revenueSource.pendingRevenueStEth()).to.equal(expected)
      expect(await revenueSource.getCumulativeRevenueUSD()).to.equal(0n)
    })

    it('should accumulate across several reports with different sharesMintedAsFees', async function () {
      const first = ethers.parseEther('100')
      const second = ethers.parseEther('250')

      const expectedFirst = await expectedTreasuryStEth(first)
      await fireRebase(first)
      const expectedSecond = await expectedTreasuryStEth(second)
      await fireRebase(second)

      expect(await revenueSource.pendingRevenueStEth()).to.equal(expectedFirst + expectedSecond)
    })

    it('should skip a zero-fee report without changing pending', async function () {
      await fireRebase(ethers.parseEther('100'))
      const pendingAfterFirst = await revenueSource.pendingRevenueStEth()

      await fireRebase(0n)
      expect(await revenueSource.pendingRevenueStEth()).to.equal(pendingAfterFirst)
    })

    it('should skip a replayed report timestamp', async function () {
      const ts = reportTsCounter + 1000n
      const shares = ethers.parseEther('100')

      await fireRebase(shares, ts)
      const pendingAfterFirst = await revenueSource.pendingRevenueStEth()

      await fireRebase(shares, ts) // same reportTimestamp → replay, skipped
      expect(await revenueSource.pendingRevenueStEth()).to.equal(pendingAfterFirst)
      expect(await revenueSource.lastReportTimestamp()).to.equal(ts)
    })

    it('should isolate our revert from the rebase and leave our state untouched', async function () {
      await fireRebase(ethers.parseEther('100'))
      const pendingBefore = await revenueSource.pendingRevenueStEth()
      const tsBefore = await revenueSource.lastReportTimestamp()

      // `MaxUint256 * treasuryFee` overflows uint256 → our pushTokenRate reverts (Panic 0x11).
      // The notifier wraps observer calls in try/catch, so the rebase itself must not revert; it
      // surfaces the failure as `PushTokenRateFailed` for our observer instead, and our reverted
      // sub-call rolls back entirely (no partial state, no poisoned watermark).
      await expect(fireRebase(ethers.MaxUint256))
        .to.emit(notifier, 'PushTokenRateFailed')
        .withArgs(await revenueSource.getAddress(), anyValue)
      expect(await revenueSource.pendingRevenueStEth()).to.equal(pendingBefore)
      expect(await revenueSource.lastReportTimestamp()).to.equal(tsBefore)

      // A subsequent healthy rebase still accumulates — the source was not left poisoned.
      const expected = await expectedTreasuryStEth(ethers.parseEther('50'))
      await fireRebase(ethers.parseEther('50'))
      expect(await revenueSource.pendingRevenueStEth()).to.equal(pendingBefore + expected)
    })
  })

  describe('USD settlement against the deployed OracleRouter:', function () {
    beforeEach(async function () {
      await notifier
        .connect(notifierOwner)
        .addObserver(await revenueSource.getAddress(), OBSERVER_KIND_WITH_ARGS)
    })

    it('should convert pending stETH to USD using the OracleRouter price', async function () {
      await fireRebase(ethers.parseEther('100'))
      const pending = await revenueSource.pendingRevenueStEth()
      expect(pending).to.be.gt(0n)

      const [stEthUsdPrice] = await oracleRouter.getUsdPrices(stEthAddress, stEthAddress)
      expect(stEthUsdPrice).to.be.gt(0n)
      const expectedUSD = (pending * stEthUsdPrice) / PRICE_UNIT

      await expect(revenueSource.convertPendingRevenueToUSD())
        .to.emit(revenueSource, 'PendingRevenueConverted')
        .withArgs(pending, stEthUsdPrice, expectedUSD)

      expect(await revenueSource.getCumulativeRevenueUSD()).to.equal(expectedUSD)
      expect(await revenueSource.pendingRevenueStEth()).to.equal(0n)
    })

    it('should grow cumulative monotonically across push/convert cycles', async function () {
      const [stEthUsdPrice] = await oracleRouter.getUsdPrices(stEthAddress, stEthAddress)
      expect(stEthUsdPrice).to.be.gt(0n)

      // Cycle 1
      const expected1 = await expectedTreasuryStEth(ethers.parseEther('100'))
      await fireRebase(ethers.parseEther('100'))
      await revenueSource.convertPendingRevenueToUSD()
      const cumulative1 = await revenueSource.getCumulativeRevenueUSD()
      expect(cumulative1).to.equal((expected1 * stEthUsdPrice) / PRICE_UNIT)
      expect(await revenueSource.pendingRevenueStEth()).to.equal(0n)

      // Cycle 2
      const expected2 = await expectedTreasuryStEth(ethers.parseEther('250'))
      await fireRebase(ethers.parseEther('250'))
      await revenueSource.convertPendingRevenueToUSD()
      const cumulative2 = await revenueSource.getCumulativeRevenueUSD()
      expect(cumulative2).to.be.gt(cumulative1)
      expect(cumulative2).to.equal(cumulative1 + (expected2 * stEthUsdPrice) / PRICE_UNIT)
      expect(await revenueSource.pendingRevenueStEth()).to.equal(0n)
    })
  })

  describe('BuybackAllocator wiring:', function () {
    beforeEach(async function () {
      await notifier
        .connect(notifierOwner)
        .addObserver(await revenueSource.getAddress(), OBSERVER_KIND_WITH_ARGS)
    })

    it('should be accepted by addRevenueSource via the ERC165 IRevenueSource check', async function () {
      const allocator = await deployAllocator([])
      await allocator.activate()
      await expect(allocator.addRevenueSource(await revenueSource.getAddress()))
        .to.emit(allocator, 'RevenueSourceAdded')
        .withArgs(await revenueSource.getAddress())
    })

    it('should reject a contract that does not advertise IRevenueSource', async function () {
      const allocator = await deployAllocator([])
      await allocator.activate()
      // stETH is a real contract but does not advertise IRevenueSource.
      await expect(allocator.addRevenueSource(stEthAddress))
        .to.be.revertedWithCustomError(allocator, 'RevenueSourceUnsupported')
        .withArgs(stEthAddress)
    })

    it('should feed getCumulativeRevenueUSD() into the allocator activation baseline', async function () {
      await fireRebase(ethers.parseEther('100'))
      await revenueSource.convertPendingRevenueToUSD()
      const cumulative = await revenueSource.getCumulativeRevenueUSD()
      expect(cumulative).to.be.gt(0n)

      const allocator = await deployAllocator([await revenueSource.getAddress()])
      await allocator.activate()
      expect(await allocator.lastTotalRevenueUSD()).to.equal(cumulative)
    })

    it('should baseline at the source cumulative only when the source is registered', async function () {
      await fireRebase(ethers.parseEther('100'))
      await revenueSource.convertPendingRevenueToUSD()
      const cumulative = await revenueSource.getCumulativeRevenueUSD()
      expect(cumulative).to.be.gt(0n)

      const allocatorWith = await deployAllocator([await revenueSource.getAddress()])
      await allocatorWith.activate()
      const allocatorWithout = await deployAllocator([])
      await allocatorWithout.activate()

      expect(await allocatorWith.lastTotalRevenueUSD()).to.equal(cumulative)
      expect(await allocatorWithout.lastTotalRevenueUSD()).to.equal(0n)
    })
  })
})
