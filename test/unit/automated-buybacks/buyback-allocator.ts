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
  ReentrantExecutorStub__factory,
  RevertingExecutorStub__factory,
  ObservingExecutorStub__factory,
  ScaledOracleRouterStub__factory,
} from '../../../typechain-types'

// 1 USD == 1 stETH (both 18 decimals), so USD and stETH amounts are numerically equal.
const PRICE = ethers.parseEther('1')
const ONE_DAY = 86_400n
const ONE_YEAR = 365n * ONE_DAY

const DAILY_CAP = ethers.parseEther('1000000')
const YEARLY_CAP = ethers.parseEther('10000000')
const MIN_SPEND = ethers.parseEther('1')
const SHARE_50 = 5000n
const SHARE_100 = 10000n
const MAX_SHARE = 10000n
const MAX_UINT128 = 2n ** 128n - 1n

const usd = (n: string) => ethers.parseEther(n)

// OZ v4 AccessControl revert reason for a caller missing a role.
const missingRoleMessage = (account: string, role: string) =>
  `AccessControl: account ${account.toLowerCase()} is missing role ${role}`

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
  minPrice?: bigint
  executorAddr?: string
  treasury?: string
}

describe('BuybackAllocator — accumulated budget', function () {
  let admin: Signer
  let adminAddr: string
  let stranger: Signer
  let strangerAddr: string

  let allocator: BuybackAllocator
  let stEth: StEthTokenStub
  let oracle: OracleRouterUsdStub
  let executor: ExecutorStub
  let source: RevenueSourceStub

  let topSnapshot: SnapshotRestorer
  let snapshot: SnapshotRestorer

  before(async function () {
    topSnapshot = await takeSnapshot()
    ;[admin, stranger] = await ethers.getSigners()
    adminAddr = await admin.getAddress()
    strangerAddr = await stranger.getAddress()
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
      treasury: opts.treasury ?? adminAddr,
      stEth: await stEth.getAddress(),
      oracleRouter: await oracle.getAddress(),
      executor: opts.executorAddr ?? (await executor.getAddress()),
      dailyCapUSD: opts.dailyCap ?? DAILY_CAP,
      yearlyCapUSD: opts.yearlyCap ?? YEARLY_CAP,
      reserveDailyRateUSD: opts.reserveRate ?? 0n,
      minStEthPriceUSD: opts.minPrice ?? 0n,
      minSpendPerCallUSD: opts.minSpend ?? MIN_SPEND,
      surplusShareBP: opts.share ?? SHARE_50,
      revenueSources: [await source.getAddress()],
    })
    await allocator.waitForDeployment()
  }

  // Builds a full ConstructorParams from the already-deployed stubs, with selected fields
  // overridden, for exercising the constructor's validation reverts.
  async function deployParams(
    overrides: Partial<BuybackAllocator.ConstructorParamsStruct> = {}
  ): Promise<BuybackAllocator.ConstructorParamsStruct> {
    return {
      admin: adminAddr,
      treasury: adminAddr,
      stEth: await stEth.getAddress(),
      oracleRouter: await oracle.getAddress(),
      executor: await executor.getAddress(),
      dailyCapUSD: DAILY_CAP,
      yearlyCapUSD: YEARLY_CAP,
      reserveDailyRateUSD: 0n,
      minStEthPriceUSD: 0n,
      minSpendPerCallUSD: MIN_SPEND,
      surplusShareBP: SHARE_50,
      revenueSources: [await source.getAddress()],
      ...overrides,
    }
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
    it('records the revenue sum as the baseline and anchors the reserve to the activation day', async function () {
      await deployAllocator({ reserveRate: usd('100') })
      await activateWith(usd('1000'))

      expect(await allocator.lastTotalRevenueUSD()).to.equal(usd('1000'))
      expect(await allocator.budgetUSD()).to.equal(0n)

      // Anchor is the activation day itself (today midnight), so the activation day reserve is charged.
      const activationTS = await allocator.activationTS()
      expect(await allocator.reserveAnchorTS()).to.equal(activationTS)
    })

    it('reverts activation when a source is unreachable', async function () {
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

    it('reverts a second activation', async function () {
      await deployAllocator()
      await allocator.activate()
      await expect(allocator.activate()).to.be.revertedWithCustomError(
        allocator,
        'AlreadyActivated'
      )
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

    it('skips when there is no available budget', async function () {
      await deployAllocator({ share: SHARE_100 })
      await activateWith(0n) // baseline equals current revenue → budget is zero

      await expect(allocator.allocate())
        .to.emit(allocator, 'AllocationSkipped')
        .withArgs(adminAddr, AllocationStatus.NoAvailableBudget)
    })

    it('allows a non-admin caller on the happy path', async function () {
      await deployAllocator({ share: SHARE_100 })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))
      await fund(usd('1000'))

      await expect(allocator.connect(stranger).allocate())
        .to.emit(allocator, 'Allocated')
        .withArgs(strangerAddr, await executor.getAddress(), usd('1000'), usd('1000'))
    })

    it('skips with QuoteUnavailable when the oracle returns a zero price', async function () {
      await deployAllocator({ share: SHARE_100 })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))
      await fund(usd('1000'))
      await oracle.setUsdPrice(0n, 0n)

      await expect(allocator.allocate())
        .to.emit(allocator, 'AllocationSkipped')
        .withArgs(adminAddr, AllocationStatus.QuoteUnavailable)
      expect(await allocator.budgetUSD()).to.equal(usd('1000'))
    })

    it('skips with AllocationBelowMin when the stETH balance is zero', async function () {
      await deployAllocator({ share: SHARE_100 })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))

      await expect(allocator.allocate())
        .to.emit(allocator, 'AllocationSkipped')
        .withArgs(adminAddr, AllocationStatus.AllocationBelowMin)
      expect(await allocator.budgetUSD()).to.equal(usd('1000'))
    })

    it('skips with AllocationBelowMin when the balance clamp pushes the amount below the minimum', async function () {
      await deployAllocator({ share: SHARE_100, minSpend: usd('100') })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))
      await fund(usd('50')) // the balance clamp restates the spend to 50, below the 100 minimum

      await expect(allocator.allocate())
        .to.emit(allocator, 'AllocationSkipped')
        .withArgs(adminAddr, AllocationStatus.AllocationBelowMin)
      expect(await allocator.budgetUSD()).to.equal(usd('1000'))
      expect(await stEth.balanceOf(await executor.getAddress())).to.equal(0n)
    })

    it('allocates when the spend equals the minimum per call', async function () {
      await deployAllocator({ share: SHARE_100, minSpend: usd('100') })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('100'))
      await fund(usd('100'))

      await expect(allocator.allocate())
        .to.emit(allocator, 'Allocated')
        .withArgs(adminAddr, await executor.getAddress(), usd('100'), usd('100'))
    })

    it('adds the spend to the daily and yearly windows', async function () {
      await deployAllocator({ share: SHARE_100 })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))
      await fund(usd('1000'))

      await allocator.allocate()

      const daily = await allocator.daily()
      const yearly = await allocator.yearly()
      expect(daily.spentUSD).to.equal(usd('1000'))
      expect(yearly.spentUSD).to.equal(usd('1000'))
    })
  })

  describe('yearly cap:', function () {
    it('clamps by the yearly remainder when tighter than the daily cap, then skips WindowCapReached', async function () {
      await deployAllocator({ share: SHARE_100, dailyCap: usd('300'), yearlyCap: usd('500') })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('10000'))
      await fund(usd('10000'))
      const ats = await allocator.activationTS()

      await allocator.allocate() // day 0: daily cap binds → 300

      // day 1: the daily window is fresh (300), but only 200 remains under the yearly cap
      await time.setNextBlockTimestamp(ats + ONE_DAY)
      await expect(allocator.allocate())
        .to.emit(allocator, 'Allocated')
        .withArgs(adminAddr, await executor.getAddress(), usd('200'), usd('200'))

      // the yearly window carried day 0's spend across the daily roll
      const yearly = await allocator.yearly()
      expect(yearly.spentUSD).to.equal(usd('500'))

      // yearly cap consumed → skip, even though the daily window has headroom
      await expect(allocator.allocate())
        .to.emit(allocator, 'AllocationSkipped')
        .withArgs(adminAddr, AllocationStatus.WindowCapReached)
    })

    it('resets the yearly window at the year boundary and allocates again', async function () {
      await deployAllocator({ share: SHARE_100, dailyCap: usd('300'), yearlyCap: usd('500') })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('10000'))
      await fund(usd('10000'))
      const ats = await allocator.activationTS()

      await allocator.allocate() // day 0: 300

      await time.setNextBlockTimestamp(ats + ONE_YEAR)
      await expect(allocator.allocate())
        .to.emit(allocator, 'WindowRolled')
        .withArgs(ONE_YEAR, ats + 2n * ONE_YEAR, usd('300'))

      const yearly = await allocator.yearly()
      expect(yearly.spentUSD).to.equal(usd('300')) // fresh window holds only the new spend
    })
  })

  describe('window rolling:', function () {
    it('rolls the daily window with the previous spend and grants the full cap again', async function () {
      await deployAllocator({ share: SHARE_100, dailyCap: usd('300') })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('10000'))
      await fund(usd('10000'))
      const ats = await allocator.activationTS()

      await allocator.allocate() // 300, exhausting the day
      await expect(allocator.allocate())
        .to.emit(allocator, 'AllocationSkipped')
        .withArgs(adminAddr, AllocationStatus.WindowCapReached)

      await time.setNextBlockTimestamp(ats + ONE_DAY)
      await expect(allocator.allocate())
        .to.emit(allocator, 'WindowRolled')
        .withArgs(ONE_DAY, ats + 2n * ONE_DAY, usd('300'))

      // the fresh window granted the full daily cap again
      expect(await stEth.balanceOf(await executor.getAddress())).to.equal(usd('600'))
    })

    it('rolls both windows in one call when both are stale', async function () {
      await deployAllocator({ share: SHARE_100, dailyCap: usd('300') })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('10000'))
      await fund(usd('10000'))
      const ats = await allocator.activationTS()

      await allocator.allocate()
      await time.setNextBlockTimestamp(ats + ONE_YEAR)

      const receipt = await (await allocator.allocate()).wait()
      const rolls = receipt!.logs
        .map((log) => allocator.interface.parseLog(log))
        .filter((e) => e?.name === 'WindowRolled')
      expect(rolls.map((e) => e!.args[0])).to.have.members([ONE_YEAR, ONE_DAY])
    })

    it('rolls to the next future boundary after several skipped windows', async function () {
      await deployAllocator({ share: SHARE_100 })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))
      await fund(usd('1000'))
      const ats = await allocator.activationTS()

      await time.setNextBlockTimestamp(ats + 10n * ONE_DAY + 12_345n)
      await allocator.allocate()

      const daily = await allocator.daily()
      expect(daily.endTS).to.equal(ats + 11n * ONE_DAY)
    })
  })

  describe('executor hook:', function () {
    it('transfers the stETH and emits Allocated before invoking the hook', async function () {
      await deployAllocator({ share: SHARE_100 })
      const observing = await new ObservingExecutorStub__factory(admin).deploy(
        await stEth.getAddress()
      )
      await allocator.setExecutor(await observing.getAddress())
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))
      await fund(usd('1000'))

      const receipt = await (await allocator.allocate()).wait()

      // the hook saw the transferred balance, so the transfer preceded it
      expect(await observing.balanceInHook()).to.equal(usd('1000'))

      const names = receipt!.logs
        .map(
          (log) => (allocator.interface.parseLog(log) ?? observing.interface.parseLog(log))?.name
        )
        .filter((name): name is string => !!name)
      expect(names.indexOf('Allocated')).to.be.greaterThanOrEqual(0)
      expect(names.indexOf('Allocated')).to.be.lessThan(names.indexOf('HookObserved'))
    })

    it('reverts the whole allocation when the hook reverts, leaving state and balances unchanged', async function () {
      const reverting = await new RevertingExecutorStub__factory(admin).deploy()
      await deployAllocator({ share: SHARE_100, executorAddr: await reverting.getAddress() })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))
      await fund(usd('1000'))

      await expect(allocator.allocate()).to.be.revertedWithCustomError(
        reverting,
        'RevertingExecutorStubFailure'
      )

      expect(await allocator.budgetUSD()).to.equal(0n) // the checkpoint rolled back too
      expect(await allocator.lastTotalRevenueUSD()).to.equal(0n)
      expect(await stEth.balanceOf(await allocator.getAddress())).to.equal(usd('1000'))
      expect(await stEth.balanceOf(await reverting.getAddress())).to.equal(0n)
      expect((await allocator.daily()).spentUSD).to.equal(0n)
    })

    it('reverts and fully rolls back when the stETH transfer fails', async function () {
      await deployAllocator({ share: SHARE_100 })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))
      await fund(usd('1000'))
      await stEth.setFailTransfers(true)

      await expect(allocator.allocate()).to.be.revertedWith(
        'SafeERC20: ERC20 operation did not succeed'
      )

      expect(await allocator.budgetUSD()).to.equal(0n)
      expect(await allocator.lastTotalRevenueUSD()).to.equal(0n)
      expect(await stEth.balanceOf(await allocator.getAddress())).to.equal(usd('1000'))
      expect(await stEth.balanceOf(await executor.getAddress())).to.equal(0n)
      expect((await allocator.daily()).spentUSD).to.equal(0n)
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

    it('accepts zero and stops the reserve accruing', async function () {
      await deployAllocator({ share: SHARE_100, reserveRate: usd('100') })
      await activateWith(0n)
      const activationTS = await allocator.activationTS()

      await allocator.setReserveDailyRateUSD(0n) // checkpoints: the activation day charged 100

      await source.setCumulativeRevenueUSD(usd('1000'))
      await time.setNextBlockTimestamp(activationTS + 10n * ONE_DAY)
      await allocator.allocate()

      expect(await allocator.budgetUSD()).to.equal(usd('900')) // -100 + 1000, no further reserve
    })

    it('accepts max uint128', async function () {
      await deployAllocator()
      await activateWith(0n)
      await allocator.setReserveDailyRateUSD(MAX_UINT128)
      expect(await allocator.reserveDailyRateUSD()).to.equal(MAX_UINT128)
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

    it('reverts when removing an unreachable source', async function () {
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

  describe('unreachable source:', function () {
    it('reverts budget updates while a source is unreachable and banks revenue once on recovery', async function () {
      await deployAllocator({ share: SHARE_100 })
      await activateWith(usd('1000'))

      // Sources are trusted, so a failed read blocks the update instead of counting as zero:
      // nothing is banked and the baseline is untouched.
      await source.setReverting(true)
      await expect(allocator.allocate()).to.be.reverted
      expect(await allocator.budgetUSD()).to.equal(0n)
      expect(await allocator.lastTotalRevenueUSD()).to.equal(usd('1000'))

      // The failed read blocks every path that sums revenue, not just allocate().
      await expect(allocator.spendable()).to.be.reverted
      const other = await new RevenueSourceStub__factory(admin).deploy()
      await expect(allocator.addRevenueSource(await other.getAddress())).to.be.reverted

      // On recovery the growth since the baseline (1000 → 2000) banks exactly once.
      await source.setReverting(false)
      await source.setCumulativeRevenueUSD(usd('2000'))
      await allocator.allocate()
      expect(await allocator.budgetUSD()).to.equal(usd('1000'))
    })

    it('reverts the checkpointing setters while a source is unreachable', async function () {
      await deployAllocator({ share: SHARE_100 })
      await activateWith(usd('1000'))
      await source.setReverting(true)

      await expect(allocator.setSurplusShareBP(1000n)).to.be.revertedWithCustomError(
        source,
        'RevenueSourceStubReverting'
      )
      await expect(allocator.setReserveDailyRateUSD(usd('1'))).to.be.revertedWithCustomError(
        source,
        'RevenueSourceStubReverting'
      )
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

    it('reports QuoteUnavailable when the oracle reverts', async function () {
      await deployAllocator({ share: SHARE_100 })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))
      await oracle.setFailureMode(OracleFailureMode.CustomError)

      const live = await allocator.spendable()
      expect(live.status).to.equal(BigInt(AllocationStatus.QuoteUnavailable))
      expect(live.spendableUSD).to.equal(0n)
      expect(live.spendableStEth).to.equal(0n)
    })

    it('reports QuoteUnavailable when the oracle returns a zero price', async function () {
      await deployAllocator({ share: SHARE_100 })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))
      await oracle.setUsdPrice(0n, 0n)

      const live = await allocator.spendable()
      expect(live.status).to.equal(BigInt(AllocationStatus.QuoteUnavailable))
      expect(live.spendableUSD).to.equal(0n)
      expect(live.spendableStEth).to.equal(0n)
    })

    it('reports StEthPriceBelowMin when the price is below the floor', async function () {
      await deployAllocator({ share: SHARE_100, minPrice: usd('2') })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))

      const live = await allocator.spendable()
      expect(live.status).to.equal(BigInt(AllocationStatus.StEthPriceBelowMin))
      expect(live.spendableUSD).to.equal(0n)
      expect(live.spendableStEth).to.equal(0n)
    })

    it('reports NoAvailableBudget when nothing is banked or pending', async function () {
      await deployAllocator({ share: SHARE_100 })
      await activateWith(0n)

      const live = await allocator.spendable()
      expect(live.status).to.equal(BigInt(AllocationStatus.NoAvailableBudget))
      expect(live.spendableUSD).to.equal(0n)
      expect(live.spendableStEth).to.equal(0n)
    })

    it('reports WindowCapReached when the daily cap is consumed', async function () {
      await deployAllocator({ share: SHARE_100, dailyCap: usd('300') })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))
      await fund(usd('1000'))
      await allocator.allocate() // spends the full 300 daily cap

      const live = await allocator.spendable()
      expect(live.status).to.equal(BigInt(AllocationStatus.WindowCapReached))
      expect(live.spendableUSD).to.equal(0n)
      expect(live.spendableStEth).to.equal(0n)
    })

    it('reports AllocationBelowMin when the restated amount is below the minimum', async function () {
      await deployAllocator({ share: SHARE_100, minSpend: usd('100') })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('50'))
      await fund(usd('1000'))

      const live = await allocator.spendable()
      expect(live.status).to.equal(BigInt(AllocationStatus.AllocationBelowMin))
      expect(live.spendableUSD).to.equal(0n)
      expect(live.spendableStEth).to.equal(0n)
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

    it('reverts setReserveDailyRateUSD() before activation', async function () {
      await deployAllocator()
      await expect(allocator.setReserveDailyRateUSD(usd('1'))).to.be.revertedWithCustomError(
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

  describe('deployment validation:', function () {
    beforeEach(async function () {
      // A valid deploy populates the stub references deployParams reads and gives an instance
      // whose interface decodes the custom errors asserted below.
      await deployAllocator()
    })

    it('reverts with StEthZeroAddress when stETH is the zero address', async function () {
      await expect(
        new BuybackAllocator__factory(admin).deploy(
          await deployParams({ stEth: ethers.ZeroAddress })
        )
      ).to.be.revertedWithCustomError(allocator, 'StEthZeroAddress')
    })

    it('reverts with OracleRouterZeroAddress when the oracle is the zero address', async function () {
      await expect(
        new BuybackAllocator__factory(admin).deploy(
          await deployParams({ oracleRouter: ethers.ZeroAddress })
        )
      ).to.be.revertedWithCustomError(allocator, 'OracleRouterZeroAddress')
    })

    it('reverts with RevenueSourceLimitReached one past the maximum', async function () {
      const max = await allocator.MAX_REVENUE_SOURCES()
      const sources: string[] = []
      for (let i = 0; i < Number(max) + 1; i++) {
        const s = await new RevenueSourceStub__factory(admin).deploy()
        await s.waitForDeployment()
        sources.push(await s.getAddress())
      }

      await expect(
        new BuybackAllocator__factory(admin).deploy(await deployParams({ revenueSources: sources }))
      )
        .to.be.revertedWithCustomError(allocator, 'RevenueSourceLimitReached')
        .withArgs(max)
    })

    it('accepts exactly the maximum number of sources', async function () {
      const max = await allocator.MAX_REVENUE_SOURCES()
      const sources: string[] = []
      for (let i = 0; i < Number(max); i++) {
        const s = await new RevenueSourceStub__factory(admin).deploy()
        await s.waitForDeployment()
        sources.push(await s.getAddress())
      }

      const full = await new BuybackAllocator__factory(admin).deploy(
        await deployParams({ revenueSources: sources })
      )
      expect((await full.revenueSources()).length).to.equal(Number(max))
    })

    it('reverts with ExecutorZeroAddress when the executor is the zero address', async function () {
      await expect(
        new BuybackAllocator__factory(admin).deploy(
          await deployParams({ executor: ethers.ZeroAddress })
        )
      ).to.be.revertedWithCustomError(allocator, 'ExecutorZeroAddress')
    })

    it('reverts with YearlyCapUSDZero when the yearly cap is zero', async function () {
      await expect(
        new BuybackAllocator__factory(admin).deploy(await deployParams({ yearlyCapUSD: 0n }))
      ).to.be.revertedWithCustomError(allocator, 'YearlyCapUSDZero')
    })

    it('reverts with DailyCapUSDZero when the daily cap is zero', async function () {
      await expect(
        new BuybackAllocator__factory(admin).deploy(await deployParams({ dailyCapUSD: 0n }))
      ).to.be.revertedWithCustomError(allocator, 'DailyCapUSDZero')
    })

    it('reverts with DailyCapExceedsYearlyCap when the daily cap exceeds the yearly cap', async function () {
      await expect(
        new BuybackAllocator__factory(admin).deploy(
          await deployParams({ dailyCapUSD: YEARLY_CAP + 1n })
        )
      ).to.be.revertedWithCustomError(allocator, 'DailyCapExceedsYearlyCap')
    })

    it('accepts a daily cap equal to the yearly cap', async function () {
      const a = await new BuybackAllocator__factory(admin).deploy(
        await deployParams({ dailyCapUSD: YEARLY_CAP })
      )
      expect(await a.dailyCapUSD()).to.equal(YEARLY_CAP)
    })

    it('reverts with MinSpendPerCallUSDZero when the minimum spend is zero', async function () {
      await expect(
        new BuybackAllocator__factory(admin).deploy(await deployParams({ minSpendPerCallUSD: 0n }))
      ).to.be.revertedWithCustomError(allocator, 'MinSpendPerCallUSDZero')
    })

    it('reverts with MinSpendPerCallExceedsDailyCap when the minimum spend exceeds the daily cap', async function () {
      await expect(
        new BuybackAllocator__factory(admin).deploy(
          await deployParams({ minSpendPerCallUSD: DAILY_CAP + 1n })
        )
      ).to.be.revertedWithCustomError(allocator, 'MinSpendPerCallExceedsDailyCap')
    })

    it('accepts a minimum spend equal to the daily cap', async function () {
      const a = await new BuybackAllocator__factory(admin).deploy(
        await deployParams({ minSpendPerCallUSD: DAILY_CAP })
      )
      expect(await a.minSpendPerCallUSD()).to.equal(DAILY_CAP)
    })

    it('reverts with SurplusShareBPInvalid when the share is zero', async function () {
      await expect(
        new BuybackAllocator__factory(admin).deploy(await deployParams({ surplusShareBP: 0n }))
      ).to.be.revertedWithCustomError(allocator, 'SurplusShareBPInvalid')
    })

    it('reverts with SurplusShareBPInvalid when the share exceeds MAX_BASIS_POINTS', async function () {
      await expect(
        new BuybackAllocator__factory(admin).deploy(
          await deployParams({ surplusShareBP: MAX_SHARE + 1n })
        )
      ).to.be.revertedWithCustomError(allocator, 'SurplusShareBPInvalid')
    })

    it('reverts with RevenueSourceZeroAddress when a source is the zero address', async function () {
      await expect(
        new BuybackAllocator__factory(admin).deploy(
          await deployParams({ revenueSources: [ethers.ZeroAddress] })
        )
      ).to.be.revertedWithCustomError(allocator, 'RevenueSourceZeroAddress')
    })

    it('reverts with RevenueSourceUnsupported when a source lacks the IRevenueSource interface', async function () {
      const bad = await stEth.getAddress()
      await expect(
        new BuybackAllocator__factory(admin).deploy(await deployParams({ revenueSources: [bad] }))
      )
        .to.be.revertedWithCustomError(allocator, 'RevenueSourceUnsupported')
        .withArgs(bad)
    })

    it('reverts with RevenueSourceAlreadyRegistered when a source is duplicated', async function () {
      const sourceAddr = await source.getAddress()
      await expect(
        new BuybackAllocator__factory(admin).deploy(
          await deployParams({ revenueSources: [sourceAddr, sourceAddr] })
        )
      ).to.be.revertedWithCustomError(allocator, 'RevenueSourceAlreadyRegistered')
    })

    it('reverts when a source revenue read fails during registration', async function () {
      await source.setReverting(true)
      await expect(
        new BuybackAllocator__factory(admin).deploy(await deployParams())
      ).to.be.revertedWithCustomError(source, 'RevenueSourceStubReverting')
    })
  })

  describe('deployment storage:', function () {
    it('stores TREASURY from the constructor params', async function () {
      await deployAllocator({ treasury: strangerAddr })
      expect(await allocator.TREASURY()).to.equal(strangerAddr)
    })

    it('stores yearlyCapUSD from the constructor params', async function () {
      await deployAllocator()
      expect(await allocator.yearlyCapUSD()).to.equal(YEARLY_CAP)
    })

    it('stores minStEthPriceUSD from the constructor params', async function () {
      await deployAllocator({ minPrice: usd('3') })
      expect(await allocator.minStEthPriceUSD()).to.equal(usd('3'))
    })

    it('emits RevenueSourceAdded for each source on the deployment transaction', async function () {
      await deployAllocator()
      const extra = await new RevenueSourceStub__factory(admin).deploy()
      const [sourceAddr, extraAddr] = [await source.getAddress(), await extra.getAddress()]

      const a = await new BuybackAllocator__factory(admin).deploy(
        await deployParams({ revenueSources: [sourceAddr, extraAddr] })
      )
      const tx = a.deploymentTransaction()

      await expect(tx).to.emit(a, 'RevenueSourceAdded').withArgs(sourceAddr)
      await expect(tx).to.emit(a, 'RevenueSourceAdded').withArgs(extraAddr)
    })

    it('deploys un-activated with an empty budget', async function () {
      await deployAllocator()
      expect(await allocator.activationTS()).to.equal(0n)
      expect(await allocator.budgetUSD()).to.equal(0n)
    })

    it('exposes the basis point and source count limits', async function () {
      await deployAllocator()
      expect(await allocator.MAX_BASIS_POINTS()).to.equal(MAX_SHARE)
      expect(await allocator.MAX_REVENUE_SOURCES()).to.equal(50n)
    })
  })

  describe('price unit:', function () {
    it('converts USD to stETH at the PRICE_UNIT read from the oracle router', async function () {
      await deployAllocator()
      const unit = 10n ** 8n
      const scaled = await new ScaledOracleRouterStub__factory(admin).deploy(unit)
      await scaled.setUsdPrice(2n * unit) // 2 USD per stETH at an 8-decimal price unit

      const a = await new BuybackAllocator__factory(admin).deploy(
        await deployParams({ oracleRouter: await scaled.getAddress(), surplusShareBP: SHARE_100 })
      )
      await a.activate()
      await source.setCumulativeRevenueUSD(usd('100'))
      await stEth.mint(await a.getAddress(), usd('100'))

      await expect(a.allocate())
        .to.emit(a, 'Allocated')
        .withArgs(adminAddr, await executor.getAddress(), usd('100'), usd('50'))
      expect(await stEth.balanceOf(await executor.getAddress())).to.equal(usd('50'))
    })
  })

  describe('access control:', function () {
    // Each admin-gated function reverts for a non-admin caller. The role check runs before any
    // activation or argument validation, so a fresh (un-activated) deploy is enough.
    const adminOnly: Array<{ name: string; call: (a: BuybackAllocator) => Promise<unknown> }> = [
      { name: 'activate', call: (a) => a.activate() },
      { name: 'setSurplusShareBP', call: (a) => a.setSurplusShareBP(SHARE_50) },
      { name: 'setReserveDailyRateUSD', call: (a) => a.setReserveDailyRateUSD(usd('1')) },
      { name: 'setDailyCapUSD', call: (a) => a.setDailyCapUSD(DAILY_CAP) },
      { name: 'setYearlyCapUSD', call: (a) => a.setYearlyCapUSD(YEARLY_CAP) },
      { name: 'setMinStEthPriceUSD', call: (a) => a.setMinStEthPriceUSD(0n) },
      { name: 'setMinSpendPerCallUSD', call: (a) => a.setMinSpendPerCallUSD(MIN_SPEND) },
      { name: 'setExecutor', call: (a) => a.setExecutor(strangerAddr) },
      { name: 'addRevenueSource', call: (a) => a.addRevenueSource(strangerAddr) },
      { name: 'removeRevenueSource', call: (a) => a.removeRevenueSource(strangerAddr) },
      { name: 'grantRole', call: (a) => a.grantRole(ethers.ZeroHash, strangerAddr) },
      { name: 'revokeRole', call: (a) => a.revokeRole(ethers.ZeroHash, adminAddr) },
    ]

    beforeEach(async function () {
      await deployAllocator()
    })

    for (const { name, call } of adminOnly) {
      it(`reverts ${name}() for a non-admin caller`, async function () {
        // OZ v4 AccessControl reverts when the role (DEFAULT_ADMIN_ROLE = 0x0) is missing
        await expect(call(allocator.connect(stranger))).to.be.revertedWith(
          missingRoleMessage(strangerAddr, ethers.ZeroHash)
        )
      })
    }
  })

  describe('parameter setters:', function () {
    beforeEach(async function () {
      await deployAllocator()
    })

    it('setDailyCapUSD updates the cap and emits', async function () {
      await expect(allocator.setDailyCapUSD(usd('500000')))
        .to.emit(allocator, 'DailyCapUSDSet')
        .withArgs(usd('500000'))
      expect(await allocator.dailyCapUSD()).to.equal(usd('500000'))
    })

    it('setDailyCapUSD reverts on zero', async function () {
      await expect(allocator.setDailyCapUSD(0n)).to.be.revertedWithCustomError(
        allocator,
        'DailyCapUSDZero'
      )
    })

    it('setDailyCapUSD reverts above the yearly cap', async function () {
      await expect(allocator.setDailyCapUSD(YEARLY_CAP + 1n)).to.be.revertedWithCustomError(
        allocator,
        'DailyCapExceedsYearlyCap'
      )
    })

    it('setDailyCapUSD reverts below the minimum spend', async function () {
      // default minimum spend is 1 USD; a cap under it is rejected
      await expect(allocator.setDailyCapUSD(usd('0.5'))).to.be.revertedWithCustomError(
        allocator,
        'MinSpendPerCallExceedsDailyCap'
      )
    })

    it('setYearlyCapUSD updates the cap and emits', async function () {
      await expect(allocator.setYearlyCapUSD(usd('20000000')))
        .to.emit(allocator, 'YearlyCapUSDSet')
        .withArgs(usd('20000000'))
      expect(await allocator.yearlyCapUSD()).to.equal(usd('20000000'))
    })

    it('setYearlyCapUSD reverts on zero', async function () {
      await expect(allocator.setYearlyCapUSD(0n)).to.be.revertedWithCustomError(
        allocator,
        'YearlyCapUSDZero'
      )
    })

    it('setYearlyCapUSD reverts below the daily cap', async function () {
      await expect(allocator.setYearlyCapUSD(usd('500000'))).to.be.revertedWithCustomError(
        allocator,
        'DailyCapExceedsYearlyCap'
      )
    })

    it('setMinSpendPerCallUSD updates the floor and emits', async function () {
      await expect(allocator.setMinSpendPerCallUSD(usd('2')))
        .to.emit(allocator, 'MinSpendPerCallUSDSet')
        .withArgs(usd('2'))
      expect(await allocator.minSpendPerCallUSD()).to.equal(usd('2'))
    })

    it('setMinSpendPerCallUSD reverts on zero', async function () {
      await expect(allocator.setMinSpendPerCallUSD(0n)).to.be.revertedWithCustomError(
        allocator,
        'MinSpendPerCallUSDZero'
      )
    })

    it('setMinSpendPerCallUSD reverts above the daily cap', async function () {
      await expect(allocator.setMinSpendPerCallUSD(DAILY_CAP + 1n)).to.be.revertedWithCustomError(
        allocator,
        'MinSpendPerCallExceedsDailyCap'
      )
    })

    it('setMinStEthPriceUSD updates the floor and emits', async function () {
      await expect(allocator.setMinStEthPriceUSD(usd('1000')))
        .to.emit(allocator, 'MinStEthPriceUSDSet')
        .withArgs(usd('1000'))
      expect(await allocator.minStEthPriceUSD()).to.equal(usd('1000'))
    })

    it('setExecutor updates the receiver and emits', async function () {
      const next = await new ExecutorStub__factory(admin).deploy()
      const nextAddr = await next.getAddress()
      await expect(allocator.setExecutor(nextAddr))
        .to.emit(allocator, 'ExecutorSet')
        .withArgs(nextAddr)
      expect(await allocator.executor()).to.equal(nextAddr)
    })

    it('setExecutor reverts on the zero address', async function () {
      await expect(allocator.setExecutor(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        allocator,
        'ExecutorZeroAddress'
      )
    })

    it('setDailyCapUSD accepts a value equal to the yearly cap', async function () {
      await allocator.setDailyCapUSD(YEARLY_CAP)
      expect(await allocator.dailyCapUSD()).to.equal(YEARLY_CAP)
    })

    it('setDailyCapUSD accepts a value equal to the minimum spend', async function () {
      await allocator.setDailyCapUSD(MIN_SPEND)
      expect(await allocator.dailyCapUSD()).to.equal(MIN_SPEND)
    })

    it('setYearlyCapUSD accepts a value equal to the daily cap', async function () {
      await allocator.setYearlyCapUSD(DAILY_CAP)
      expect(await allocator.yearlyCapUSD()).to.equal(DAILY_CAP)
    })

    it('setYearlyCapUSD accepts max uint128', async function () {
      await allocator.setYearlyCapUSD(MAX_UINT128)
      expect(await allocator.yearlyCapUSD()).to.equal(MAX_UINT128)
    })

    it('setMinSpendPerCallUSD accepts a value equal to the daily cap', async function () {
      await allocator.setMinSpendPerCallUSD(DAILY_CAP)
      expect(await allocator.minSpendPerCallUSD()).to.equal(DAILY_CAP)
    })

    it('setMinStEthPriceUSD accepts max uint128', async function () {
      await allocator.setMinStEthPriceUSD(MAX_UINT128)
      expect(await allocator.minStEthPriceUSD()).to.equal(MAX_UINT128)
    })

    it('rejects values beyond uint128 via SafeCast instead of truncating', async function () {
      await expect(allocator.setDailyCapUSD(2n ** 128n)).to.be.revertedWith(
        "SafeCast: value doesn't fit in 128 bits"
      )
      await expect(allocator.setYearlyCapUSD(2n ** 128n)).to.be.revertedWith(
        "SafeCast: value doesn't fit in 128 bits"
      )
      await expect(allocator.setMinSpendPerCallUSD(2n ** 128n)).to.be.revertedWith(
        "SafeCast: value doesn't fit in 128 bits"
      )
      await expect(allocator.setMinStEthPriceUSD(2n ** 128n)).to.be.revertedWith(
        "SafeCast: value doesn't fit in 128 bits"
      )
    })
  })

  describe('setter effects:', function () {
    it('plain setters do not checkpoint pending revenue', async function () {
      await deployAllocator({ share: SHARE_100 })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000')) // pending, not banked

      await allocator.setDailyCapUSD(usd('500000'))
      await allocator.setYearlyCapUSD(usd('20000000'))
      await allocator.setMinStEthPriceUSD(usd('1'))
      await allocator.setMinSpendPerCallUSD(usd('2'))
      const next = await new ExecutorStub__factory(admin).deploy()
      await allocator.setExecutor(await next.getAddress())

      expect(await allocator.budgetUSD()).to.equal(0n)
      expect(await allocator.lastTotalRevenueUSD()).to.equal(0n)
    })

    it('setDailyCapUSD applies mid-window: lowering below the spent total pauses, raising re-opens', async function () {
      await deployAllocator({ share: SHARE_100 })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))
      await fund(usd('10000'))
      await allocator.allocate() // daily spent 1000

      await source.setCumulativeRevenueUSD(usd('2000')) // fresh budget for the next calls
      await allocator.setDailyCapUSD(usd('500')) // below the 1000 already spent this window
      await expect(allocator.allocate())
        .to.emit(allocator, 'AllocationSkipped')
        .withArgs(adminAddr, AllocationStatus.WindowCapReached)

      await allocator.setDailyCapUSD(usd('2000')) // re-opens 1000 of headroom
      await expect(allocator.allocate())
        .to.emit(allocator, 'Allocated')
        .withArgs(adminAddr, await executor.getAddress(), usd('1000'), usd('1000'))
    })

    it('setYearlyCapUSD applies mid-window: lowering below the yearly spent pauses allocations', async function () {
      await deployAllocator({ share: SHARE_100, dailyCap: usd('300') })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('10000'))
      await fund(usd('10000'))
      const ats = await allocator.activationTS()

      await allocator.allocate() // day 0: 300
      await time.setNextBlockTimestamp(ats + ONE_DAY)
      await allocator.allocate() // day 1: 300 → yearly spent 600

      await allocator.setYearlyCapUSD(usd('500')) // below the 600 already spent this year
      await time.setNextBlockTimestamp(ats + 2n * ONE_DAY) // fresh daily window: only the yearly cap binds
      await expect(allocator.allocate())
        .to.emit(allocator, 'AllocationSkipped')
        .withArgs(adminAddr, AllocationStatus.WindowCapReached)
    })

    it('setExecutor routes the next allocation to the new executor', async function () {
      await deployAllocator({ share: SHARE_100 })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))
      await fund(usd('1000'))

      const next = await new ExecutorStub__factory(admin).deploy()
      const nextAddr = await next.getAddress()
      await allocator.setExecutor(nextAddr)

      await expect(allocator.allocate())
        .to.emit(allocator, 'Allocated')
        .withArgs(adminAddr, nextAddr, usd('1000'), usd('1000'))
      expect(await stEth.balanceOf(nextAddr)).to.equal(usd('1000'))
      expect(await next.onStEthAllocatedCount()).to.equal(1n)
      expect(await stEth.balanceOf(await executor.getAddress())).to.equal(0n)
      expect(await executor.onStEthAllocatedCount()).to.equal(0n)
    })
  })

  describe('surplus share:', function () {
    beforeEach(async function () {
      await deployAllocator()
      await activateWith(0n)
    })

    it('setSurplusShareBP updates the share and emits', async function () {
      await expect(allocator.setSurplusShareBP(2000n))
        .to.emit(allocator, 'SurplusShareBPSet')
        .withArgs(2000n)
      expect(await allocator.surplusShareBP()).to.equal(2000n)
    })

    it('setSurplusShareBP reverts on a zero share', async function () {
      await expect(allocator.setSurplusShareBP(0n)).to.be.revertedWithCustomError(
        allocator,
        'SurplusShareBPInvalid'
      )
    })

    it('setSurplusShareBP reverts above 100%', async function () {
      await expect(allocator.setSurplusShareBP(MAX_SHARE + 1n)).to.be.revertedWithCustomError(
        allocator,
        'SurplusShareBPInvalid'
      )
    })

    it('setSurplusShareBP accepts exactly MAX_BASIS_POINTS', async function () {
      await expect(allocator.setSurplusShareBP(MAX_SHARE))
        .to.emit(allocator, 'SurplusShareBPSet')
        .withArgs(MAX_SHARE)
      expect(await allocator.surplusShareBP()).to.equal(MAX_SHARE)
    })

    it('setSurplusShareBP rejects values beyond uint16 via SafeCast', async function () {
      await expect(allocator.setSurplusShareBP(70_000n)).to.be.revertedWith(
        "SafeCast: value doesn't fit in 16 bits"
      )
    })
  })

  describe('revenue source management:', function () {
    beforeEach(async function () {
      await deployAllocator()
      await activateWith(0n)
    })

    it('addRevenueSource registers and emits RevenueSourceAdded', async function () {
      const extra = await new RevenueSourceStub__factory(admin).deploy()
      const extraAddr = await extra.getAddress()
      await expect(allocator.addRevenueSource(extraAddr))
        .to.emit(allocator, 'RevenueSourceAdded')
        .withArgs(extraAddr)
    })

    it('addRevenueSource reverts on the zero address', async function () {
      await expect(allocator.addRevenueSource(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        allocator,
        'RevenueSourceZeroAddress'
      )
    })

    it('addRevenueSource reverts on an unsupported interface', async function () {
      // the stETH stub does not implement IRevenueSource
      const bad = await stEth.getAddress()
      await expect(allocator.addRevenueSource(bad))
        .to.be.revertedWithCustomError(allocator, 'RevenueSourceUnsupported')
        .withArgs(bad)
    })

    it('addRevenueSource reverts on a duplicate', async function () {
      await expect(
        allocator.addRevenueSource(await source.getAddress())
      ).to.be.revertedWithCustomError(allocator, 'RevenueSourceAlreadyRegistered')
    })

    it('removeRevenueSource unregisters and emits RevenueSourceRemoved', async function () {
      const sourceAddr = await source.getAddress()
      await expect(allocator.removeRevenueSource(sourceAddr))
        .to.emit(allocator, 'RevenueSourceRemoved')
        .withArgs(sourceAddr)
    })

    it('removeRevenueSource reverts when the source is not registered', async function () {
      const extra = await new RevenueSourceStub__factory(admin).deploy()
      await expect(
        allocator.removeRevenueSource(await extra.getAddress())
      ).to.be.revertedWithCustomError(allocator, 'RevenueSourceNotRegistered')
    })

    it('addRevenueSource fills up to the maximum and rejects the next one', async function () {
      const max = await allocator.MAX_REVENUE_SOURCES()
      for (let i = 1; i < Number(max); i++) {
        const s = await new RevenueSourceStub__factory(admin).deploy()
        await s.waitForDeployment()
        await allocator.addRevenueSource(await s.getAddress())
      }
      expect((await allocator.revenueSources()).length).to.equal(Number(max))

      const extra = await new RevenueSourceStub__factory(admin).deploy()
      await expect(allocator.addRevenueSource(await extra.getAddress()))
        .to.be.revertedWithCustomError(allocator, 'RevenueSourceLimitReached')
        .withArgs(max)
    })

    it('preserves the remaining sources as a set after removal', async function () {
      const b = await new RevenueSourceStub__factory(admin).deploy()
      const c = await new RevenueSourceStub__factory(admin).deploy()
      const [bAddr, cAddr] = [await b.getAddress(), await c.getAddress()]
      await allocator.addRevenueSource(bAddr)
      await allocator.addRevenueSource(cAddr)

      await allocator.removeRevenueSource(bAddr)

      expect([...(await allocator.revenueSources())]).to.have.members([
        await source.getAddress(),
        cAddr,
      ])
    })
  })

  describe('revenueSources getter:', function () {
    it('returns the sources registered at construction', async function () {
      await deployAllocator()

      expect(await allocator.revenueSources()).to.deep.equal([await source.getAddress()])
    })

    it('returns every constructor source when constructed with multiple sources', async function () {
      await deployAllocator()
      const extra = await new RevenueSourceStub__factory(admin).deploy()
      const [sourceAddr, extraAddr] = [await source.getAddress(), await extra.getAddress()]

      const multi = await new BuybackAllocator__factory(admin).deploy(
        await deployParams({ revenueSources: [sourceAddr, extraAddr] })
      )
      expect(await multi.revenueSources()).to.deep.equal([sourceAddr, extraAddr])
    })

    it('returns an empty array when constructed with no sources', async function () {
      await deployAllocator()
      const empty = await new BuybackAllocator__factory(admin).deploy(
        await deployParams({ revenueSources: [] })
      )

      expect(await empty.revenueSources()).to.deep.equal([])
    })

    it('reflects a source added after construction', async function () {
      await deployAllocator()
      await activateWith(0n)
      const extra = await new RevenueSourceStub__factory(admin).deploy()
      const extraAddr = await extra.getAddress()
      await allocator.addRevenueSource(extraAddr)

      expect(await allocator.revenueSources()).to.deep.equal([await source.getAddress(), extraAddr])
    })

    it('omits a source removed after construction', async function () {
      await deployAllocator()
      await activateWith(0n)
      const extra = await new RevenueSourceStub__factory(admin).deploy()
      const extraAddr = await extra.getAddress()
      await allocator.addRevenueSource(extraAddr)

      // EnumerableSet.remove swaps the last element into the removed slot, so removing the first
      // source leaves the later one in its place.
      await allocator.removeRevenueSource(await source.getAddress())

      expect(await allocator.revenueSources()).to.deep.equal([extraAddr])
    })
  })

  describe('price floor:', function () {
    it('skips the allocation when the stETH price is below the minimum', async function () {
      await deployAllocator({ share: SHARE_100 })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))
      await fund(usd('1000'))
      await allocator.setMinStEthPriceUSD(usd('2')) // price is 1 USD, floor is 2 USD

      await expect(allocator.allocate())
        .to.emit(allocator, 'AllocationSkipped')
        .withArgs(adminAddr, AllocationStatus.StEthPriceBelowMin)

      // the checkpoint still banks; only the transfer is withheld
      expect(await allocator.budgetUSD()).to.equal(usd('1000'))
      expect(await stEth.balanceOf(await executor.getAddress())).to.equal(0n)
    })

    it('allocates when the price equals the minimum', async function () {
      await deployAllocator({ share: SHARE_100, minPrice: PRICE }) // floor == the 1 USD price
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))
      await fund(usd('1000'))

      await expect(allocator.allocate())
        .to.emit(allocator, 'Allocated')
        .withArgs(adminAddr, await executor.getAddress(), usd('1000'), usd('1000'))
    })

    it('setMinStEthPriceUSD accepts zero and disables the price floor gate', async function () {
      await deployAllocator({ share: SHARE_100, minPrice: usd('2') }) // floor above the 1 USD price
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))
      await fund(usd('1000'))

      await expect(allocator.allocate())
        .to.emit(allocator, 'AllocationSkipped')
        .withArgs(adminAddr, AllocationStatus.StEthPriceBelowMin)

      await allocator.setMinStEthPriceUSD(0n)
      await expect(allocator.allocate())
        .to.emit(allocator, 'Allocated')
        .withArgs(adminAddr, await executor.getAddress(), usd('1000'), usd('1000'))
    })
  })

  describe('reentrancy guard:', function () {
    it('reverts allocate() when the executor re-enters', async function () {
      const reentrant = await new ReentrantExecutorStub__factory(admin).deploy()
      await deployAllocator({ share: SHARE_100, executorAddr: await reentrant.getAddress() })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))
      await fund(usd('1000'))

      await expect(allocator.allocate()).to.be.revertedWith('ReentrancyGuard: reentrant call')
    })
  })

  describe('events:', function () {
    it('activation emits Activated and ReserveAnchored and rolls both windows', async function () {
      await deployAllocator()
      await source.setCumulativeRevenueUSD(usd('1000'))

      const tx = await allocator.activate()
      const ats = await allocator.activationTS()

      await expect(tx).to.emit(allocator, 'Activated').withArgs(ats, usd('1000'))
      await expect(tx).to.emit(allocator, 'ReserveAnchored').withArgs(ats)
      await expect(tx)
        .to.emit(allocator, 'WindowRolled')
        .withArgs(ONE_DAY, ats + ONE_DAY, 0n)
      await expect(tx)
        .to.emit(allocator, 'WindowRolled')
        .withArgs(ONE_YEAR, ats + ONE_YEAR, 0n)
    })

    it('a checkpoint emits Checkpoint with the banked delta', async function () {
      await deployAllocator({ share: SHARE_50 })
      await activateWith(0n)
      await source.setCumulativeRevenueUSD(usd('1000'))

      // no balance → the allocation skips, but the checkpoint still banks 50% of the new revenue
      await expect(allocator.allocate())
        .to.emit(allocator, 'Checkpoint')
        .withArgs(usd('1000'), 0n, usd('500'), usd('500'))
    })

    it('setReserveDailyRateUSD emits ReserveDailyRateUSDSet', async function () {
      await deployAllocator({ reserveRate: usd('100') })
      await activateWith(0n)

      await expect(allocator.setReserveDailyRateUSD(usd('50')))
        .to.emit(allocator, 'ReserveDailyRateUSDSet')
        .withArgs(usd('50'))
    })

    it('a checkpoint emits ReserveAnchored with the next day start', async function () {
      await deployAllocator({ share: SHARE_100 })
      await activateWith(0n)
      const ats = await allocator.activationTS()
      await source.setCumulativeRevenueUSD(usd('1000'))

      await expect(allocator.allocate())
        .to.emit(allocator, 'ReserveAnchored')
        .withArgs(ats + ONE_DAY)
    })
  })

  describe('asset recovery and roles:', function () {
    it('lets a manager move not-yet-allocated stETH to the treasury', async function () {
      await deployAllocator({ treasury: strangerAddr })
      await fund(usd('1000'))
      const stEthAddr = await stEth.getAddress()
      await allocator.grantRole(await allocator.MANAGER_ROLE(), adminAddr)

      await expect(allocator.recoverERC20(stEthAddr, usd('600')))
        .to.emit(allocator, 'ERC20Recovered')
        .withArgs(stEthAddr, usd('600'))

      expect(await stEth.balanceOf(strangerAddr)).to.equal(usd('600'))
      expect(await stEth.balanceOf(await allocator.getAddress())).to.equal(usd('400'))
    })

    it('blocks recovery after the manager role is revoked or renounced', async function () {
      await deployAllocator()
      await fund(usd('100'))
      const role = await allocator.MANAGER_ROLE()
      const stEthAddr = await stEth.getAddress()
      const missingManager = missingRoleMessage(strangerAddr, role)

      await allocator.grantRole(role, strangerAddr)
      await allocator.connect(stranger).recoverERC20(stEthAddr, usd('10'))

      await allocator.revokeRole(role, strangerAddr)
      await expect(
        allocator.connect(stranger).recoverERC20(stEthAddr, usd('10'))
      ).to.be.revertedWith(missingManager)

      await allocator.grantRole(role, strangerAddr)
      await allocator.connect(stranger).renounceRole(role, strangerAddr)
      await expect(allocator.connect(stranger).recoverEther()).to.be.revertedWith(missingManager)
    })

    it('hands the admin role over to a new account', async function () {
      await deployAllocator()

      await allocator.grantRole(ethers.ZeroHash, strangerAddr)
      await allocator.connect(stranger).revokeRole(ethers.ZeroHash, adminAddr)

      await expect(allocator.setDailyCapUSD(usd('500000'))).to.be.revertedWith(
        missingRoleMessage(adminAddr, ethers.ZeroHash)
      )
      await expect(allocator.connect(stranger).setDailyCapUSD(usd('500000')))
        .to.emit(allocator, 'DailyCapUSDSet')
        .withArgs(usd('500000'))
    })
  })
})
