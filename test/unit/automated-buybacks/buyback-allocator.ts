import { ethers } from 'hardhat'
import { expect } from 'chai'
import { Signer } from 'ethers'
import { takeSnapshot, SnapshotRestorer, time } from '@nomicfoundation/hardhat-network-helpers'

import {
  BuybackAllocator,
  BuybackAllocator__factory,
  StEthTokenStub,
  StEthTokenStub__factory,
  OracleRouterUsdStub,
  OracleRouterUsdStub__factory,
  RevenueSourceStub,
  RevenueSourceStub__factory,
  ExecutorStub,
  ExecutorStub__factory,
} from '../../../typechain-types'

// 1 USD == 1 stETH (both 18 decimals), so USD and stETH amounts are numerically equal.
const PRICE = ethers.parseEther('1')
const ONE_DAY = 86_400n

const DAILY_CAP = ethers.parseEther('1000000')
const YEARLY_CAP = ethers.parseEther('10000000')
const MIN_SPEND = ethers.parseEther('1')
const SHARE_50 = 5000n
const SHARE_100 = 10000n

const usd = (n: string) => ethers.parseEther(n)

// AllocationStatus enum order, mirrored from the contract.
enum AllocationStatus {
  Eligible,
  NoAvailableBudget,
  QuoteUnavailable,
  StEthPriceBelowMin,
  AllocationBelowMin,
  WindowCapReached,
}

enum OracleFailureMode {
  None = 0,
  CustomError = 1,
}

interface DeployOpts {
  share?: bigint
  dailyCap?: bigint
  yearlyCap?: bigint
  minSpend?: bigint
  reserveRate?: bigint
}

