import { ethers } from 'hardhat'
import { expect } from 'chai'
import { getContracts } from '../../utils/contracts'

const STONKS_FACTORY_ADDRESS = ''

describe('StonksFactory: acceptance', async function () {
  it('should have correct agent address', async function () {
    if (STONKS_FACTORY_ADDRESS === '') this.skip()
    const contracts = await getContracts()
    const stonksFactory = await ethers.getContractAt('StonksFactory', STONKS_FACTORY_ADDRESS)

    const agentSetFilter = stonksFactory.filters['AgentSet(address)']
    const orderSampleDeployedFilter = stonksFactory.filters['OrderSampleDeployed(address)']

    const agentSetEvents = await stonksFactory.queryFilter(agentSetFilter)
    const orderSampleDeployedEvents = await stonksFactory.queryFilter(orderSampleDeployedFilter)

    expect(agentSetEvents.length).to.equal(1)
    expect(orderSampleDeployedEvents.length).to.equal(1)

    expect(agentSetEvents[0].args[0]).to.equal(contracts.AGENT)

    expect(await stonksFactory.AGENT()).to.equal(contracts.AGENT)
  })
})
