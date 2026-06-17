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
} from '../../../typechain-types'

const PRICE_SCALE = 10n ** 18n

const BASE_PRECISION = 10_000n
const MODULES_FEE = 500n
const TREASURY_FEE = 500n

const INITIAL_POOLED_ETH_PER_SHARE = PRICE_SCALE // 1:1 → shares == stETH

const STETH_USD_PRICE = ethers.parseEther('3500')

// A nominal positive rebase: 1k stETH worth of fee shares minted across modules + treasury.
const NOMINAL_FEE_SHARES = ethers.parseEther('1000')

// Placeholder values for the rebase-payload parameters that `StakingRevenueSource` does not
// consume. Their values do not affect any branch of `pushTokenRate`; they exist only so the
// call satisfies the 7-argument `ITokenRatePusherWithArgs` signature.
const PUSH_IGNORED = {
  reportTimestamp: 1n,
  timeElapsed: 1n,
  preTotalShares: 1n,
  preTotalEther: 1n,
  postTotalShares: 1n,
  postTotalEther: 1n,
}

async function pushSharesMinted(
  subject: StakingRevenueSource,
  caller: Signer,
  shares: bigint
) {
  return subject
    .connect(caller)
    .pushTokenRate(
      PUSH_IGNORED.reportTimestamp,
      PUSH_IGNORED.timeElapsed,
      PUSH_IGNORED.preTotalShares,
      PUSH_IGNORED.preTotalEther,
      PUSH_IGNORED.postTotalShares,
      PUSH_IGNORED.postTotalEther,
      shares
    )
}

