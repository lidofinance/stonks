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
} from '../../../typechain-types'

const DEFAULT_ADMIN_ROLE = ethers.ZeroHash
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
// call satisfies the 7-argument `ITokenRatePusher` signature.
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

const missingRoleRegex = (account: string, role: string) =>
  new RegExp(
    `AccessControl: account ${account.toLowerCase()} is missing role ${role.toLowerCase()}`
  )

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

  let admin: Signer
  let notifier: Signer
  let stranger: Signer

  let topSnapshot: SnapshotRestorer

  async function deployStubs(): Promise<{
    stEth: StEthSharesStub
    stakingRouter: StakingRouterStub
    oracle: OracleRouterUsdStub
  }> {
    const stEth = await new StEthSharesStub__factory(admin).deploy(INITIAL_POOLED_ETH_PER_SHARE)
    const stakingRouter = await new StakingRouterStub__factory(admin).deploy()
    const oracle = await new OracleRouterUsdStub__factory(admin).deploy()

    await stakingRouter.setFeeDistribution(MODULES_FEE, TREASURY_FEE, BASE_PRECISION)
    await oracle.setUsdPrice(STETH_USD_PRICE, STETH_USD_PRICE)

    return { stEth, stakingRouter, oracle }
  }

  async function deploySubject(
    overrides: {
      admin?: string
      oracleRouter?: string
      stEth?: string
      stakingRouter?: string
      tokenRateNotifier?: string
    } = {}
  ) {
    const instance = await factory.deploy(
      overrides.admin ?? (await admin.getAddress()),
      overrides.oracleRouter ?? (await oracleStub.getAddress()),
      overrides.stEth ?? (await stEthStub.getAddress()),
      overrides.stakingRouter ?? (await stakingRouterStub.getAddress()),
      overrides.tokenRateNotifier ?? (await notifier.getAddress())
    )
    await instance.waitForDeployment()
    return instance
  }

  before(async function () {
    topSnapshot = await takeSnapshot()
    ;[admin, notifier, stranger] = await ethers.getSigners()

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

    it('should revert with InvalidAdminAddress when admin_ is zero', async function () {
      await expect(deploySubject({ admin: ethers.ZeroAddress }))
        .to.be.revertedWithCustomError(factory, 'InvalidAdminAddress')
        .withArgs(ethers.ZeroAddress)
    })

    it('should revert with InvalidOracleRouterAddress when oracle is zero', async function () {
      await expect(deploySubject({ oracleRouter: ethers.ZeroAddress }))
        .to.be.revertedWithCustomError(factory, 'InvalidOracleRouterAddress')
        .withArgs(ethers.ZeroAddress)
    })

    it('should revert with InvalidStEthAddress when stEth is zero', async function () {
      await expect(deploySubject({ stEth: ethers.ZeroAddress }))
        .to.be.revertedWithCustomError(factory, 'InvalidStEthAddress')
        .withArgs(ethers.ZeroAddress)
    })

    it('should revert with InvalidStakingRouterAddress when staking router is zero', async function () {
      await expect(deploySubject({ stakingRouter: ethers.ZeroAddress }))
        .to.be.revertedWithCustomError(factory, 'InvalidStakingRouterAddress')
        .withArgs(ethers.ZeroAddress)
    })

    it('should revert with InvalidTokenRateNotifierAddress when notifier is zero', async function () {
      await expect(deploySubject({ tokenRateNotifier: ethers.ZeroAddress }))
        .to.be.revertedWithCustomError(factory, 'InvalidTokenRateNotifierAddress')
        .withArgs(ethers.ZeroAddress)
    })

    it('should expose REPORTER_ROLE as the namespaced keccak hash', async function () {
      const expected = ethers.keccak256(
        ethers.toUtf8Bytes('NEST.StakingRevenueSource.REPORTER_ROLE')
      )
      expect(await subject.REPORTER_ROLE()).to.equal(expected)
    })

    it('should store all external-dependency addresses as immutables', async function () {
      expect(await subject.ORACLE_ROUTER()).to.equal(await oracleStub.getAddress())
      expect(await subject.STETH()).to.equal(await stEthStub.getAddress())
      expect(await subject.STAKING_ROUTER()).to.equal(await stakingRouterStub.getAddress())
    })

    it('should cache PRICE_SCALE from the OracleRouter at construction', async function () {
      expect(await subject.PRICE_SCALE()).to.equal(await oracleStub.PRICE_UNIT())
    })

    it('should grant DEFAULT_ADMIN_ROLE to admin_', async function () {
      expect(await subject.hasRole(DEFAULT_ADMIN_ROLE, await admin.getAddress())).to.equal(true)
    })

    it('should grant REPORTER_ROLE to tokenRateNotifier_', async function () {
      const reporterRole = await subject.REPORTER_ROLE()
      expect(await subject.hasRole(reporterRole, await notifier.getAddress())).to.equal(true)
    })

    it('should NOT grant REPORTER_ROLE to admin_', async function () {
      const reporterRole = await subject.REPORTER_ROLE()
      expect(await subject.hasRole(reporterRole, await admin.getAddress())).to.equal(false)
    })

    it('should register exactly one REPORTER_ROLE member', async function () {
      const reporterRole = await subject.REPORTER_ROLE()
      expect(await subject.getRoleMemberCount(reporterRole)).to.equal(1n)
      expect(await subject.getRoleMember(reporterRole, 0n)).to.equal(await notifier.getAddress())
    })

    it('should initialize cumulative and pending accumulators at zero', async function () {
      expect(await subject.getCumulativeRevenueUSD()).to.equal(0n)
      expect(await subject.getPendingRevenueStEth()).to.equal(0n)
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

    describe('access control:', function () {
      it('should revert when called by admin lacking REPORTER_ROLE', async function () {
        const adminAddr = await admin.getAddress()
        const reporterRole = await subject.REPORTER_ROLE()
        await expect(pushSharesMinted(subject, admin, NOMINAL_FEE_SHARES)).to.be.revertedWith(
          missingRoleRegex(adminAddr, reporterRole)
        )
      })

      it('should revert when called by an unrelated stranger', async function () {
        const strangerAddr = await stranger.getAddress()
        const reporterRole = await subject.REPORTER_ROLE()
        await expect(pushSharesMinted(subject, stranger, NOMINAL_FEE_SHARES)).to.be.revertedWith(
          missingRoleRegex(strangerAddr, reporterRole)
        )
      })

      it('should revert after REPORTER_ROLE is revoked from the notifier', async function () {
        const notifierAddr = await notifier.getAddress()
        const reporterRole = await subject.REPORTER_ROLE()

        await pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)
        await subject.connect(admin).revokeRole(reporterRole, notifierAddr)

        await expect(pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)).to.be.revertedWith(
          missingRoleRegex(notifierAddr, reporterRole)
        )
      })
    })

    describe('happy path:', function () {
      it('should accumulate treasury stETH into the pending bucket and emit RevenueAccumulatedInStEth', async function () {
        const expectedStEth = nominalTreasuryStEth()

        await expect(pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES))
          .to.emit(subject, 'RevenueAccumulatedInStEth')
          .withArgs(expectedStEth, expectedStEth)

        expect(await subject.getPendingRevenueStEth()).to.equal(expectedStEth)
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
        expect(await subject.getPendingRevenueStEth()).to.equal(nominalTreasuryStEth())
      })

      it('should sum pending across consecutive rebases', async function () {
        const perPushStEth = nominalTreasuryStEth()

        await pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)
        await pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)
        await pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)

        expect(await subject.getPendingRevenueStEth()).to.equal(perPushStEth * 3n)
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
    })

    describe('zero-input fast paths:', function () {
      it('should be a no-op when sharesMintedAsFees is zero', async function () {
        await expect(pushSharesMinted(subject, notifier, 0n)).to.not.emit(
          subject,
          'RevenueAccumulatedInStEth'
        )
        expect(await subject.getPendingRevenueStEth()).to.equal(0n)
      })

      it('should be a no-op when totalFee is zero (defensive branch)', async function () {
        await stakingRouterStub.setFeeDistribution(0n, 0n, BASE_PRECISION)

        await expect(pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)).to.not.emit(
          subject,
          'RevenueAccumulatedInStEth'
        )
        expect(await subject.getPendingRevenueStEth()).to.equal(0n)
      })

      it('should emit RevenueAccumulatedInStEth(0, 0) when treasuryFee is zero but modulesFee is not', async function () {
        await stakingRouterStub.setFeeDistribution(MODULES_FEE, 0n, BASE_PRECISION)

        await expect(pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES))
          .to.emit(subject, 'RevenueAccumulatedInStEth')
          .withArgs(0n, 0n)
        expect(await subject.getPendingRevenueStEth()).to.equal(0n)
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
        const pending = await subject.getPendingRevenueStEth()
        const expectedUSD = expectedRevenueUSD(pending, STETH_USD_PRICE)

        await expect(subject.connect(stranger).convertPendingRevenueToUSD())
          .to.emit(subject, 'PendingRevenueConverted')
          .withArgs(pending, STETH_USD_PRICE, expectedUSD)
          .and.to.emit(subject, 'RevenueAdded')
          .withArgs(expectedUSD, expectedUSD)

        expect(await subject.getCumulativeRevenueUSD()).to.equal(expectedUSD)
        expect(await subject.getPendingRevenueStEth()).to.equal(0n)
      })

      it('should aggregate multiple rebases into a single conversion', async function () {
        for (let i = 0; i < 3; i++) {
          await pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)
        }

        const pending = await subject.getPendingRevenueStEth()
        const expectedUSD = expectedRevenueUSD(pending, STETH_USD_PRICE)

        await subject.connect(stranger).convertPendingRevenueToUSD()

        expect(await subject.getCumulativeRevenueUSD()).to.equal(expectedUSD)
        expect(await subject.getPendingRevenueStEth()).to.equal(0n)
      })

      it('should use the current oracle price even if it moved since the rebases', async function () {
        await pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)
        const pending = await subject.getPendingRevenueStEth()

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
        expect(await subject.getPendingRevenueStEth()).to.equal(0n)
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
        const pendingBefore = await subject.getPendingRevenueStEth()

        await oracleStub.setUsdPrice(0n, 0n)

        await expect(
          subject.connect(stranger).convertPendingRevenueToUSD()
        ).to.be.revertedWithCustomError(subject, 'OracleReturnedZeroPrice')

        expect(await subject.getPendingRevenueStEth()).to.equal(pendingBefore)
        expect(await subject.getCumulativeRevenueUSD()).to.equal(0n)
      })

      it('should preserve pending when oracle reverts with a custom error', async function () {
        await pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)
        const pendingBefore = await subject.getPendingRevenueStEth()

        await oracleStub.setFailureMode(OracleFailureMode.CustomError)

        await expect(subject.connect(stranger).convertPendingRevenueToUSD()).to.be.reverted
        expect(await subject.getPendingRevenueStEth()).to.equal(pendingBefore)
        expect(await subject.getCumulativeRevenueUSD()).to.equal(0n)
      })

      it('should preserve pending when oracle reverts with empty data', async function () {
        await pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)
        const pendingBefore = await subject.getPendingRevenueStEth()

        await oracleStub.setFailureMode(OracleFailureMode.EmptyRevert)

        await expect(subject.connect(stranger).convertPendingRevenueToUSD()).to.be.reverted
        expect(await subject.getPendingRevenueStEth()).to.equal(pendingBefore)
      })

      it('should let the keeper retry successfully once the oracle recovers', async function () {
        await pushSharesMinted(subject, notifier, NOMINAL_FEE_SHARES)

        await oracleStub.setFailureMode(OracleFailureMode.CustomError)
        await expect(subject.connect(stranger).convertPendingRevenueToUSD()).to.be.reverted

        await oracleStub.setFailureMode(OracleFailureMode.None)
        const pending = await subject.getPendingRevenueStEth()
        const expectedUSD = expectedRevenueUSD(pending, STETH_USD_PRICE)

        await expect(subject.connect(stranger).convertPendingRevenueToUSD())
          .to.emit(subject, 'PendingRevenueConverted')
          .withArgs(pending, STETH_USD_PRICE, expectedUSD)

        expect(await subject.getCumulativeRevenueUSD()).to.equal(expectedUSD)
        expect(await subject.getPendingRevenueStEth()).to.equal(0n)
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

    it('should return true for ITokenRatePusher.interfaceId', async function () {
      const interfaceId = ethers
        .id(
          'pushTokenRate(uint256,uint256,uint256,uint256,uint256,uint256,uint256)'
        )
        .substring(0, 10) as `0x${string}`
      expect(await subject.supportsInterface(interfaceId)).to.equal(true)
    })

    it('should return true for the inherited IAccessControl.interfaceId', async function () {
      // OZ v4.9.3 AccessControl returns `true` for its own interfaceId (0x7965db0b).
      const interfaceId = '0x7965db0b'
      expect(await subject.supportsInterface(interfaceId)).to.equal(true)
    })

    it('should return true for the inherited IAccessControlEnumerable.interfaceId', async function () {
      // XOR of getRoleMember(bytes32,uint256) and getRoleMemberCount(bytes32) selectors.
      const interfaceId = '0x5a05180f'
      expect(await subject.supportsInterface(interfaceId)).to.equal(true)
    })

    it('should return true for IERC165.interfaceId', async function () {
      const interfaceId = '0x01ffc9a7'
      expect(await subject.supportsInterface(interfaceId)).to.equal(true)
    })

    it('should return false for an unrelated interface id', async function () {
      const interfaceId = '0xdeadbeef'
      expect(await subject.supportsInterface(interfaceId)).to.equal(false)
    })
  })

})
