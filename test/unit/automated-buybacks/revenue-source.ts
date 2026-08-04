import { ethers } from 'hardhat'
import { expect } from 'chai'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'

import { RevenueSourceHarness, RevenueSourceHarness__factory } from '../../../typechain-types'

const ONE_USD = ethers.parseEther('1')
const SAMPLE_REVENUE_USD = ethers.parseEther('1000')

describe('RevenueSource', function () {
  let factory: RevenueSourceHarness__factory
  let subject: RevenueSourceHarness
  let topSnapshot: SnapshotRestorer

  before(async function () {
    topSnapshot = await takeSnapshot()
    factory = await ethers.getContractFactory('RevenueSourceHarness')
  })

  after(async function () {
    await topSnapshot.restore()
  })

  async function deploy() {
    const instance = await factory.deploy()
    await instance.waitForDeployment()
    return instance
  }

  describe('deployment:', function () {
    let snapshot: SnapshotRestorer

    before(async function () {
      snapshot = await takeSnapshot()
      subject = await deploy()
    })

    after(async function () {
      await snapshot.restore()
    })

    it('should initialize the cumulative revenue accumulator at zero', async function () {
      expect(await subject.getCumulativeRevenueUSD()).to.equal(0n)
    })
  })

  describe('_addRevenueUSD (via harness):', function () {
    let snapshot: SnapshotRestorer

    beforeEach(async function () {
      snapshot = await takeSnapshot()
      subject = await deploy()
    })

    afterEach(async function () {
      await snapshot.restore()
    })

    it('should increment the cumulative by the reported amount', async function () {
      await subject.addRevenueUSD(SAMPLE_REVENUE_USD)
      expect(await subject.getCumulativeRevenueUSD()).to.equal(SAMPLE_REVENUE_USD)
    })

    it('should emit RevenueAdded with the amount and post-write cumulative', async function () {
      await expect(subject.addRevenueUSD(SAMPLE_REVENUE_USD))
        .to.emit(subject, 'RevenueAdded')
        .withArgs(SAMPLE_REVENUE_USD, SAMPLE_REVENUE_USD)
    })

    it('should accumulate across successive reports', async function () {
      await expect(subject.addRevenueUSD(ONE_USD))
        .to.emit(subject, 'RevenueAdded')
        .withArgs(ONE_USD, ONE_USD)

      await expect(subject.addRevenueUSD(ONE_USD * 2n))
        .to.emit(subject, 'RevenueAdded')
        .withArgs(ONE_USD * 2n, ONE_USD * 3n)
    })

    it('should be a no-op write that still emits when amount is zero', async function () {
      await subject.addRevenueUSD(SAMPLE_REVENUE_USD)

      await expect(subject.addRevenueUSD(0n))
        .to.emit(subject, 'RevenueAdded')
        .withArgs(0n, SAMPLE_REVENUE_USD)

      expect(await subject.getCumulativeRevenueUSD()).to.equal(SAMPLE_REVENUE_USD)
    })

    it('should revert with Panic 0x11 when the accumulator overflows uint256', async function () {
      const max = 2n ** 256n - 1n
      await subject.addRevenueUSD(max)
      await expect(subject.addRevenueUSD(1n)).to.be.revertedWithPanic('0x11')
    })

    it('should accept the maximum value as the first report', async function () {
      const max = 2n ** 256n - 1n
      await expect(subject.addRevenueUSD(max))
        .to.emit(subject, 'RevenueAdded')
        .withArgs(max, max)
      expect(await subject.getCumulativeRevenueUSD()).to.equal(max)
    })
  })
})
