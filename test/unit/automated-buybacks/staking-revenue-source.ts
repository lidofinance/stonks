import { ethers } from 'hardhat'
import { expect } from 'chai'
import { Signer } from 'ethers'
import { time, takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'

import {
  StakingRevenueSource,
  StakingRevenueSource__factory,
  WstEthRateStub,
  WstEthRateStub__factory,
  StEthSharesStub,
  StEthSharesStub__factory,
  StakingRouterStub,
  StakingRouterStub__factory,
  OracleRouterUsdStub,
  OracleRouterUsdStub__factory,
} from '../../../typechain-types'
import { TIME_CONSTANTS } from '../../helpers/test-constants'

const DEFAULT_ADMIN_ROLE = ethers.ZeroHash
const EMERGENCY_ROLE = ethers.keccak256(ethers.toUtf8Bytes('EMERGENCY_ROLE'))
const REPORTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('REPORTER_ROLE'))

const STALENESS_WINDOW_SECONDS = BigInt(TIME_CONSTANTS.ONE_DAY_SECONDS)
const ONE_DAY = BigInt(TIME_CONSTANTS.ONE_DAY_SECONDS)

const TOKEN_RATE_SCALE = 10n ** 27n
const PRICE_SCALE = 10n ** 18n

const BASE_PRECISION = 10_000n
const MODULES_FEE = 500n
const TREASURY_FEE = 500n

const INITIAL_RATE = TOKEN_RATE_SCALE // 1.0 stETH per wstETH
const POSITIVE_REBASE_RATE = (TOKEN_RATE_SCALE * 101n) / 100n // +1%
const NEGATIVE_REBASE_RATE = (TOKEN_RATE_SCALE * 99n) / 100n // -1%

const INTERNAL_SHARES = 10n ** 24n // 1M shares worth of stETH
const EXTERNAL_SHARES = 0n
const TOTAL_SHARES = INTERNAL_SHARES + EXTERNAL_SHARES

const STETH_USD_PRICE = ethers.parseEther('3500') // $3500 per stETH, 1e18-scaled

const missingRoleRegex = (account: string, role: string) =>
  new RegExp(
    `AccessControl: account ${account.toLowerCase()} is missing role ${role.toLowerCase()}`
  )

function expectedRevenueStEth(
  rateDelta: bigint,
  internalShares: bigint,
  treasuryFee: bigint,
  modulesFee: bigint,
  basePrecision: bigint
): bigint {
  const totalFee = modulesFee + treasuryFee
  return (
    (rateDelta * internalShares * treasuryFee) / (TOKEN_RATE_SCALE * (basePrecision - totalFee))
  )
}

function expectedRevenueUSD(revenueStEth: bigint, stEthUsdPrice: bigint): bigint {
  return (revenueStEth * stEthUsdPrice) / PRICE_SCALE
}