enum OracleFailureMode {
  None = 0,
  CustomError = 1,
  EmptyRevert = 2,
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

function nominalTreasuryStEth(): bigint {
  return expectedTreasuryStEth(
    NOMINAL_FEE_SHARES,
    TREASURY_FEE,
    MODULES_FEE,
    INITIAL_POOLED_ETH_PER_SHARE
  )
}

describe('StakingRevenueSource', function () {
  let factory: StakingRevenueSource__factory
  let subject: StakingRevenueSource
  let stEthStub: StEthSharesStub
  let stakingRouterStub: StakingRouterStub
  let oracleStub: OracleRouterUsdStub
  let locatorStub: LidoLocatorStub

  let admin: Signer
  let notifier: Signer
  let stranger: Signer
  let altNotifier: Signer

  let topSnapshot: SnapshotRestorer

  async function deployStubs(): Promise<{
    stEth: StEthSharesStub
    stakingRouter: StakingRouterStub
    oracle: OracleRouterUsdStub
    locator: LidoLocatorStub
  }> {
    const stEth = await new StEthSharesStub__factory(admin).deploy(INITIAL_POOLED_ETH_PER_SHARE)
    const stakingRouter = await new StakingRouterStub__factory(admin).deploy()
    const oracle = await new OracleRouterUsdStub__factory(admin).deploy()
    const locator = await new LidoLocatorStub__factory(admin).deploy()

    await stakingRouter.setFeeDistribution(MODULES_FEE, TREASURY_FEE, BASE_PRECISION)
    await oracle.setUsdPrice(STETH_USD_PRICE, STETH_USD_PRICE)

    await locator.setLido(await stEth.getAddress())
    await locator.setStakingRouter(await stakingRouter.getAddress())
    await locator.setPostTokenRebaseReceiver(await notifier.getAddress())

    return { stEth, stakingRouter, oracle, locator }
  }

  async function deploySubject(
    overrides: {
      oracleRouter?: string
      lidoLocator?: string
    } = {}
  ) {
    const instance = await factory.deploy(
      overrides.oracleRouter ?? (await oracleStub.getAddress()),
      overrides.lidoLocator ?? (await locatorStub.getAddress())
    )
    await instance.waitForDeployment()
    return instance
  }

  before(async function () {
    topSnapshot = await takeSnapshot()
    ;[admin, notifier, stranger, altNotifier] = await ethers.getSigners()

    factory = await ethers.getContractFactory('StakingRevenueSource')
  })

  after(async function () {
    await topSnapshot.restore()
  })

  beforeEach(async function () {
    const stubs = await deployStubs()
    stEthStub = stubs.stEth
    stakingRouterStub = stubs.stakingRouter
    oracleStub = stubs.oracle
    locatorStub = stubs.locator
  })

  describe('deployment:', function () {
    let snapshot: SnapshotRestorer

    beforeEach(async function () {
      snapshot = await takeSnapshot()
      subject = await deploySubject()
    })

    afterEach(async function () {
      await snapshot.restore()
    })

    it('should revert with InvalidOracleRouterAddress when oracle is zero', async function () {
      await expect(deploySubject({ oracleRouter: ethers.ZeroAddress }))
        .to.be.revertedWithCustomError(factory, 'InvalidOracleRouterAddress')
        .withArgs(ethers.ZeroAddress)
    })

    it('should revert with InvalidLidoLocatorAddress when locator is zero', async function () {
      await expect(deploySubject({ lidoLocator: ethers.ZeroAddress }))
        .to.be.revertedWithCustomError(factory, 'InvalidLidoLocatorAddress')
        .withArgs(ethers.ZeroAddress)
    })

    it('should store ORACLE_ROUTER and LIDO_LOCATOR as immutables', async function () {
      expect(await subject.ORACLE_ROUTER()).to.equal(await oracleStub.getAddress())
      expect(await subject.LIDO_LOCATOR()).to.equal(await locatorStub.getAddress())
    })

    it('should cache PRICE_SCALE from the OracleRouter at construction', async function () {
      expect(await subject.PRICE_SCALE()).to.equal(await oracleStub.PRICE_UNIT())
    })

    it('should initialize cumulative and pending accumulators at zero', async function () {
      expect(await subject.getCumulativeRevenueUSD()).to.equal(0n)
      expect(await subject.pendingRevenueStEth()).to.equal(0n)
    })
  })

  describe('#pushTokenRate', function () {
    let snapshot: SnapshotRestorer

    beforeEach(async function () {
      snapshot = await takeSnapshot()
      subject = await deploySubject()
    })

    afterEach(async function () {
      await snapshot.restore()
    })

    describe('authorization:', function () {
      it('should revert with UnauthorizedCaller when called by admin', async function () {
        const adminAddr = await admin.getAddress()
        await expect(pushSharesMinted(subject, admin, NOMINAL_FEE_SHARES))
          .to.be.revertedWithCustomError(subject, 'UnauthorizedCaller')
          .withArgs(adminAddr)
      })

      it('should revert with UnauthorizedCaller when called by an unrelated stranger', async function () {
        const strangerAddr = await stranger.getAddress()
        await expect(pushSharesMinted(subject, stranger, NOMINAL_FEE_SHARES))
          .to.be.revertedWithCustomError(subject, 'UnauthorizedCaller')
          .withArgs(strangerAddr)
      })

      it('should accept the caller currently registered as postTokenRebaseReceiver', async function () {
        await expect(pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)).to.not.be.reverted
      })

      it('self-heal: a locator upgrade that retargets the receiver auto-grants the new caller', async function () {
        // The original notifier is no longer the receiver after the locator update.
        await locatorStub.setPostTokenRebaseReceiver(await altNotifier.getAddress())

        const notifierAddr = await notifier.getAddress()
        await expect(pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES))
          .to.be.revertedWithCustomError(subject, 'UnauthorizedCaller')
          .withArgs(notifierAddr)

        // The newly-pointed receiver can push without any contract-side governance action.
        await expect(pushSharesMinted(subject, altNotifier, NOMINAL_FEE_SHARES)).to.not.be.reverted
      })

      it('should revert UnauthorizedCaller when locator reports zero receiver', async function () {
        await locatorStub.setPostTokenRebaseReceiver(ethers.ZeroAddress)

        const notifierAddr = await notifier.getAddress()
        await expect(pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES))
          .to.be.revertedWithCustomError(subject, 'UnauthorizedCaller')
          .withArgs(notifierAddr)
      })
    })

    describe('happy path:', function () {
      it('should accumulate treasury stETH into the pending bucket and emit RevenueAccumulatedInStEth', async function () {
        const expectedStEth = nominalTreasuryStEth()

        await expect(pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES))
          .to.emit(subject, 'RevenueAccumulatedInStEth')
          .withArgs(expectedStEth, expectedStEth)

        expect(await subject.pendingRevenueStEth()).to.equal(expectedStEth)
      })

      it('should NOT touch the cumulative USD accumulator on pushTokenRate', async function () {
        await pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)
        expect(await subject.getCumulativeRevenueUSD()).to.equal(0n)
      })

      it('should NOT call the OracleRouter on pushTokenRate', async function () {
        // Configure oracle to revert with empty data. If pushTokenRate routed through it, the
        // push would itself revert. It must not.
        await oracleStub.setFailureMode(OracleFailureMode.EmptyRevert)

        await expect(pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)).to.not.be.reverted
        expect(await subject.pendingRevenueStEth()).to.equal(nominalTreasuryStEth())
      })

