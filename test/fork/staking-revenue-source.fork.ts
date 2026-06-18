import { ethers } from 'hardhat'
import { expect } from 'chai'
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs'
import { Contract, Signer } from 'ethers'
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
} from '../../typechain-types'
import { getTestOracleRouter, resetTestOracleRouter } from '../../utils/test-oracle-router'

// The only stable anchor is the canonical LidoLocator proxy. Everything else — the notifier, its
// owner, the rebase provider, stETH, the staking router — is resolved from it on the fork, so the
// test follows redeploys of the (test-deployed) TokenRateNotifier exactly as the contract does.
const LIDO_LOCATOR = '0xC1d0b3DE6792Bf6b4b37EccdcC24e45978Cfd2Eb'

const PRICE_UNIT = 10n ** 18n
const FUND = ethers.parseEther('10000')

// Observer kinds as tagged by the notifier (Legacy = 0, WithArgs = 1).
const OBSERVER_KIND_WITH_ARGS = 1n

const NOTIFIER_ABI = [
  'function owner() view returns (address)',
  'function TOKEN_RATE_PROVIDER() view returns (address)',
  'function observersLength() view returns (uint256)',
  'function observers(uint256) view returns (address addr, uint8 kind)',
  'function addObserver(address observer) external',
  'function handlePostTokenRebase(uint256,uint256,uint256,uint256,uint256,uint256,uint256) external',
  'event PushTokenRateFailed(address indexed observer, bytes lowLevelRevertData)',
]

describe('StakingRevenueSource — fork (real TokenRateNotifier)', function () {
  let factory: StakingRevenueSource__factory
  let revenueSource: StakingRevenueSource
  let oracleRouter: OracleRouter
  let stakingRouter: IStakingRouter
  let stEth: IStETH
  let stEthAddress: string
  let notifierAgent: Contract // notifier connected as its owner
  let notifierProvider: Contract // notifier connected as TOKEN_RATE_PROVIDER

  let topSnapshot: SnapshotRestorer
  let snapshot: SnapshotRestorer
  let reportTsCounter: bigint

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
    return notifierProvider.handlePostTokenRebase(
      reportTsCounter,
      1n, // timeElapsed
      1n, // preTotalShares
      1n, // preTotalEther
      1n, // postTotalShares
      1n, // postTotalEther
      sharesMintedAsFees
    )
  }

  before(async function () {
    // Resolve the notifier from the locator, mirroring the contract's own lookup. Skip the whole
    // suite unless the fork actually has a notifier wired in (the default in-process fork does not).
    const locator: ILidoLocator = await ethers.getContractAt('ILidoLocator', LIDO_LOCATOR)
    let notifierAddress: string
    try {
      notifierAddress = await locator.postTokenRebaseReceiver()
    } catch {
      this.skip()
    }
    if (
      notifierAddress === ethers.ZeroAddress ||
      (await ethers.provider.getCode(notifierAddress)) === '0x'
    ) {
      this.skip()
    }

    topSnapshot = await takeSnapshot()

    stEthAddress = await locator.lido()
    stEth = await ethers.getContractAt('IStETH', stEthAddress)
    stakingRouter = await ethers.getContractAt('IStakingRouter', await locator.stakingRouter())

    // Owner (addObserver) and rebase provider (handlePostTokenRebase) are read off the notifier.
    const notifierView = new ethers.Contract(notifierAddress, NOTIFIER_ABI, ethers.provider)
    const ownerAddress: string = await notifierView.owner()
    const providerAddress: string = await notifierView.TOKEN_RATE_PROVIDER()

    await impersonateAccount(ownerAddress)
    await impersonateAccount(providerAddress)
    await setBalance(ownerAddress, FUND)
    await setBalance(providerAddress, FUND)
    const owner = await ethers.getSigner(ownerAddress)
    const provider = await ethers.getSigner(providerAddress)

    notifierAgent = new ethers.Contract(notifierAddress, NOTIFIER_ABI, owner)
    notifierProvider = new ethers.Contract(notifierAddress, NOTIFIER_ABI, provider)

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

  describe('addObserver / ERC165 auto-detection:', function () {
    it('should be registered as a WithArgs observer via ERC165', async function () {
      const lengthBefore = await notifierAgent.observersLength()

      await notifierAgent.addObserver(await revenueSource.getAddress())

      const lengthAfter = await notifierAgent.observersLength()
      expect(lengthAfter).to.equal(lengthBefore + 1n)

      const [addr, kind] = await notifierAgent.observers(lengthAfter - 1n)
      expect(addr).to.equal(await revenueSource.getAddress())
      expect(kind).to.equal(OBSERVER_KIND_WITH_ARGS)
    })
  })

  describe('rebase callback accumulation:', function () {
    beforeEach(async function () {
      await notifierAgent.addObserver(await revenueSource.getAddress())
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
        .to.emit(notifierProvider, 'PushTokenRateFailed')
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
      await notifierAgent.addObserver(await revenueSource.getAddress())
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
})
