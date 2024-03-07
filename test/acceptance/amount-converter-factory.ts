import { ethers } from 'hardhat'
import { expect } from 'chai'
import { getContracts } from '../../utils/contracts'

const AMOUNT_CONVERTER_FACTORY_ADDRESS: string = ''

describe('AmountConverterFactory: acceptance', async function () {
  it('should have correct chainlink feed registry', async function () {
    if (AMOUNT_CONVERTER_FACTORY_ADDRESS === '') this.skip()
    const contracts = await getContracts()
    const amountConverterFactory = await ethers.getContractAt(
      'AmountConverterFactory',
      AMOUNT_CONVERTER_FACTORY_ADDRESS
    )
    const feedRegistrySet = amountConverterFactory.filters['FeedRegistrySet(address)']
    const feedRegistrySetEvents = await amountConverterFactory.queryFilter(feedRegistrySet)

    expect(feedRegistrySetEvents.length).to.equal(1)
    expect(feedRegistrySetEvents[0].args[0]).to.equal(
      ethers.getAddress(contracts.CHAINLINK_PRICE_FEED_REGISTRY)
    )

    expect(await amountConverterFactory.FEED_REGISTRY()).to.equal(
      ethers.getAddress(contracts.CHAINLINK_PRICE_FEED_REGISTRY)
    )
  })
})