describe('BuybackAllocator — accumulated budget', function () {
  let admin: Signer
  let adminAddr: string

  let allocator: BuybackAllocator
  let stEth: StEthTokenStub
  let oracle: OracleRouterUsdStub
  let executor: ExecutorStub
  let source: RevenueSourceStub

  let topSnapshot: SnapshotRestorer
  let snapshot: SnapshotRestorer

  before(async function () {
    topSnapshot = await takeSnapshot()
    ;[admin] = await ethers.getSigners()
    adminAddr = await admin.getAddress()
  })

  after(async function () {
    await topSnapshot.restore()
  })

  async function deployAllocator(opts: DeployOpts = {}) {
    stEth = await new StEthTokenStub__factory(admin).deploy()
    oracle = await new OracleRouterUsdStub__factory(admin).deploy()
    executor = await new ExecutorStub__factory(admin).deploy()
    source = await new RevenueSourceStub__factory(admin).deploy()
    await oracle.setUsdPrice(PRICE, PRICE)

    allocator = await new BuybackAllocator__factory(admin).deploy({
      admin: adminAddr,
      treasury: adminAddr,
      stEth: await stEth.getAddress(),
      oracleRouter: await oracle.getAddress(),
      executor: await executor.getAddress(),
      dailyCapUSD: opts.dailyCap ?? DAILY_CAP,
      yearlyCapUSD: opts.yearlyCap ?? YEARLY_CAP,
      reserveDailyRateUSD: opts.reserveRate ?? 0n,
      minStEthPriceUSD: 0n,
      minSpendPerCallUSD: opts.minSpend ?? MIN_SPEND,
      surplusShareBP: opts.share ?? SHARE_50,
      revenueSources: [await source.getAddress()],
    })
    await allocator.waitForDeployment()
  }

  // Sets the source cumulative, then activates. The reserve rate is configured at deploy.
  async function activateWith(cumulative: bigint) {
    await source.setCumulativeRevenueUSD(cumulative)
    await allocator.activate()
  }

  // Funds the allocator with stETH so eligible allocations can actually transfer.
  async function fund(amount: bigint) {
    await stEth.mint(await allocator.getAddress(), amount)
  }

  beforeEach(async function () {
    snapshot = await takeSnapshot()
  })

  afterEach(async function () {
    await snapshot.restore()
  })

  describe('activation:', function () {
    it('records the strict revenue sum as the baseline and anchors the reserve to the activation day', async function () {
      await deployAllocator({ reserveRate: usd('100') })
      await activateWith(usd('1000'))

      expect(await allocator.lastTotalRevenueUSD()).to.equal(usd('1000'))
      expect(await allocator.budgetUSD()).to.equal(0n)

      // Anchor is the activation day itself (today midnight), so the activation day reserve is charged.
      const activationTS = await allocator.activationTS()
      expect(await allocator.reserveAnchorTS()).to.equal(activationTS)
    })

    it('reverts activation when a source is unreachable (strict sum)', async function () {
      await deployAllocator()
      await source.setReverting(true)
      await expect(allocator.activate()).to.be.reverted
    })

    it('charges the activation day reserve', async function () {
      await deployAllocator({ share: SHARE_100, reserveRate: usd('100') })
      await activateWith(0n)

      // Same day as activation: the anchor is today, so one daily reserve (100) is charged and only
      // the surplus net of it banks.
      await source.setCumulativeRevenueUSD(usd('500'))
      await allocator.allocate() // balance is 0 → skips after checkpointing

      expect(await allocator.budgetUSD()).to.equal(usd('400')) // 500 - 1*100
    })
  })

  describe('checkpoint banking (no reserve):', function () {
    it('banks surplusShareBP of new revenue', async function () {
      await deployAllocator({ share: SHARE_50 })
      await activateWith(0n)

      await source.setCumulativeRevenueUSD(usd('1000'))
      await allocator.allocate() // skips (no balance), still checkpoints

      expect(await allocator.budgetUSD()).to.equal(usd('500'))
      expect(await allocator.lastTotalRevenueUSD()).to.equal(usd('1000'))
    })

    it('accumulates across successive checkpoints', async function () {
      await deployAllocator({ share: SHARE_50 })
      await activateWith(0n)

      await source.setCumulativeRevenueUSD(usd('1000'))
      await allocator.allocate()
      expect(await allocator.budgetUSD()).to.equal(usd('500'))

      await source.setCumulativeRevenueUSD(usd('3000'))
      await allocator.allocate()
      expect(await allocator.budgetUSD()).to.equal(usd('1500')) // +50% of the new 2000
      expect(await allocator.lastTotalRevenueUSD()).to.equal(usd('3000'))
    })
  })

  describe('reserve timeline:', function () {
    it('charges one daily rate on the activation day', async function () {
      await deployAllocator({ share: SHARE_100, reserveRate: usd('100') })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))

      // Anchor is the activation day, so the very first checkpoint charges one daily rate.
      await allocator.allocate()

      expect(await allocator.budgetUSD()).to.equal(usd('900')) // 1000 - 1*100
    })

    it('charges a second daily rate the next day', async function () {
      await deployAllocator({ share: SHARE_100, reserveRate: usd('100') })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))

      const activationTS = await allocator.activationTS()
      await time.setNextBlockTimestamp(activationTS + ONE_DAY)
      await allocator.allocate()

      expect(await allocator.budgetUSD()).to.equal(usd('800')) // 1000 - 2*100
    })
  })

  describe('signed budget (reserve always applies):', function () {
    it('falls below zero when revenue does not cover the reserve, then recovers', async function () {
      await deployAllocator({ share: SHARE_100, reserveRate: usd('100') })
      await activateWith(0n)
      const activationTS = await allocator.activationTS()

      // Activation day: reserve 100, revenue 40 → budget dips to -60. No carry-forward: baseline and
      // anchor advance to the next day.
      await source.setCumulativeRevenueUSD(usd('40'))
      await allocator.allocate()
      expect(await allocator.budgetUSD()).to.equal(-usd('60'))
      expect(await allocator.lastTotalRevenueUSD()).to.equal(usd('40'))
      expect(await allocator.reserveAnchorTS()).to.equal(activationTS + ONE_DAY)

      // More revenue the same day (reserve already counted, so 0 more) climbs the budget back positive.
      await source.setCumulativeRevenueUSD(usd('200'))
      await allocator.allocate()
      expect(await allocator.budgetUSD()).to.equal(usd('100')) // -60 + (200 - 40)
    })

    it('lets the reserve erode the budget when revenue stalls', async function () {
      await deployAllocator({ share: SHARE_100, reserveRate: usd('100') })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))
      const activationTS = await allocator.activationTS()

      // Activation day: reserve = 100.
      await allocator.allocate()
      expect(await allocator.budgetUSD()).to.equal(usd('900')) // 1000 - 100

      // 30 days after activation: the reserve keeps subtracting (30 * 100), eroding the budget below zero.
      await time.setNextBlockTimestamp(activationTS + 30n * ONE_DAY)
      await allocator.allocate()
      expect(await allocator.budgetUSD()).to.equal(-usd('2100')) // 900 - 3000
    })
  })

  describe('allocate spending:', function () {
    it('draws the budget down and transfers stETH to the executor', async function () {
      await deployAllocator({ share: SHARE_100 })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))
      await fund(usd('1000'))

      await expect(allocator.allocate())
        .to.emit(allocator, 'Allocated')
        .withArgs(adminAddr, await executor.getAddress(), usd('1000'), usd('1000'))

      expect(await allocator.budgetUSD()).to.equal(0n)
      expect(await stEth.balanceOf(await executor.getAddress())).to.equal(usd('1000'))
      expect(await stEth.balanceOf(await allocator.getAddress())).to.equal(0n)
      expect(await executor.onStEthAllocatedCount()).to.equal(1n)
    })

    it('is bounded by the daily cap', async function () {
      await deployAllocator({ share: SHARE_100, dailyCap: usd('300') })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))
      await fund(usd('1000'))

      await allocator.allocate()
      expect(await allocator.budgetUSD()).to.equal(usd('700')) // 1000 banked, 300 spent
      expect(await stEth.balanceOf(await executor.getAddress())).to.equal(usd('300'))

      // Same day, cap exhausted → nothing more is spendable.
      await expect(allocator.allocate())
        .to.emit(allocator, 'AllocationSkipped')
        .withArgs(adminAddr, AllocationStatus.WindowCapReached)
      expect(await allocator.budgetUSD()).to.equal(usd('700'))
    })

    it('is bounded by the stETH balance, leaving the rest banked', async function () {
      await deployAllocator({ share: SHARE_100 })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))
      await fund(usd('200'))

      await allocator.allocate()
      expect(await stEth.balanceOf(await executor.getAddress())).to.equal(usd('200'))
      expect(await allocator.budgetUSD()).to.equal(usd('800'))
    })

    it('skips an allocation below the minimum per call but keeps the budget banked', async function () {
      await deployAllocator({ share: SHARE_100, minSpend: usd('100') })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('50'))
      await fund(usd('1000'))

      await expect(allocator.allocate())
        .to.emit(allocator, 'AllocationSkipped')
        .withArgs(adminAddr, AllocationStatus.AllocationBelowMin)

      expect(await allocator.budgetUSD()).to.equal(usd('50'))
      expect(await executor.onStEthAllocatedCount()).to.equal(0n)
      expect(await stEth.balanceOf(await executor.getAddress())).to.equal(0n)
    })

    it('still banks the checkpoint when the allocation is skipped (price unavailable)', async function () {
      await deployAllocator({ share: SHARE_50 })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))
      await oracle.setFailureMode(OracleFailureMode.CustomError)

      await expect(allocator.allocate())
        .to.emit(allocator, 'AllocationSkipped')
        .withArgs(adminAddr, AllocationStatus.QuoteUnavailable)

      expect(await allocator.budgetUSD()).to.equal(usd('500'))
    })
  })

  describe('setSurplusShareBP:', function () {
    it('banks the open interval at the old share, then applies the new share going forward', async function () {
      await deployAllocator({ share: SHARE_50 })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))

      // Changing the share checkpoints first → banks 1000 at 50%.
      await allocator.setSurplusShareBP(1000n) // 10%
      expect(await allocator.budgetUSD()).to.equal(usd('500'))
      expect(await allocator.surplusShareBP()).to.equal(1000n)

      // New revenue banks at the new 10% share.
      await source.setCumulativeRevenueUSD(usd('2000'))
      await allocator.allocate()
      expect(await allocator.budgetUSD()).to.equal(usd('600')) // 500 + 10% of 1000
    })
  })

  describe('setReserveDailyRateUSD:', function () {
    it('banks pending surplus at the old rate, then applies the new rate forward', async function () {
      await deployAllocator({ share: SHARE_100, reserveRate: usd('100') })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))
      const activationTS = await allocator.activationTS()

      // Activation day: old reserve = 100. Changing the rate checkpoints first, banking 1000 - 100.
      await allocator.setReserveDailyRateUSD(usd('50'))

      expect(await allocator.budgetUSD()).to.equal(usd('900')) // banked at the old rate
      expect(await allocator.reserveDailyRateUSD()).to.equal(usd('50'))
      expect(await allocator.reserveAnchorTS()).to.equal(activationTS + ONE_DAY) // fresh anchor, new rate
    })

    it('closes the interval even with no surplus, so the new rate cannot reprice elapsed days', async function () {
      await deployAllocator({ share: SHARE_100, reserveRate: usd('100') })
      await activateWith(0n)
      const activationTS = await allocator.activationTS()

      // Activation day: revenue 50 is below the old reserve of 100 → nothing to bank.
      await source.setCumulativeRevenueUSD(usd('50'))
      await allocator.setReserveDailyRateUSD(usd('1000'))

      // The interval closed at the OLD rate: revenue 50 minus the old reserve 100 leaves the budget
      // at -50, baseline advanced and reserve re-anchored. The new rate cannot reprice those days.
      expect(await allocator.budgetUSD()).to.equal(-usd('50'))
      expect(await allocator.lastTotalRevenueUSD()).to.equal(usd('50'))
      expect(await allocator.reserveAnchorTS()).to.equal(activationTS + ONE_DAY)
    })
  })

  describe('revenue sources:', function () {
    it('adjusts the baseline so a source added after activation contributes only later earnings', async function () {
      await deployAllocator({ share: SHARE_100 })
      await activateWith(usd('1000'))
      expect(await allocator.lastTotalRevenueUSD()).to.equal(usd('1000'))

      const extra = await new RevenueSourceStub__factory(admin).deploy()
      await extra.setCumulativeRevenueUSD(usd('300'))
      await allocator.addRevenueSource(await extra.getAddress())
      expect(await allocator.lastTotalRevenueUSD()).to.equal(usd('1300'))

      // The added source's pre-registration history does not bank.
      await allocator.allocate()
      expect(await allocator.budgetUSD()).to.equal(0n)

      await allocator.removeRevenueSource(await extra.getAddress())
      expect(await allocator.lastTotalRevenueUSD()).to.equal(usd('1000'))
    })
  })

  describe('removeRevenueSource checkpoints first:', function () {
    it('banks a still-earning source pending surplus instead of leaking it to the remaining sources', async function () {
      // A is the default `source`; B is added after activation.
      await deployAllocator({ share: SHARE_100 })
      const b = await new RevenueSourceStub__factory(admin).deploy()
      await activateWith(usd('10000')) // A = 10000 → baseline 10000

      await b.setCumulativeRevenueUSD(usd('5000'))
      await allocator.addRevenueSource(await b.getAddress()) // baseline 15000

      // A keeps earning to 12000 (2000 pending, unbanked) before it is removed.
      await source.setCumulativeRevenueUSD(usd('12000'))
      await allocator.removeRevenueSource(await source.getAddress())

      // Checkpoint banked A's genuine 2000; baseline now reflects B alone.
      expect(await allocator.budgetUSD()).to.equal(usd('2000'))
      expect(await allocator.lastTotalRevenueUSD()).to.equal(usd('5000'))

      // B earning 500 more banks exactly 500 — A's pending growth is NOT re-credited to B.
      await b.setCumulativeRevenueUSD(usd('5500'))
      await allocator.allocate()
      expect(await allocator.budgetUSD()).to.equal(usd('2500'))
    })

    it('reverts when removing an unreachable source (strict read)', async function () {
      // Removal subtracts the source's current total from the baseline, so it must read the source.
      // A reverting source makes removal revert (known limitation: remove a source only while it is
      // reachable). This keeps the accounting exact rather than erasing earned/debt.
      await deployAllocator({ share: SHARE_100 })
      await activateWith(usd('1000'))

      await source.setReverting(true)
      await expect(allocator.removeRevenueSource(await source.getAddress())).to.be.reverted

      // Still registered after the revert; a healthy read removes it cleanly.
      await source.setReverting(false)
      await expect(allocator.removeRevenueSource(await source.getAddress())).to.not.be.reverted
      expect(await allocator.lastTotalRevenueUSD()).to.equal(0n)
    })
  })

  describe('flaky source:', function () {
    it('reads a reverting source as a revenue drop and nets out on recovery (no double-count)', async function () {
      await deployAllocator({ share: SHARE_100 })
      await activateWith(usd('1000'))

      // Reverting source → non-strict sum reads 0 → budget dips by the apparent loss; no revert.
      await source.setReverting(true)
      await expect(allocator.allocate()).to.not.be.reverted
      expect(await allocator.budgetUSD()).to.equal(-usd('1000'))
      expect(await allocator.lastTotalRevenueUSD()).to.equal(0n)

      // On recovery the deltas telescope: genuine new revenue is 1000 (1000 → 2000), so the budget
      // ends at 1000, not 2000 — the pre-outage total is not counted twice.
      await source.setReverting(false)
      await source.setCumulativeRevenueUSD(usd('2000'))
      await allocator.allocate()
      expect(await allocator.budgetUSD()).to.equal(usd('1000'))
    })
  })

  describe('spendable (live):', function () {
    it('reflects revenue earned since the last set-aside, even with nothing banked yet', async function () {
      await deployAllocator({ share: SHARE_100 })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))
      await fund(usd('1000'))

      // nothing has been banked yet, but the live read includes the pending set-aside
      expect(await allocator.budgetUSD()).to.equal(0n)
      const live = await allocator.spendable()
      expect(live.status).to.equal(BigInt(AllocationStatus.Eligible))
      expect(live.spendableUSD).to.equal(usd('1000'))
      expect(live.spendableStEth).to.equal(usd('1000'))
    })

    it('accounts for the reserve and matches what a release then realizes', async function () {
      await deployAllocator({ share: SHARE_100, reserveRate: usd('100') })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))
      await fund(usd('1000'))

      // Activation day: reserve = 100.
      const live = await allocator.spendable()
      expect(live.spendableUSD).to.equal(usd('900')) // 1000 - 100 reserve

      // a release at the same point realizes exactly the amount the live read showed
      await allocator.allocate()
      expect(await stEth.balanceOf(await executor.getAddress())).to.equal(usd('900'))
      expect(await allocator.budgetUSD()).to.equal(0n)
    })

    it('reverts before activation', async function () {
      await deployAllocator()
      await expect(allocator.spendable()).to.be.revertedWithCustomError(allocator, 'NotActivated')
    })
  })

  describe('activation guard:', function () {
    it('reverts allocate() before activation', async function () {
      await deployAllocator()
      await expect(allocator.allocate()).to.be.revertedWithCustomError(allocator, 'NotActivated')
    })

    it('reverts setSurplusShareBP() before activation', async function () {
      await deployAllocator()
      await expect(allocator.setSurplusShareBP(1000n)).to.be.revertedWithCustomError(
        allocator,
        'NotActivated'
      )
    })

    it('reverts addRevenueSource() before activation', async function () {
      await deployAllocator()
      const extra = await new RevenueSourceStub__factory(admin).deploy()
      await expect(
        allocator.addRevenueSource(await extra.getAddress())
      ).to.be.revertedWithCustomError(allocator, 'NotActivated')
    })

    it('reverts removeRevenueSource() before activation', async function () {
      await deployAllocator()
      await expect(
        allocator.removeRevenueSource(await source.getAddress())
      ).to.be.revertedWithCustomError(allocator, 'NotActivated')
    })
  })

  describe('removed surface:', function () {
    it('no longer exposes resetAccounting', async function () {
      await deployAllocator()
      const hasReset = allocator.interface.fragments.some(
        (f) => f.type === 'function' && (f as { name?: string }).name === 'resetAccounting'
      )
      expect(hasReset).to.equal(false)
    })
  })
})
