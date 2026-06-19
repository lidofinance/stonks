import { ethers } from 'hardhat'
import { expect } from 'chai'
import { Signer } from 'ethers'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'

import {
  StakingRevenueSource,
  StakingRevenueSource__factory,
  StEthSharesStub,
  StEthSharesStub__factory,
  StakingRouterStub,
  StakingRouterStub__factory,
  OracleRouterUsdStub,
  OracleRouterUsdStub__factory,
  LidoLocatorStub,
  LidoLocatorStub__factory,
  BuybackAllocator,
  BuybackAllocator__factory,
} from '../../typechain-types'

const PRICE_SCALE = 10n ** 18n
const BASE_PRECISION = 10_000n
const MODULES_FEE = 500n
const TREASURY_FEE = 500n
const INITIAL_POOLED_ETH_PER_SHARE = PRICE_SCALE // 1:1 → shares == stETH
const STETH_USD_PRICE = ethers.parseEther('3500')
const NOMINAL_FEE_SHARES = ethers.parseEther('1000')

// Allocator config — large caps so revenue accounting, not the caps, is what we observe.
const DAILY_CAP_USD = ethers.parseEther('1000000')
const YEARLY_CAP_USD = ethers.parseEther('10000000')
const MIN_SPEND_PER_CALL_USD = ethers.parseEther('1')
const SURPLUS_SHARE_BP = 5000n

enum OracleFailureMode {
  None = 0,
  CustomError = 1,
  EmptyRevert = 2,
}

// Unused rebase-payload params (timeElapsed, pre/post totals).
const PUSH_IGNORED = [1n, 1n, 1n, 1n, 1n] as const

// Monotonically increasing report timestamp — the contract dedupes on it, so each push must
// carry a larger value. Global counter keeps every call strictly increasing; each test deploys a
// fresh source (`lastReportTimestamp == 0`), so any positive value passes the first gate.
let reportTsCounter = 0n
function nextReportTs(): bigint {
  reportTsCounter += 1n
  return reportTsCounter
}

async function pushSharesMinted(
  revenueSource: StakingRevenueSource,
  caller: Signer,
  shares: bigint
) {
  return revenueSource.connect(caller).pushTokenRate(nextReportTs(), ...PUSH_IGNORED, shares)
}

function expectedTreasuryStEth(
  sharesMintedAsFees: bigint,
  treasuryFee: bigint,
  modulesFee: bigint,
  pooledEthPerShare: bigint
): bigint {
  const totalFee = modulesFee + treasuryFee
  if (totalFee === 0n) return 0n
  const treasuryShares = (sharesMintedAsFees * treasuryFee) / totalFee
  return (treasuryShares * pooledEthPerShare) / PRICE_SCALE
}

function expectedRevenueUSD(stEth: bigint, stEthUsdPrice: bigint): bigint {
  return (stEth * stEthUsdPrice) / PRICE_SCALE
}