describe('StakingRevenueSource', function () {
  let factory: StakingRevenueSource__factory
  let subject: StakingRevenueSource
  let wstEthStub: WstEthRateStub
  let stEthStub: StEthSharesStub
  let stakingRouterStub: StakingRouterStub
  let oracleStub: OracleRouterUsdStub

  let admin: Signer
  let notifier: Signer
  let stranger: Signer
  let emergency: Signer

  let topSnapshot: SnapshotRestorer

  async function deployStubs(): Promise<{
    wstEth: WstEthRateStub
    stEth: StEthSharesStub
    stakingRouter: StakingRouterStub
    oracle: OracleRouterUsdStub
  }> {
    const wstEth = await new WstEthRateStub__factory(admin).deploy(INITIAL_RATE)
    const stEth = await new StEthSharesStub__factory(admin).deploy()
    const stakingRouter = await new StakingRouterStub__factory(admin).deploy()
    const oracle = await new OracleRouterUsdStub__factory(admin).deploy()

    await stEth.setShares(TOTAL_SHARES, EXTERNAL_SHARES)
    await stakingRouter.setFeeDistribution(MODULES_FEE, TREASURY_FEE, BASE_PRECISION)
    await oracle.setUsdPrice(STETH_USD_PRICE, STETH_USD_PRICE)

    return { wstEth, stEth, stakingRouter, oracle }
  }

  async function deploySubject(overrides: {
    admin?: string
    staleness?: bigint
    oracleRouter?: string
    stEth?: string
    wstEth?: string
    stakingRouter?: string
    tokenRateNotifier?: string
  } = {}) {
    const instance = await factory.deploy(
      overrides.admin ?? (await admin.getAddress()),
      overrides.staleness ?? STALENESS_WINDOW_SECONDS,
      overrides.oracleRouter ?? (await oracleStub.getAddress()),
      overrides.stEth ?? (await stEthStub.getAddress()),
      overrides.wstEth ?? (await wstEthStub.getAddress()),
      overrides.stakingRouter ?? (await stakingRouterStub.getAddress()),
      overrides.tokenRateNotifier ?? (await notifier.getAddress())
    )
    await instance.waitForDeployment()
    return instance
  }

  before(async function () {
    topSnapshot = await takeSnapshot()
    ;[admin, notifier, stranger, emergency] = await ethers.getSigners()

    factory = await ethers.getContractFactory('StakingRevenueSource')
  })

  after(async function () {
    await topSnapshot.restore()
  })

  beforeEach(async function () {
    const stubs = await deployStubs()
    wstEthStub = stubs.wstEth
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

    it('should revert with InvalidStalenessWindow when staleness is zero', async function () {
      await expect(deploySubject({ staleness: 0n }))
        .to.be.revertedWithCustomError(factory, 'InvalidStalenessWindow')
        .withArgs(0n)
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

    it('should revert with InvalidWstEthAddress when wstEth is zero', async function () {
      await expect(deploySubject({ wstEth: ethers.ZeroAddress }))
        .to.be.revertedWithCustomError(factory, 'InvalidWstEthAddress')
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

    it('should expose REPORTER_ROLE as keccak256("REPORTER_ROLE")', async function () {
      expect(await subject.REPORTER_ROLE()).to.equal(REPORTER_ROLE)
    })

    it('should store all external-dependency addresses as immutables', async function () {
      expect(await subject.ORACLE_ROUTER()).to.equal(await oracleStub.getAddress())
      expect(await subject.STETH()).to.equal(await stEthStub.getAddress())
      expect(await subject.WSTETH()).to.equal(await wstEthStub.getAddress())
      expect(await subject.STAKING_ROUTER()).to.equal(await stakingRouterStub.getAddress())
    })

    it('should store the provided staleness window via the base class', async function () {
      expect(await subject.STALENESS_WINDOW_SECONDS()).to.equal(STALENESS_WINDOW_SECONDS)
    })

    it('should grant DEFAULT_ADMIN_ROLE to admin_', async function () {
      expect(await subject.hasRole(DEFAULT_ADMIN_ROLE, await admin.getAddress())).to.equal(true)
    })

    it('should grant REPORTER_ROLE to tokenRateNotifier_', async function () {
      expect(await subject.hasRole(REPORTER_ROLE, await notifier.getAddress())).to.equal(true)
    })

    it('should NOT grant REPORTER_ROLE to admin_', async function () {
      expect(await subject.hasRole(REPORTER_ROLE, await admin.getAddress())).to.equal(false)
    })

    it('should NOT grant EMERGENCY_ROLE to admin_ at construction', async function () {
      expect(await subject.hasRole(EMERGENCY_ROLE, await admin.getAddress())).to.equal(false)
    })

    it('should register exactly one REPORTER_ROLE member', async function () {
      expect(await subject.getRoleMemberCount(REPORTER_ROLE)).to.equal(1n)
      expect(await subject.getRoleMember(REPORTER_ROLE, 0n)).to.equal(await notifier.getAddress())
    })

    it('should initialize storage with zero revenue, zero timestamp, and stale flag', async function () {
      const [revenueUSD, reportTimestamp, isStale] = await subject.getRevenue()
      expect(revenueUSD).to.equal(0n)
      expect(reportTimestamp).to.equal(0n)
      expect(isStale).to.equal(true)
    })

    it('should deploy in the unpaused state', async function () {
      expect(await subject.paused()).to.equal(false)
    })

    it('should seed _lastStEthPerToken from the live wstETH rate', async function () {
      // Observed indirectly: if the baseline were not seeded from live rate, a same-rate
      // pushTokenRate would underflow or compute non-zero revenue. It stores zero.
      await subject.connect(notifier).pushTokenRate()
      const [revenueUSD] = await subject.getRevenue()
      expect(revenueUSD).to.equal(0n)
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

    describe('access control & modifiers:', function () {
      it('should revert when called by admin lacking REPORTER_ROLE', async function () {
        const adminAddr = await admin.getAddress()
        await expect(subject.connect(admin).pushTokenRate()).to.be.revertedWith(
          missingRoleRegex(adminAddr, REPORTER_ROLE)
        )
      })

      it('should revert when called by an unrelated stranger', async function () {
        const strangerAddr = await stranger.getAddress()
        await expect(subject.connect(stranger).pushTokenRate()).to.be.revertedWith(
          missingRoleRegex(strangerAddr, REPORTER_ROLE)
        )
      })

      it('should revert after REPORTER_ROLE is revoked from the notifier', async function () {
        // Sanity: notifier starts able to call.
        await subject.connect(notifier).pushTokenRate()

        const notifierAddr = await notifier.getAddress()
        await subject.connect(admin).revokeRole(REPORTER_ROLE, notifierAddr)

        await expect(subject.connect(notifier).pushTokenRate()).to.be.revertedWith(
          missingRoleRegex(notifierAddr, REPORTER_ROLE)
        )
      })

      it('should revert with "Pausable: paused" when the contract is paused', async function () {
        await subject.connect(admin).grantRole(EMERGENCY_ROLE, await emergency.getAddress())
        await subject.connect(emergency).pause()

        await expect(subject.connect(notifier).pushTokenRate()).to.be.revertedWith(
          'Pausable: paused'
        )
      })
    })

    describe('fee-distribution arithmetic guards:', function () {
      it('should revert with Panic 0x12 when totalFee equals basePrecision', async function () {
        await wstEthStub.setStEthPerToken(POSITIVE_REBASE_RATE)
        await stakingRouterStub.setFeeDistribution(
          BASE_PRECISION / 2n,
          BASE_PRECISION / 2n,
          BASE_PRECISION
        )

        await expect(subject.connect(notifier).pushTokenRate()).to.be.revertedWithPanic('0x12')
      })

      it('should revert with Panic 0x11 when totalFee exceeds basePrecision', async function () {
        await wstEthStub.setStEthPerToken(POSITIVE_REBASE_RATE)
        await stakingRouterStub.setFeeDistribution(
          BASE_PRECISION,
          BASE_PRECISION,
          BASE_PRECISION
        )

        await expect(subject.connect(notifier).pushTokenRate()).to.be.revertedWithPanic('0x11')
      })

      it('should revert with Panic 0x11 when externalShares exceed totalShares', async function () {
        await wstEthStub.setStEthPerToken(POSITIVE_REBASE_RATE)
        await stEthStub.setShares(INTERNAL_SHARES, INTERNAL_SHARES + 1n)

        await expect(subject.connect(notifier).pushTokenRate()).to.be.revertedWithPanic('0x11')
      })
    })

    describe('positive delta:', function () {
      it('should store the back-derived daily revenue via _updateRevenue', async function () {
        await wstEthStub.setStEthPerToken(POSITIVE_REBASE_RATE)

        const rateDelta = POSITIVE_REBASE_RATE - INITIAL_RATE
        const expectedStEth = expectedRevenueStEth(
          rateDelta,
          INTERNAL_SHARES,
          TREASURY_FEE,
          MODULES_FEE,
          BASE_PRECISION
        )
        const expectedUSD = expectedRevenueUSD(expectedStEth, STETH_USD_PRICE)

        const tx = await subject.connect(notifier).pushTokenRate()
        const receipt = await tx.wait()
        const reportTs = BigInt((await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp)

        const [revenueUSD, reportTimestamp, isStale] = await subject.getRevenue()
        // First report → base class stores raw (no normalization).
        expect(revenueUSD).to.equal(expectedUSD)
        expect(reportTimestamp).to.equal(reportTs)
        expect(isStale).to.equal(false)
      })

      it('should emit RevenueUpdated with the raw USD value on the first positive report', async function () {
        await wstEthStub.setStEthPerToken(POSITIVE_REBASE_RATE)

        const rateDelta = POSITIVE_REBASE_RATE - INITIAL_RATE
        const expectedStEth = expectedRevenueStEth(
          rateDelta,
          INTERNAL_SHARES,
          TREASURY_FEE,
          MODULES_FEE,
          BASE_PRECISION
        )
        const expectedUSD = expectedRevenueUSD(expectedStEth, STETH_USD_PRICE)

        const nextTs = BigInt(await time.latest()) + 100n
        await time.setNextBlockTimestamp(nextTs)

        await expect(subject.connect(notifier).pushTokenRate())
          .to.emit(subject, 'RevenueUpdated')
          .withArgs(expectedUSD, nextTs)
      })

      it('should advance the baseline so the next delta is measured from the new rate', async function () {
        await wstEthStub.setStEthPerToken(POSITIVE_REBASE_RATE)
        await subject.connect(notifier).pushTokenRate()

        // Second positive rebase from the post-rebase rate.
        const secondRate = (POSITIVE_REBASE_RATE * 1005n) / 1000n // +0.5%
        await wstEthStub.setStEthPerToken(secondRate)

        const nextTs = BigInt(await time.latest()) + 2n * ONE_DAY
        await time.setNextBlockTimestamp(nextTs)

        const rateDelta = secondRate - POSITIVE_REBASE_RATE
        const expectedStEth = expectedRevenueStEth(
          rateDelta,
          INTERNAL_SHARES,
          TREASURY_FEE,
          MODULES_FEE,
          BASE_PRECISION
        )
        const rawUSD = expectedRevenueUSD(expectedStEth, STETH_USD_PRICE)

        // Base class normalizes raw USD over the elapsed period to a daily rate.
        const prevTs = (await subject.getRevenue())[1]
        const periodSeconds = nextTs - prevTs
        const expectedDailyUSD = (rawUSD * ONE_DAY) / periodSeconds

        await expect(subject.connect(notifier).pushTokenRate())
          .to.emit(subject, 'RevenueUpdated')
          .withArgs(expectedDailyUSD, nextTs)
      })

      it('should yield zero revenue when internal shares are zero', async function () {
        await stEthStub.setShares(TOTAL_SHARES, TOTAL_SHARES) // all external
        await wstEthStub.setStEthPerToken(POSITIVE_REBASE_RATE)

        const nextTs = BigInt(await time.latest()) + 100n
        await time.setNextBlockTimestamp(nextTs)

        await expect(subject.connect(notifier).pushTokenRate())
          .to.emit(subject, 'RevenueUpdated')
          .withArgs(0n, nextTs)
      })

      it('should yield zero revenue when treasuryFee is zero', async function () {
        await stakingRouterStub.setFeeDistribution(MODULES_FEE, 0n, BASE_PRECISION)
        await wstEthStub.setStEthPerToken(POSITIVE_REBASE_RATE)

        const nextTs = BigInt(await time.latest()) + 100n
        await time.setNextBlockTimestamp(nextTs)

        await expect(subject.connect(notifier).pushTokenRate())
          .to.emit(subject, 'RevenueUpdated')
          .withArgs(0n, nextTs)
      })

      it('should yield zero revenue when the stETH USD price is zero', async function () {
        await oracleStub.setUsdPrice(0n, 0n)
        await wstEthStub.setStEthPerToken(POSITIVE_REBASE_RATE)

        const nextTs = BigInt(await time.latest()) + 100n
        await time.setNextBlockTimestamp(nextTs)

        await expect(subject.connect(notifier).pushTokenRate())
          .to.emit(subject, 'RevenueUpdated')
          .withArgs(0n, nextTs)
      })

      it('should exclude external shares from the revenue derivation', async function () {
        const externalShares = INTERNAL_SHARES / 2n
        const totalShares = INTERNAL_SHARES + externalShares
        await stEthStub.setShares(totalShares, externalShares)
        await wstEthStub.setStEthPerToken(POSITIVE_REBASE_RATE)

        const rateDelta = POSITIVE_REBASE_RATE - INITIAL_RATE
        const expectedStEth = expectedRevenueStEth(
          rateDelta,
          INTERNAL_SHARES,
          TREASURY_FEE,
          MODULES_FEE,
          BASE_PRECISION
        )
        const rawUSD = expectedRevenueUSD(expectedStEth, STETH_USD_PRICE)

        const nextTs = BigInt(await time.latest()) + 100n
        await time.setNextBlockTimestamp(nextTs)

        await expect(subject.connect(notifier).pushTokenRate())
          .to.emit(subject, 'RevenueUpdated')
          .withArgs(rawUSD, nextTs)
      })
    })

    describe('zero delta:', function () {
      it('should emit RevenueUpdated(0, block.timestamp) when the rate is unchanged', async function () {
        const nextTs = BigInt(await time.latest()) + 100n
        await time.setNextBlockTimestamp(nextTs)

        await expect(subject.connect(notifier).pushTokenRate())
          .to.emit(subject, 'RevenueUpdated')
          .withArgs(0n, nextTs)
      })

      it('should not advance the baseline on a zero delta', async function () {
        await subject.connect(notifier).pushTokenRate()

        // Subsequent positive rebase should be measured from the original seed rate.
        await wstEthStub.setStEthPerToken(POSITIVE_REBASE_RATE)
        const rateDelta = POSITIVE_REBASE_RATE - INITIAL_RATE
        const expectedStEth = expectedRevenueStEth(
          rateDelta,
          INTERNAL_SHARES,
          TREASURY_FEE,
          MODULES_FEE,
          BASE_PRECISION
        )
        const rawUSD = expectedRevenueUSD(expectedStEth, STETH_USD_PRICE)

        const nextTs = BigInt(await time.latest()) + ONE_DAY
        await time.setNextBlockTimestamp(nextTs)

        const prevTs = (await subject.getRevenue())[1]
        const periodSeconds = nextTs - prevTs
        const expectedDailyUSD = (rawUSD * ONE_DAY) / periodSeconds

        await expect(subject.connect(notifier).pushTokenRate())
          .to.emit(subject, 'RevenueUpdated')
          .withArgs(expectedDailyUSD, nextTs)
      })

      it('should refresh the staleness timer even on a zero delta', async function () {
        await time.increase(STALENESS_WINDOW_SECONDS * 2n)

        const nextTs = BigInt(await time.latest()) + 10n
        await time.setNextBlockTimestamp(nextTs)

        await subject.connect(notifier).pushTokenRate()

        const [, , isStale] = await subject.getRevenue()
        expect(isStale).to.equal(false)
      })
    })

    describe('negative delta:', function () {
      it('should emit RevenueUpdated(0, block.timestamp) when the rate dropped', async function () {
        await wstEthStub.setStEthPerToken(NEGATIVE_REBASE_RATE)

        const nextTs = BigInt(await time.latest()) + 100n
        await time.setNextBlockTimestamp(nextTs)

        await expect(subject.connect(notifier).pushTokenRate())
          .to.emit(subject, 'RevenueUpdated')
          .withArgs(0n, nextTs)
      })

      it('should keep the pre-slash baseline so the deficit accumulates until full recovery', async function () {
        // Positive rebase establishes a post-earning baseline.
        await wstEthStub.setStEthPerToken(POSITIVE_REBASE_RATE)
        await subject.connect(notifier).pushTokenRate()

        // Slashing drops the rate below the baseline — no revenue, baseline frozen.
        await wstEthStub.setStEthPerToken(NEGATIVE_REBASE_RATE)
        await subject.connect(notifier).pushTokenRate()

        // Partial recovery below the pre-slash baseline — still zero revenue, baseline frozen.
        const partialRate = (POSITIVE_REBASE_RATE * 999n) / 1000n // just below baseline
        await wstEthStub.setStEthPerToken(partialRate)
        const partialTs = BigInt(await time.latest()) + 100n
        await time.setNextBlockTimestamp(partialTs)
        await expect(subject.connect(notifier).pushTokenRate())
          .to.emit(subject, 'RevenueUpdated')
          .withArgs(0n, partialTs)

        // Full recovery past the baseline yields revenue only on the excess over POSITIVE_REBASE_RATE.
        const recoveryRate = (POSITIVE_REBASE_RATE * 1005n) / 1000n
        await wstEthStub.setStEthPerToken(recoveryRate)

        const rateDelta = recoveryRate - POSITIVE_REBASE_RATE
        const expectedStEth = expectedRevenueStEth(
          rateDelta,
          INTERNAL_SHARES,
          TREASURY_FEE,
          MODULES_FEE,
          BASE_PRECISION
        )
        const rawUSD = expectedRevenueUSD(expectedStEth, STETH_USD_PRICE)

        const nextTs = BigInt(await time.latest()) + 200n
        await time.setNextBlockTimestamp(nextTs)

        const prevTs = (await subject.getRevenue())[1]
        const periodSeconds = nextTs - prevTs
        const expectedDailyUSD = (rawUSD * ONE_DAY) / periodSeconds

        await expect(subject.connect(notifier).pushTokenRate())
          .to.emit(subject, 'RevenueUpdated')
          .withArgs(expectedDailyUSD, nextTs)
      })

      it('should refresh the staleness timer on a negative delta', async function () {
        await wstEthStub.setStEthPerToken(NEGATIVE_REBASE_RATE)
        await time.increase(STALENESS_WINDOW_SECONDS * 2n)

        const nextTs = BigInt(await time.latest()) + 10n
        await time.setNextBlockTimestamp(nextTs)

        await subject.connect(notifier).pushTokenRate()

        const [, , isStale] = await subject.getRevenue()
        expect(isStale).to.equal(false)
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
      // Single-function interface — interfaceId is the bare selector of pushTokenRate().
      const interfaceId = '0xa16ba44d'
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

  describe('invariants:', function () {
    let snapshot: SnapshotRestorer

    beforeEach(async function () {
      snapshot = await takeSnapshot()
      subject = await deploySubject()
    })

    afterEach(async function () {
      await snapshot.restore()
    })

    it('invariant: baseline advances only on strictly positive deltas', async function () {
      // Zero delta does not advance baseline.
      await subject.connect(notifier).pushTokenRate()

      // Verify: baseline is still INITIAL_RATE. A rate at INITIAL_RATE would again trigger the
      // zero-delta path. We confirm indirectly by taking the "<=" branch again.
      await expect(subject.connect(notifier).pushTokenRate()).to.emit(subject, 'RevenueUpdated')

      // Positive delta advances baseline.
      await wstEthStub.setStEthPerToken(POSITIVE_REBASE_RATE)
      await subject.connect(notifier).pushTokenRate()

      // Revert to the pre-positive rate — must now be treated as negative (<= new baseline).
      await wstEthStub.setStEthPerToken(INITIAL_RATE)

      const nextTs = BigInt(await time.latest()) + 100n
      await time.setNextBlockTimestamp(nextTs)
      await expect(subject.connect(notifier).pushTokenRate())
        .to.emit(subject, 'RevenueUpdated')
        .withArgs(0n, nextTs)
    })

    it('invariant: only the notifier address can drive pushTokenRate under default config', async function () {
      expect(await subject.getRoleMemberCount(REPORTER_ROLE)).to.equal(1n)

      for (const signer of [admin, stranger, emergency]) {
        const addr = await signer.getAddress()
        await expect(subject.connect(signer).pushTokenRate()).to.be.revertedWith(
          missingRoleRegex(addr, REPORTER_ROLE)
        )
      }
    })

    it('invariant: pause window blocks pushTokenRate but preserves last reported state', async function () {
      // Seed one positive report, then pause.
      await wstEthStub.setStEthPerToken(POSITIVE_REBASE_RATE)
      await subject.connect(notifier).pushTokenRate()
      const [revenueBefore, tsBefore] = await subject.getRevenue()

      await subject.connect(admin).grantRole(EMERGENCY_ROLE, await emergency.getAddress())
      await subject.connect(emergency).pause()

      // Rebase continues off-chain, but the source refuses to update.
      await wstEthStub.setStEthPerToken((POSITIVE_REBASE_RATE * 102n) / 100n)
      await expect(subject.connect(notifier).pushTokenRate()).to.be.revertedWith('Pausable: paused')

      const [revenueAfter, tsAfter] = await subject.getRevenue()
      expect(revenueAfter).to.equal(revenueBefore)
      expect(tsAfter).to.equal(tsBefore)

      // After unpause, the source catches up using the cumulative delta from the preserved baseline.
      await subject.connect(emergency).unpause()
      const nextTs = BigInt(await time.latest()) + 100n
      await time.setNextBlockTimestamp(nextTs)
      await expect(subject.connect(notifier).pushTokenRate()).to.emit(subject, 'RevenueUpdated')
    })
  })
})
