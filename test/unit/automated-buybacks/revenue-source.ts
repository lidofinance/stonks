import { ethers } from 'hardhat'
import { expect } from 'chai'
import { Signer } from 'ethers'
import { time, takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'

import { RevenueSourceHarness, RevenueSourceHarness__factory } from '../../../typechain-types'
import { getContracts } from '../../../utils/contracts'
import { TIME_CONSTANTS } from '../../helpers/test-constants'

const contracts = getContracts()

const DEFAULT_ADMIN_ROLE = ethers.ZeroHash
const EMERGENCY_ROLE = ethers.keccak256(ethers.toUtf8Bytes('EMERGENCY_ROLE'))
const MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('MANAGER_ROLE'))

const STALENESS_WINDOW_SECONDS = BigInt(TIME_CONSTANTS.ONE_DAY_SECONDS)
const ONE_DAY = BigInt(TIME_CONSTANTS.ONE_DAY_SECONDS)
const TWELVE_HOURS = ONE_DAY / 2n
const FORTY_EIGHT_HOURS = ONE_DAY * 2n
const BASELINE_REVENUE_USD = ethers.parseEther('1000')

const missingRoleRegex = (account: string, role: string) =>
  new RegExp(
    `AccessControl: account ${account.toLowerCase()} is missing role ${role.toLowerCase()}`
  )