      it('should sum pending across consecutive rebases', async function () {
        const perPushStEth = nominalTreasuryStEth()

        await pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)
        await pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)
        await pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)

        expect(await subject.pendingRevenueStEth()).to.equal(perPushStEth * 3n)
      })

      it('should scale pending with pooledEthPerShare after a positive rebase', async function () {
        const inflatedRate = (INITIAL_POOLED_ETH_PER_SHARE * 101n) / 100n
        await stEthStub.setPooledEthPerShare(inflatedRate)

        const expectedStEth = expectedTreasuryStEth(
          NOMINAL_FEE_SHARES,
          TREASURY_FEE,
          MODULES_FEE,
          inflatedRate
        )

        await expect(pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES))
          .to.emit(subject, 'RevenueAccumulatedInStEth')
          .withArgs(expectedStEth, expectedStEth)
      })

      it('should pick up updated fee splits between rebases', async function () {
        const firstStEth = nominalTreasuryStEth()
        await pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)

        const newModulesFee = 700n
        const newTreasuryFee = 300n
        await stakingRouterStub.setFeeDistribution(newModulesFee, newTreasuryFee, BASE_PRECISION)

        const secondStEth = expectedTreasuryStEth(
          NOMINAL_FEE_SHARES,
          newTreasuryFee,
          newModulesFee,
          INITIAL_POOLED_ETH_PER_SHARE
        )

        await expect(pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES))
          .to.emit(subject, 'RevenueAccumulatedInStEth')
          .withArgs(secondStEth, firstStEth + secondStEth)
      })

      it('should pick up the new StakingRouter address if the locator is upgraded', async function () {
        // Deploy a second StakingRouter stub with a different fee split. After the locator is
        // retargeted, the contract must use the new router's split.
        const newStakingRouter = await new StakingRouterStub__factory(admin).deploy()
        const newModulesFee = 700n
        const newTreasuryFee = 300n
        await newStakingRouter.setFeeDistribution(newModulesFee, newTreasuryFee, BASE_PRECISION)
        await locatorStub.setStakingRouter(await newStakingRouter.getAddress())

        const expectedStEth = expectedTreasuryStEth(
          NOMINAL_FEE_SHARES,
          newTreasuryFee,
          newModulesFee,
          INITIAL_POOLED_ETH_PER_SHARE
        )

        await expect(pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES))
          .to.emit(subject, 'RevenueAccumulatedInStEth')
          .withArgs(expectedStEth, expectedStEth)
      })

      it('should pick up the new lido address if the locator is upgraded', async function () {
        // Deploy a second stETH stub with a different share rate. After the locator is
        // retargeted, the contract must convert shares using the new lido's rate.
        const newRate = (INITIAL_POOLED_ETH_PER_SHARE * 105n) / 100n
        const newStEth = await new StEthSharesStub__factory(admin).deploy(newRate)
        await locatorStub.setLido(await newStEth.getAddress())

        const expectedStEth = expectedTreasuryStEth(
          NOMINAL_FEE_SHARES,
          TREASURY_FEE,
          MODULES_FEE,
          newRate
        )

        await expect(pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES))
          .to.emit(subject, 'RevenueAccumulatedInStEth')
          .withArgs(expectedStEth, expectedStEth)
      })
    })

    describe('zero-input fast paths:', function () {
      it('should be a no-op when sharesMintedAsFees is zero', async function () {
        await expect(pushSharesMinted(subject, notifier, 0n)).to.not.emit(
          subject,
          'RevenueAccumulatedInStEth'
        )
        expect(await subject.pendingRevenueStEth()).to.equal(0n)
      })

      it('should be a no-op when totalFee is zero (defensive branch)', async function () {
        await stakingRouterStub.setFeeDistribution(0n, 0n, BASE_PRECISION)

        await expect(pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)).to.not.emit(
          subject,
          'RevenueAccumulatedInStEth'
        )
        expect(await subject.pendingRevenueStEth()).to.equal(0n)
      })

      it('should emit RevenueAccumulatedInStEth(0, 0) when treasuryFee is zero but modulesFee is not', async function () {
        await stakingRouterStub.setFeeDistribution(MODULES_FEE, 0n, BASE_PRECISION)

        await expect(pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES))
          .to.emit(subject, 'RevenueAccumulatedInStEth')
          .withArgs(0n, 0n)
        expect(await subject.pendingRevenueStEth()).to.equal(0n)
      })
    })

    describe('arithmetic edges:', function () {
      it('should revert with Panic 0x11 when shares × treasuryFee overflows uint256', async function () {
        const max = 2n ** 256n - 1n
        await stakingRouterStub.setFeeDistribution(0n, 2n, BASE_PRECISION)

        await expect(pushSharesMinted(subject, notifier, max)).to.be.revertedWithPanic('0x11')
      })

      it('should handle a single-share fee mint without rounding to zero', async function () {
        await stakingRouterStub.setFeeDistribution(0n, TREASURY_FEE, BASE_PRECISION)
        await expect(pushSharesMinted(subject, notifier, 1n))
          .to.emit(subject, 'RevenueAccumulatedInStEth')
          .withArgs(1n, 1n)
      })
    })
  })

  describe('#convertPendingRevenueToUSD', function () {
    let snapshot: SnapshotRestorer

    beforeEach(async function () {
      snapshot = await takeSnapshot()
      subject = await deploySubject()
    })

    afterEach(async function () {
      await snapshot.restore()
    })

    describe('access control:', function () {
      it('should be permissionless: any caller can settle pending', async function () {
        await pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)
        await expect(subject.connect(stranger).convertPendingRevenueToUSD()).to.not.be.reverted
      })
    })

    describe('happy path:', function () {
      it('should convert pending to USD, append to cumulative, and reset pending', async function () {
        await pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)
        const pending = await subject.pendingRevenueStEth()
        const expectedUSD = expectedRevenueUSD(pending, STETH_USD_PRICE)

        await expect(subject.connect(stranger).convertPendingRevenueToUSD())
          .to.emit(subject, 'PendingRevenueConverted')
          .withArgs(pending, STETH_USD_PRICE, expectedUSD)
          .and.to.emit(subject, 'RevenueAdded')
          .withArgs(expectedUSD, expectedUSD)

        expect(await subject.getCumulativeRevenueUSD()).to.equal(expectedUSD)
        expect(await subject.pendingRevenueStEth()).to.equal(0n)
      })

      it('should aggregate multiple rebases into a single conversion', async function () {
        for (let i = 0; i < 3; i++) {
          await pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)
        }

        const pending = await subject.pendingRevenueStEth()
        const expectedUSD = expectedRevenueUSD(pending, STETH_USD_PRICE)

        await subject.connect(stranger).convertPendingRevenueToUSD()

        expect(await subject.getCumulativeRevenueUSD()).to.equal(expectedUSD)
        expect(await subject.pendingRevenueStEth()).to.equal(0n)
      })

      it('should use the current oracle price even if it moved since the rebases', async function () {
        await pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)
        const pending = await subject.pendingRevenueStEth()

        const newPrice = STETH_USD_PRICE / 2n
        await oracleStub.setUsdPrice(newPrice, newPrice)

        const expectedUSD = expectedRevenueUSD(pending, newPrice)
        await expect(subject.connect(stranger).convertPendingRevenueToUSD())
          .to.emit(subject, 'PendingRevenueConverted')
          .withArgs(pending, newPrice, expectedUSD)
      })

      it('should be repeatable: pushTokenRate → convert → pushTokenRate → convert', async function () {
        await pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)
        await subject.connect(stranger).convertPendingRevenueToUSD()
        const firstCumulative = await subject.getCumulativeRevenueUSD()

        await pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)
        await subject.connect(stranger).convertPendingRevenueToUSD()
        const secondCumulative = await subject.getCumulativeRevenueUSD()

        expect(secondCumulative).to.equal(firstCumulative * 2n)
        expect(await subject.pendingRevenueStEth()).to.equal(0n)
      })
    })

    describe('idle and degraded paths:', function () {
      it('should be a no-op when there is no pending revenue', async function () {
        await expect(subject.connect(stranger).convertPendingRevenueToUSD()).to.not.emit(
          subject,
          'PendingRevenueConverted'
        )
        await expect(subject.connect(stranger).convertPendingRevenueToUSD()).to.not.emit(
          subject,
          'RevenueAdded'
        )
        expect(await subject.getCumulativeRevenueUSD()).to.equal(0n)
      })

      it('should preserve pending and revert with OracleReturnedZeroPrice when oracle returns 0', async function () {
        await pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)
        const pendingBefore = await subject.pendingRevenueStEth()

        await oracleStub.setUsdPrice(0n, 0n)

        await expect(
          subject.connect(stranger).convertPendingRevenueToUSD()
        ).to.be.revertedWithCustomError(subject, 'OracleReturnedZeroPrice')

        expect(await subject.pendingRevenueStEth()).to.equal(pendingBefore)
        expect(await subject.getCumulativeRevenueUSD()).to.equal(0n)
      })

      it('should preserve pending when oracle reverts with a custom error', async function () {
        await pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)
        const pendingBefore = await subject.pendingRevenueStEth()

        await oracleStub.setFailureMode(OracleFailureMode.CustomError)

        await expect(subject.connect(stranger).convertPendingRevenueToUSD()).to.be.reverted
        expect(await subject.pendingRevenueStEth()).to.equal(pendingBefore)
        expect(await subject.getCumulativeRevenueUSD()).to.equal(0n)
      })

      it('should preserve pending when oracle reverts with empty data', async function () {
        await pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)
        const pendingBefore = await subject.pendingRevenueStEth()

        await oracleStub.setFailureMode(OracleFailureMode.EmptyRevert)

        await expect(subject.connect(stranger).convertPendingRevenueToUSD()).to.be.reverted
        expect(await subject.pendingRevenueStEth()).to.equal(pendingBefore)
      })

      it('should let the keeper retry successfully once the oracle recovers', async function () {
        await pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)

        await oracleStub.setFailureMode(OracleFailureMode.CustomError)
        await expect(subject.connect(stranger).convertPendingRevenueToUSD()).to.be.reverted

        await oracleStub.setFailureMode(OracleFailureMode.None)
        const pending = await subject.pendingRevenueStEth()
        const expectedUSD = expectedRevenueUSD(pending, STETH_USD_PRICE)

        await expect(subject.connect(stranger).convertPendingRevenueToUSD())
          .to.emit(subject, 'PendingRevenueConverted')
          .withArgs(pending, STETH_USD_PRICE, expectedUSD)

        expect(await subject.getCumulativeRevenueUSD()).to.equal(expectedUSD)
        expect(await subject.pendingRevenueStEth()).to.equal(0n)
      })
    })
  })

  describe('#supportsInterface', function () {
    let snapshot: SnapshotRestorer

    before(async function () {
      snapshot = await takeSnapshot()
      subject = await deploySubject()
    })

    after(async function () {
      await snapshot.restore()
    })

    it('should return true for IRevenueSource.interfaceId', async function () {
      // Single-function interface → interfaceId is the selector of getCumulativeRevenueUSD().
      const interfaceId = ethers.id('getCumulativeRevenueUSD()').substring(0, 10) as `0x${string}`
      expect(await subject.supportsInterface(interfaceId)).to.equal(true)
    })

    it('should return true for ITokenRatePusherWithArgs.interfaceId', async function () {
      const interfaceId = ethers
        .id('pushTokenRate(uint256,uint256,uint256,uint256,uint256,uint256,uint256)')
        .substring(0, 10) as `0x${string}`
      expect(await subject.supportsInterface(interfaceId)).to.equal(true)
    })

    it('should return true for IERC165.interfaceId', async function () {
      expect(await subject.supportsInterface('0x01ffc9a7')).to.equal(true)
    })

    it('should NOT return true for the no-arg ITokenRatePusher.interfaceId', async function () {
      const noArgInterfaceId = ethers.id('pushTokenRate()').substring(0, 10) as `0x${string}`
      expect(await subject.supportsInterface(noArgInterfaceId)).to.equal(false)
    })

    it('should return false for an unrelated interface id', async function () {
      expect(await subject.supportsInterface('0xdeadbeef')).to.equal(false)
    })
  })
})