describe('StakingRevenueSource — integration', function () {
  let factory: StakingRevenueSource__factory
  let revenueSource: StakingRevenueSource
  let stEthStub: StEthSharesStub
  let stakingRouterStub: StakingRouterStub
  let oracleStub: OracleRouterUsdStub
  let locatorStub: LidoLocatorStub

  let admin: Signer
  let notifier: Signer
  let stranger: Signer
  let executor: Signer

  let topSnapshot: SnapshotRestorer
  let snapshot: SnapshotRestorer

  async function deployStubsAndSource() {
    stEthStub = await new StEthSharesStub__factory(admin).deploy(INITIAL_POOLED_ETH_PER_SHARE)
    stakingRouterStub = await new StakingRouterStub__factory(admin).deploy()
    oracleStub = await new OracleRouterUsdStub__factory(admin).deploy()
    locatorStub = await new LidoLocatorStub__factory(admin).deploy()

    await stakingRouterStub.setFeeDistribution(MODULES_FEE, TREASURY_FEE, BASE_PRECISION)
    await oracleStub.setUsdPrice(STETH_USD_PRICE, STETH_USD_PRICE)
    await locatorStub.setLido(await stEthStub.getAddress())
    await locatorStub.setStakingRouter(await stakingRouterStub.getAddress())
    await locatorStub.setPostTokenRebaseReceiver(await notifier.getAddress())

    revenueSource = await factory.deploy(
      await oracleStub.getAddress(),
      await locatorStub.getAddress()
    )
    await revenueSource.waitForDeployment()
  }

  async function deployAllocator(revenueSources: string[]): Promise<BuybackAllocator> {
    const allocator = await new BuybackAllocator__factory(admin).deploy({
      admin: await admin.getAddress(),
      treasury: await admin.getAddress(),
      stEth: await stEthStub.getAddress(),
      oracleRouter: await oracleStub.getAddress(),
      executor: await executor.getAddress(),
      dailyCapUSD: DAILY_CAP_USD,
      yearlyCapUSD: YEARLY_CAP_USD,
      minStEthPriceUSD: 0n,
      minSpendPerCallUSD: MIN_SPEND_PER_CALL_USD,
      surplusShareBP: SURPLUS_SHARE_BP,
      revenueSources,
    })
    await allocator.waitForDeployment()
    return allocator
  }

  before(async function () {
    topSnapshot = await takeSnapshot()
    ;[admin, notifier, stranger, executor] = await ethers.getSigners()
    factory = await ethers.getContractFactory('StakingRevenueSource')
  })

  after(async function () {
    await topSnapshot.restore()
  })

  beforeEach(async function () {
    snapshot = await takeSnapshot()
    await deployStubsAndSource()
  })

  afterEach(async function () {
    await snapshot.restore()
  })

  describe('rebase-to-settlement lifecycle:', function () {
    it('should push across consecutive rebases then settle the whole bucket through the oracle', async function () {
      // Three rebases land while the share rate climbs; each push values its slice at the
      // rate live at that moment, then a single conversion settles the aggregate at spot USD.
      const rates = [
        INITIAL_POOLED_ETH_PER_SHARE,
        (INITIAL_POOLED_ETH_PER_SHARE * 101n) / 100n,
        (INITIAL_POOLED_ETH_PER_SHARE * 103n) / 100n,
      ]

      let expectedPending = 0n
      for (const rate of rates) {
        await stEthStub.setPooledEthPerShare(rate)
        const slice = expectedTreasuryStEth(NOMINAL_FEE_SHARES, TREASURY_FEE, MODULES_FEE, rate)
        expectedPending += slice
        await pushSharesMinted(revenueSource, notifier, NOMINAL_FEE_SHARES)
      }

      expect(await revenueSource.pendingRevenueStEth()).to.equal(expectedPending)
      expect(await revenueSource.getCumulativeRevenueUSD()).to.equal(0n)

      const expectedUSD = expectedRevenueUSD(expectedPending, STETH_USD_PRICE)
      await expect(revenueSource.connect(stranger).convertPendingRevenueToUSD())
        .to.emit(revenueSource, 'PendingRevenueConverted')
        .withArgs(expectedPending, STETH_USD_PRICE, expectedUSD)

      expect(await revenueSource.getCumulativeRevenueUSD()).to.equal(expectedUSD)
      expect(await revenueSource.pendingRevenueStEth()).to.equal(0n)
    })
  })

  describe('oracle outage deferral:', function () {
    it('should defer revenue through an outage and settle the full amount on retry without loss', async function () {
      // Rebases keep arriving while the oracle is down — pushes are oracle-free so they all land.
      await oracleStub.setFailureMode(OracleFailureMode.CustomError)

      const pushCount = 4n
      for (let i = 0n; i < pushCount; i++) {
        await pushSharesMinted(revenueSource, notifier, NOMINAL_FEE_SHARES)
      }

      const accruedStEth =
        expectedTreasuryStEth(NOMINAL_FEE_SHARES, TREASURY_FEE, MODULES_FEE, INITIAL_POOLED_ETH_PER_SHARE) *
        pushCount
      expect(await revenueSource.pendingRevenueStEth()).to.equal(accruedStEth)

      // Conversion is blocked while the oracle is down; the bucket is preserved.
      await expect(revenueSource.connect(stranger).convertPendingRevenueToUSD()).to.be.reverted
      expect(await revenueSource.pendingRevenueStEth()).to.equal(accruedStEth)
      expect(await revenueSource.getCumulativeRevenueUSD()).to.equal(0n)

      // Oracle recovers — the entire deferred bucket settles in one conversion, nothing lost.
      await oracleStub.setFailureMode(OracleFailureMode.None)
      const expectedUSD = expectedRevenueUSD(accruedStEth, STETH_USD_PRICE)

      await expect(revenueSource.connect(stranger).convertPendingRevenueToUSD())
        .to.emit(revenueSource, 'PendingRevenueConverted')
        .withArgs(accruedStEth, STETH_USD_PRICE, expectedUSD)

      expect(await revenueSource.getCumulativeRevenueUSD()).to.equal(expectedUSD)
      expect(await revenueSource.pendingRevenueStEth()).to.equal(0n)
    })
  })

  describe('BuybackAllocator wiring:', function () {
    it('should be accepted by addRevenueSource via the ERC165 IRevenueSource check', async function () {
      const allocator = await deployAllocator([])
      await expect(allocator.addRevenueSource(await revenueSource.getAddress()))
        .to.emit(allocator, 'RevenueSourceAdded')
        .withArgs(await revenueSource.getAddress())
    })

    it('should reject a contract that does not advertise IRevenueSource', async function () {
      const allocator = await deployAllocator([])
      // The oracle stub is a valid contract but does not support IRevenueSource.
      await expect(allocator.addRevenueSource(await oracleStub.getAddress()))
        .to.be.revertedWithCustomError(allocator, 'RevenueSourceUnsupported')
        .withArgs(await oracleStub.getAddress())
    })

    it('should feed getCumulativeRevenueUSD() into the allocator activation baseline', async function () {
      // Accrue revenue through the full push → convert path first.
      await pushSharesMinted(revenueSource, notifier, NOMINAL_FEE_SHARES)
      await revenueSource.connect(stranger).convertPendingRevenueToUSD()
      const cumulative = await revenueSource.getCumulativeRevenueUSD()
      expect(cumulative).to.be.gt(0n)

      // Register against the allocator (constructor path) and activate.
      const allocator = await deployAllocator([await revenueSource.getAddress()])
      await allocator.activate(0n)

      // The allocator summed our source's cumulative into its baseline.
      expect(await allocator.lastTotalRevenueUSD()).to.equal(cumulative)
    })

    it('should baseline at the source cumulative only when the source is registered', async function () {
      // Accrue revenue once, then activate two allocators against the same chain state: one
      // with the source registered, one without. The baseline picks up the cumulative only
      // through registration, proving the allocator's sum is driven by the registered source.
      await pushSharesMinted(revenueSource, notifier, NOMINAL_FEE_SHARES)
      await revenueSource.connect(stranger).convertPendingRevenueToUSD()
      const cumulative = await revenueSource.getCumulativeRevenueUSD()
      expect(cumulative).to.be.gt(0n)

      const allocatorWith = await deployAllocator([await revenueSource.getAddress()])
      await allocatorWith.activate(0n)

      const allocatorWithout = await deployAllocator([])
      await allocatorWithout.activate(0n)

      expect(await allocatorWith.lastTotalRevenueUSD()).to.equal(cumulative)
      expect(await allocatorWithout.lastTotalRevenueUSD()).to.equal(0n)
    })
  })
})