describe('RevenueSource', function () {
  let factory: RevenueSourceHarness__factory
  let subject: RevenueSourceHarness
  let admin: Signer
  let emergency: Signer
  let stranger: Signer
  let topSnapshot: SnapshotRestorer

  before(async function () {
    topSnapshot = await takeSnapshot()
    ;[admin, emergency, stranger] = await ethers.getSigners()

    factory = await ethers.getContractFactory('RevenueSourceHarness')
  })

  after(async function () {
    await topSnapshot.restore()
  })

  async function deploy(
    adminAddr: string = contracts.ADMIN,
    staleness: bigint = STALENESS_WINDOW_SECONDS
  ) {
    const instance = await factory.deploy(adminAddr, staleness)
    await instance.waitForDeployment()
    return instance
  }

  describe('deployment:', function () {
    let snapshot: SnapshotRestorer

    before(async function () {
      snapshot = await takeSnapshot()
      subject = await deploy(await admin.getAddress())
    })

    after(async function () {
      await snapshot.restore()
    })

    it('should store the provided staleness window', async function () {
      expect(await subject.STALENESS_WINDOW_SECONDS()).to.equal(STALENESS_WINDOW_SECONDS)
    })

    it('should expose EMERGENCY_ROLE as keccak256("EMERGENCY_ROLE")', async function () {
      expect(await subject.EMERGENCY_ROLE()).to.equal(EMERGENCY_ROLE)
    })

    it('should expose DEFAULT_ADMIN_ROLE as bytes32(0)', async function () {
      expect(await subject.DEFAULT_ADMIN_ROLE()).to.equal(DEFAULT_ADMIN_ROLE)
    })

    it('should grant DEFAULT_ADMIN_ROLE to admin_', async function () {
      expect(await subject.hasRole(DEFAULT_ADMIN_ROLE, await admin.getAddress())).to.equal(true)
    })

    it('should NOT grant EMERGENCY_ROLE to admin_ at construction', async function () {
      expect(await subject.hasRole(EMERGENCY_ROLE, await admin.getAddress())).to.equal(false)
    })

    it('should not recognize MANAGER_ROLE (not defined on RevenueSource)', async function () {
      expect(await subject.getRoleMemberCount(MANAGER_ROLE)).to.equal(0n)
    })

    it('should initialize storage with zero revenue and zero report timestamp', async function () {
      const [revenueUSD, reportTimestamp] = await subject.getRevenue()
      expect(revenueUSD).to.equal(0n)
      expect(reportTimestamp).to.equal(0n)
    })

    it('should flag the pre-first-report state as stale', async function () {
      const [, , isStale] = await subject.getRevenue()
      expect(isStale).to.equal(true)
    })

    it('should initialize in the unpaused state', async function () {
      expect(await subject.paused()).to.equal(false)
    })

    it('should revert with InvalidAdminAddress when admin_ is zero', async function () {
      await expect(factory.deploy(ethers.ZeroAddress, STALENESS_WINDOW_SECONDS))
        .to.be.revertedWithCustomError(factory, 'InvalidAdminAddress')
        .withArgs(ethers.ZeroAddress)
    })

    it('should revert with InvalidStalenessWindow when staleness is zero', async function () {
      await expect(factory.deploy(await admin.getAddress(), 0n))
        .to.be.revertedWithCustomError(factory, 'InvalidStalenessWindow')
        .withArgs(0n)
    })
  })

  describe('getRevenue:', function () {
    let snapshot: SnapshotRestorer
    let reportTs: bigint

    before(async function () {
      snapshot = await takeSnapshot()
      subject = (await deploy(await admin.getAddress())).connect(admin) as RevenueSourceHarness

      reportTs = BigInt(await time.latest()) + 10n
      await time.setNextBlockTimestamp(reportTs)
      await subject.updateRevenue(BASELINE_REVENUE_USD, reportTs)
    })

    after(async function () {
      await snapshot.restore()
    })

    it('should return the stored revenueUSD and reportTimestamp', async function () {
      const [revenueUSD, reportTimestamp] = await subject.getRevenue()
      expect(revenueUSD).to.equal(BASELINE_REVENUE_USD)
      expect(reportTimestamp).to.equal(reportTs)
    })

    it('should report fresh immediately after a report', async function () {
      const [, , isStale] = await subject.getRevenue()
      expect(isStale).to.equal(false)
    })

    it('should still report fresh exactly at the window boundary', async function () {
      await time.setNextBlockTimestamp(reportTs + STALENESS_WINDOW_SECONDS)
      await ethers.provider.send('evm_mine', [])

      const [, , isStale] = await subject.getRevenue()
      expect(isStale).to.equal(false)
    })

    it('should flag stale one second past the window', async function () {
      await time.setNextBlockTimestamp(reportTs + STALENESS_WINDOW_SECONDS + 1n)
      await ethers.provider.send('evm_mine', [])

      const [, , isStale] = await subject.getRevenue()
      expect(isStale).to.equal(true)
    })

    it('should flag stale far past the window', async function () {
      await time.increase(ONE_DAY * 30n)

      const [, , isStale] = await subject.getRevenue()
      expect(isStale).to.equal(true)
    })
  })

  describe('_updateRevenue (via harness):', function () {
    let snapshot: SnapshotRestorer
    let firstReportTs: bigint

    beforeEach(async function () {
      snapshot = await takeSnapshot()
      subject = (await deploy(await admin.getAddress())).connect(admin) as RevenueSourceHarness

      firstReportTs = BigInt(await time.latest()) + 100n
    })

    afterEach(async function () {
      await snapshot.restore()
    })

    describe('happy path:', function () {
      it('should store raw revenue on the first report (no normalization)', async function () {
        await subject.updateRevenue(BASELINE_REVENUE_USD, firstReportTs)

        const [revenueUSD, reportTimestamp] = await subject.getRevenue()
        expect(revenueUSD).to.equal(BASELINE_REVENUE_USD)
        expect(reportTimestamp).to.equal(firstReportTs)
      })

      it('should emit RevenueUpdated with raw values on the first report', async function () {
        await expect(subject.updateRevenue(BASELINE_REVENUE_USD, firstReportTs))
          .to.emit(subject, 'RevenueUpdated')
          .withArgs(BASELINE_REVENUE_USD, firstReportTs)
      })

      it('should store raw revenue when the second report covers exactly 24 hours', async function () {
        await subject.updateRevenue(BASELINE_REVENUE_USD, firstReportTs)

        const secondTs = firstReportTs + ONE_DAY
        await subject.updateRevenue(BASELINE_REVENUE_USD, secondTs)

        const [revenueUSD, reportTimestamp] = await subject.getRevenue()
        expect(revenueUSD).to.equal(BASELINE_REVENUE_USD)
        expect(reportTimestamp).to.equal(secondTs)
      })

      it('should double raw revenue when the second report covers 12 hours', async function () {
        await subject.updateRevenue(BASELINE_REVENUE_USD, firstReportTs)

        const secondTs = firstReportTs + TWELVE_HOURS
        await expect(subject.updateRevenue(BASELINE_REVENUE_USD, secondTs))
          .to.emit(subject, 'RevenueUpdated')
          .withArgs(BASELINE_REVENUE_USD * 2n, secondTs)

        const [revenueUSD] = await subject.getRevenue()
        expect(revenueUSD).to.equal(BASELINE_REVENUE_USD * 2n)
      })

      it('should halve raw revenue when the second report covers 48 hours', async function () {
        await subject.updateRevenue(BASELINE_REVENUE_USD, firstReportTs)

        const secondTs = firstReportTs + FORTY_EIGHT_HOURS
        await expect(subject.updateRevenue(BASELINE_REVENUE_USD, secondTs))
          .to.emit(subject, 'RevenueUpdated')
          .withArgs(BASELINE_REVENUE_USD / 2n, secondTs)

        const [revenueUSD] = await subject.getRevenue()
        expect(revenueUSD).to.equal(BASELINE_REVENUE_USD / 2n)
      })

      it('should store raw revenue when the second report reuses the previous timestamp', async function () {
        await subject.updateRevenue(BASELINE_REVENUE_USD, firstReportTs)

        const replacementRevenue = BASELINE_REVENUE_USD * 3n
        await expect(subject.updateRevenue(replacementRevenue, firstReportTs))
          .to.emit(subject, 'RevenueUpdated')
          .withArgs(replacementRevenue, firstReportTs)

        const [revenueUSD, reportTimestamp] = await subject.getRevenue()
        expect(revenueUSD).to.equal(replacementRevenue)
        expect(reportTimestamp).to.equal(firstReportTs)
      })

      it('should overwrite rather than accumulate across successive reports', async function () {
        await subject.updateRevenue(BASELINE_REVENUE_USD, firstReportTs)

        const secondTs = firstReportTs + ONE_DAY
        const secondRevenue = ethers.parseEther('42')
        await subject.updateRevenue(secondRevenue, secondTs)

        const [revenueUSD] = await subject.getRevenue()
        expect(revenueUSD).to.equal(secondRevenue)
      })

      it('should advance _lastReportTimestamp to the argument value', async function () {
        await subject.updateRevenue(BASELINE_REVENUE_USD, firstReportTs)

        const secondTs = firstReportTs + ONE_DAY * 7n
        await subject.updateRevenue(BASELINE_REVENUE_USD, secondTs)

        const [, reportTimestamp] = await subject.getRevenue()
        expect(reportTimestamp).to.equal(secondTs)
      })
    })

    describe('edge cases:', function () {
      it('should store zero when revenueUSD_ is zero on the first report', async function () {
        await expect(subject.updateRevenue(0n, firstReportTs))
          .to.emit(subject, 'RevenueUpdated')
          .withArgs(0n, firstReportTs)

        const [revenueUSD, reportTimestamp] = await subject.getRevenue()
        expect(revenueUSD).to.equal(0n)
        expect(reportTimestamp).to.equal(firstReportTs)
      })

      it('should store zero normalized revenue for a zero second report', async function () {
        await subject.updateRevenue(BASELINE_REVENUE_USD, firstReportTs)

        const secondTs = firstReportTs + ONE_DAY
        await subject.updateRevenue(0n, secondTs)

        const [revenueUSD] = await subject.getRevenue()
        expect(revenueUSD).to.equal(0n)
      })

      it('should revert with Panic 0x11 on a decreasing report timestamp', async function () {
        await subject.updateRevenue(BASELINE_REVENUE_USD, firstReportTs)

        await expect(
          subject.updateRevenue(BASELINE_REVENUE_USD, firstReportTs - 1n)
        ).to.be.revertedWithPanic('0x11')
      })

      it('should revert with Panic 0x11 when revenueUSD_ × ONE_DAY overflows', async function () {
        await subject.updateRevenue(BASELINE_REVENUE_USD, firstReportTs)

        const secondTs = firstReportTs + TWELVE_HOURS
        const overflowing = (2n ** 256n - 1n) / ONE_DAY + 1n
        await expect(subject.updateRevenue(overflowing, secondTs)).to.be.revertedWithPanic('0x11')
      })

      it('should correctly normalize a large-but-safe revenue value', async function () {
        await subject.updateRevenue(BASELINE_REVENUE_USD, firstReportTs)

        const safeLargeRevenue = (2n ** 256n - 1n) / ONE_DAY
        const secondTs = firstReportTs + TWELVE_HOURS
        const expectedDaily = (safeLargeRevenue * ONE_DAY) / TWELVE_HOURS

        await expect(subject.updateRevenue(safeLargeRevenue, secondTs))
          .to.emit(subject, 'RevenueUpdated')
          .withArgs(expectedDaily, secondTs)
      })
    })
  })

  describe('pause:', function () {
    let snapshot: SnapshotRestorer

    beforeEach(async function () {
      snapshot = await takeSnapshot()
      subject = (await deploy(await admin.getAddress())).connect(admin) as RevenueSourceHarness
      await subject.grantRole(EMERGENCY_ROLE, await emergency.getAddress())
    })

    afterEach(async function () {
      await snapshot.restore()
    })

    it('should revert when called by admin lacking EMERGENCY_ROLE', async function () {
      const adminAddr = await admin.getAddress()
      await expect(subject.connect(admin).pause()).to.be.revertedWith(
        missingRoleRegex(adminAddr, EMERGENCY_ROLE)
      )
    })

    it('should revert when called by an unrelated stranger', async function () {
      const strangerAddr = await stranger.getAddress()
      await expect(subject.connect(stranger).pause()).to.be.revertedWith(
        missingRoleRegex(strangerAddr, EMERGENCY_ROLE)
      )
    })

    it('should revert when the contract is already paused', async function () {
      await subject.connect(emergency).pause()
      await expect(subject.connect(emergency).pause()).to.be.revertedWith('Pausable: paused')
    })

    it('should flip paused() to true when called by an EMERGENCY_ROLE holder', async function () {
      await subject.connect(emergency).pause()
      expect(await subject.paused()).to.equal(true)
    })

    it('should emit Paused(account) when called by an EMERGENCY_ROLE holder', async function () {
      const emergencyAddr = await emergency.getAddress()
      await expect(subject.connect(emergency).pause())
        .to.emit(subject, 'Paused')
        .withArgs(emergencyAddr)
    })
  })

  describe('unpause:', function () {
    let snapshot: SnapshotRestorer

    beforeEach(async function () {
      snapshot = await takeSnapshot()
      subject = (await deploy(await admin.getAddress())).connect(admin) as RevenueSourceHarness
      await subject.grantRole(EMERGENCY_ROLE, await emergency.getAddress())
      await subject.connect(emergency).pause()
    })

    afterEach(async function () {
      await snapshot.restore()
    })

    it('should revert when called by admin lacking EMERGENCY_ROLE', async function () {
      const adminAddr = await admin.getAddress()
      await expect(subject.connect(admin).unpause()).to.be.revertedWith(
        missingRoleRegex(adminAddr, EMERGENCY_ROLE)
      )
    })

    it('should revert when called by an unrelated stranger', async function () {
      const strangerAddr = await stranger.getAddress()
      await expect(subject.connect(stranger).unpause()).to.be.revertedWith(
        missingRoleRegex(strangerAddr, EMERGENCY_ROLE)
      )
    })

    it('should revert when the contract is not paused', async function () {
      await subject.connect(emergency).unpause()
      await expect(subject.connect(emergency).unpause()).to.be.revertedWith('Pausable: not paused')
    })

    it('should flip paused() to false when called by an EMERGENCY_ROLE holder', async function () {
      await subject.connect(emergency).unpause()
      expect(await subject.paused()).to.equal(false)
    })

    it('should emit Unpaused(account) when called by an EMERGENCY_ROLE holder', async function () {
      const emergencyAddr = await emergency.getAddress()
      await expect(subject.connect(emergency).unpause())
        .to.emit(subject, 'Unpaused')
        .withArgs(emergencyAddr)
    })
  })

  describe('invariants:', function () {
    let snapshot: SnapshotRestorer

    beforeEach(async function () {
      snapshot = await takeSnapshot()
      subject = (await deploy(await admin.getAddress())).connect(admin) as RevenueSourceHarness
    })

    afterEach(async function () {
      await snapshot.restore()
    })

    it('invariant: reportTimestamp is non-decreasing across sequential updates', async function () {
      const t0 = BigInt(await time.latest()) + 100n

      await subject.updateRevenue(BASELINE_REVENUE_USD, t0)
      await subject.updateRevenue(BASELINE_REVENUE_USD, t0)
      await subject.updateRevenue(BASELINE_REVENUE_USD, t0 + ONE_DAY)

      await expect(
        subject.updateRevenue(BASELINE_REVENUE_USD, t0 + ONE_DAY - 1n)
      ).to.be.revertedWithPanic('0x11')

      const [, reportTimestamp] = await subject.getRevenue()
      expect(reportTimestamp).to.equal(t0 + ONE_DAY)
    })

    it('invariant: first report bypasses normalization regardless of deploy-to-report gap', async function () {
      const decade = ONE_DAY * 365n * 10n
      await time.increase(decade)

      const firstTs = BigInt(await time.latest()) + 100n
      await expect(subject.updateRevenue(BASELINE_REVENUE_USD, firstTs))
        .to.emit(subject, 'RevenueUpdated')
        .withArgs(BASELINE_REVENUE_USD, firstTs)

      const [revenueUSD, reportTimestamp] = await subject.getRevenue()
      expect(revenueUSD).to.equal(BASELINE_REVENUE_USD)
      expect(reportTimestamp).to.equal(firstTs)
    })

    it('invariant: EMERGENCY_ROLE must be granted post-deploy for pause authority', async function () {
      const adminAddr = await admin.getAddress()

      expect(await subject.hasRole(EMERGENCY_ROLE, adminAddr)).to.equal(false)
      await expect(subject.pause()).to.be.revertedWith(missingRoleRegex(adminAddr, EMERGENCY_ROLE))

      await subject.grantRole(EMERGENCY_ROLE, adminAddr)

      expect(await subject.hasRole(EMERGENCY_ROLE, adminAddr)).to.equal(true)
      await subject.pause()
      expect(await subject.paused()).to.equal(true)
    })
  })
})
