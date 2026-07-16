import { ethers } from 'hardhat'
import { expect } from 'chai'
import { getContracts } from '../../utils/contracts'
import { DEFAULT_ADMIN_ROLE } from '../helpers/buyback-executor'
import { ORACLE_ROUTER_ADDRESS } from '../helpers/buyback-scenario'

// Fill these from the deployment under review before running. An empty allocator address skips the
// whole suite; the other fields are guarded so a half-filled template fails loudly.
const BUYBACK_ALLOCATOR_ADDRESS: string = ''
const EXECUTOR_ADDRESS: string = ''
const STAKING_REVENUE_SOURCE_ADDRESS: string = ''

// Configurable limits as deployed. All but the stETH price floor are non-zero by construction.
const EXPECTED_DAILY_CAP_USD: bigint = 0n
const EXPECTED_YEARLY_CAP_USD: bigint = 0n
const EXPECTED_RESERVE_DAILY_RATE_USD: bigint = 0n
const EXPECTED_MIN_SPEND_PER_CALL_USD: bigint = 0n
const EXPECTED_SURPLUS_SHARE_BP: bigint = 0n
// Zero disables the floor and is the planned launch value, so it carries no template guard.
const EXPECTED_MIN_STETH_PRICE_USD: bigint = 0n

const getAllocator = () => ethers.getContractAt('BuybackAllocator', BUYBACK_ALLOCATOR_ADDRESS)

describe('BuybackAllocator: acceptance', function () {
  it('should wire the deployed allocator to the expected stETH, oracle, executor, treasury, and admin', async function () {
    if (BUYBACK_ALLOCATOR_ADDRESS === '') this.skip()

    expect(EXECUTOR_ADDRESS).to.not.equal('')

    const contracts = getContracts()
    const buybackAllocator = await getAllocator()

    expect(await buybackAllocator.STETH()).to.hexEqual(contracts.STETH)
    expect(await buybackAllocator.ORACLE_ROUTER()).to.hexEqual(ORACLE_ROUTER_ADDRESS)
    expect(await buybackAllocator.executor()).to.hexEqual(EXECUTOR_ADDRESS)
    expect(await buybackAllocator.TREASURY()).to.hexEqual(contracts.AGENT)
    expect(await buybackAllocator.hasRole(DEFAULT_ADMIN_ROLE, contracts.ADMIN)).to.equal(true)
  })

  it('should register the staking revenue source as the only revenue source', async function () {
    if (BUYBACK_ALLOCATOR_ADDRESS === '') this.skip()

    expect(STAKING_REVENUE_SOURCE_ADDRESS).to.not.equal('')

    const buybackAllocator = await getAllocator()

    expect(await buybackAllocator.revenueSources()).to.deep.equal([
      ethers.getAddress(STAKING_REVENUE_SOURCE_ADDRESS),
    ])
  })

  it('should hold the expected caps, reserve rate, spend floor, and surplus share', async function () {
    if (BUYBACK_ALLOCATOR_ADDRESS === '') this.skip()

    expect(EXPECTED_DAILY_CAP_USD).to.not.equal(0n)
    expect(EXPECTED_YEARLY_CAP_USD).to.not.equal(0n)
    expect(EXPECTED_RESERVE_DAILY_RATE_USD).to.not.equal(0n)
    expect(EXPECTED_MIN_SPEND_PER_CALL_USD).to.not.equal(0n)
    expect(EXPECTED_SURPLUS_SHARE_BP).to.not.equal(0n)

    const buybackAllocator = await getAllocator()

    expect(await buybackAllocator.dailyCapUSD()).to.equal(EXPECTED_DAILY_CAP_USD)
    expect(await buybackAllocator.yearlyCapUSD()).to.equal(EXPECTED_YEARLY_CAP_USD)
    expect(await buybackAllocator.reserveDailyRateUSD()).to.equal(
      EXPECTED_RESERVE_DAILY_RATE_USD
    )
    expect(await buybackAllocator.minSpendPerCallUSD()).to.equal(EXPECTED_MIN_SPEND_PER_CALL_USD)
    expect(await buybackAllocator.surplusShareBP()).to.equal(EXPECTED_SURPLUS_SHARE_BP)
    expect(await buybackAllocator.minStEthPriceUSD()).to.equal(EXPECTED_MIN_STETH_PRICE_USD)
  })

  it('should await activation with pristine accounting and an inert keeper interface', async function () {
    if (BUYBACK_ALLOCATOR_ADDRESS === '') this.skip()

    const buybackAllocator = await getAllocator()

    // Pre-vote launch state: nothing accrued, nothing anchored, spend windows unarmed. Holds
    // until the governance vote activates the allocator.
    expect(await buybackAllocator.activationTS()).to.equal(0n)
    expect(await buybackAllocator.budgetUSD()).to.equal(0n)
    expect(await buybackAllocator.lastTotalRevenueUSD()).to.equal(0n)
    expect(await buybackAllocator.reserveAnchorTS()).to.equal(0n)
    const daily = await buybackAllocator.daily()
    const yearly = await buybackAllocator.yearly()
    expect(daily.endTS).to.equal(0n)
    expect(daily.spentUSD).to.equal(0n)
    expect(yearly.endTS).to.equal(0n)
    expect(yearly.spentUSD).to.equal(0n)

    // Until activation neither the keeper preview nor a release can run.
    await expect(buybackAllocator.spendable()).to.be.revertedWithCustomError(
      buybackAllocator,
      'NotActivated'
    )
    await expect(buybackAllocator.allocate()).to.be.revertedWithCustomError(
      buybackAllocator,
      'NotActivated'
    )
  })
})
