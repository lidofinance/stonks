import { ethers } from 'hardhat'
import { expect } from 'chai'
import { PRICE_UNIT } from '../helpers/buyback-executor'
import { LIDO_LOCATOR_ADDRESS, ORACLE_ROUTER_ADDRESS } from '../helpers/buyback-scenario'

// Fill this from the deployment under review before running. An empty address skips the suite.
const STAKING_REVENUE_SOURCE_ADDRESS: string = ''

const getRevenueSource = () =>
  ethers.getContractAt('StakingRevenueSource', STAKING_REVENUE_SOURCE_ADDRESS)

describe('StakingRevenueSource: acceptance', function () {
  it('should wire the deployed source to the expected oracle router and Lido locator', async function () {
    if (STAKING_REVENUE_SOURCE_ADDRESS === '') this.skip()

    const revenueSource = await getRevenueSource()

    expect(await revenueSource.ORACLE_ROUTER()).to.hexEqual(ORACLE_ROUTER_ADDRESS)
    expect(await revenueSource.LIDO_LOCATOR()).to.hexEqual(LIDO_LOCATOR_ADDRESS)
    expect(await revenueSource.PRICE_UNIT()).to.equal(PRICE_UNIT)
  })

  it('should hold a pristine revenue state before the first rebase report', async function () {
    if (STAKING_REVENUE_SOURCE_ADDRESS === '') this.skip()

    const revenueSource = await getRevenueSource()

    // Holds until the source is registered as a notifier observer by the governance vote and
    // the first fee-minting rebase lands.
    expect(await revenueSource.pendingRevenueStEth()).to.equal(0n)
    expect(await revenueSource.getCumulativeRevenueUSD()).to.equal(0n)
    expect(await revenueSource.lastReportTimestamp()).to.equal(0n)
  })
})
