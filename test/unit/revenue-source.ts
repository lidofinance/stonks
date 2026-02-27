import { ethers } from 'hardhat'
import { expect } from 'chai'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import { RevenueSourceHarness } from '../../typechain-types'

describe('RevenueSource', async function () {
  let harness: RevenueSourceHarness
  let snapshot: SnapshotRestorer

  before(async function () {
    snapshot = await takeSnapshot()
    const factory = await ethers.getContractFactory('RevenueSourceHarness')
    harness = await factory.deploy()
    await harness.waitForDeployment()
  })

  after(async function () {
    await snapshot.restore()
  })

  describe('getRevenue:', function () {
    let localSnapshot: SnapshotRestorer

    beforeEach(async function () {
      localSnapshot = await takeSnapshot()
    })

    afterEach(async function () {
      await localSnapshot.restore()
    })

    it('returns (0, 0) on fresh deployment', async function () {
      const [revenueUsd, reportTimestamp] = await harness.getRevenue()
      expect(revenueUsd).to.equal(0n)
      expect(reportTimestamp).to.equal(0n)
    })

    it('returns the values written by updateRevenue', async function () {
      await harness.updateRevenue(1_000n, 9999n)
      const [revenueUsd, reportTimestamp] = await harness.getRevenue()
      expect(revenueUsd).to.equal(1_000n)
      expect(reportTimestamp).to.equal(9999n)
    })

    it('returns the latest values after multiple updateRevenue calls', async function () {
      await harness.updateRevenue(100n, 1n)
      await harness.updateRevenue(200n, 2n)
      const [revenueUsd, reportTimestamp] = await harness.getRevenue()
      expect(revenueUsd).to.equal(200n)
      expect(reportTimestamp).to.equal(2n)
    })

    it('reverts when contract is paused', async function () {
      await harness.pause()
      await expect(harness.getRevenue()).to.be.revertedWith('Pausable: paused')
    })

    it('succeeds again after unpause', async function () {
      await harness.pause()
      await expect(harness.getRevenue()).to.be.revertedWith('Pausable: paused')
      await harness.unpause()
      const [revenueUsd, reportTimestamp] = await harness.getRevenue()
      expect(revenueUsd).to.equal(0n)
      expect(reportTimestamp).to.equal(0n)
    })
  })

  describe('updateRevenue:', function () {
    let localSnapshot: SnapshotRestorer

    beforeEach(async function () {
      localSnapshot = await takeSnapshot()
    })

    afterEach(async function () {
      await localSnapshot.restore()
    })

    it('emits RevenueUpdated with the supplied revenueUsd and reportTimestamp', async function () {
      await expect(harness.updateRevenue(42_000n, 1_700_000_000n))
        .to.emit(harness, 'RevenueUpdated')
        .withArgs(42_000n, 1_700_000_000n)

      const [revenueUsd, reportTimestamp] = await harness.getRevenue()
      expect(revenueUsd).to.equal(42_000n)
      expect(reportTimestamp).to.equal(1_700_000_000n)
    })

    it('stores values durably — second call overwrites first with no bleed-through', async function () {
      await harness.updateRevenue(1n, 2n)
      await harness.updateRevenue(3n, 4n)
      const [revenueUsd, reportTimestamp] = await harness.getRevenue()
      expect(revenueUsd).to.equal(3n)
      expect(reportTimestamp).to.equal(4n)
    })

    it('accepts zero values without reverting (no domain validation in the base contract)', async function () {
      await expect(harness.updateRevenue(0n, 0n))
        .to.emit(harness, 'RevenueUpdated')
        .withArgs(0n, 0n)
      const [revenueUsd, reportTimestamp] = await harness.getRevenue()
      expect(revenueUsd).to.equal(0n)
      expect(reportTimestamp).to.equal(0n)
    })
  })

  describe('pause / unpause:', function () {
    let localSnapshot: SnapshotRestorer

    beforeEach(async function () {
      localSnapshot = await takeSnapshot()
    })

    afterEach(async function () {
      await localSnapshot.restore()
    })

    it('updateRevenue is not gated by whenNotPaused', async function () {
      await expect(harness.updateRevenue(1n, 1n)).to.not.be.reverted
    })

    it('getRevenue is blocked while paused, updateRevenue is not', async function () {
      await harness.pause()
      await expect(harness.updateRevenue(2n, 2n)).to.not.be.reverted
      await expect(harness.getRevenue()).to.be.revertedWith('Pausable: paused')
    })

    it('getRevenue reflects writes made during pause once unpaused', async function () {
      await harness.pause()
      await harness.updateRevenue(999n, 888n)
      await expect(harness.getRevenue()).to.be.revertedWith('Pausable: paused')
      await harness.unpause()
      const [revenueUsd, reportTimestamp] = await harness.getRevenue()
      expect(revenueUsd).to.equal(999n)
      expect(reportTimestamp).to.equal(888n)
    })
  })
})
