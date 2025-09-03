import { ethers } from 'hardhat'
import { expect } from 'chai'
import { getTokensToBuy, getTokensToSell, getPriceFeedTimeouts } from './configuration'
import { getContracts } from '../../utils/contracts'

const AMOUNT_CONVERTER_ADDRESS: string = ''

describe('AmountConverter: acceptance', async function () {
  it('should have correct params', async function () {
    if (AMOUNT_CONVERTER_ADDRESS === '') this.skip()
    const contracts = getContracts()
    const tokensToSell = (await getTokensToSell()).map((token) => ethers.getAddress(token))
    const tokensToBuy = (await getTokensToBuy()).map((token) => ethers.getAddress(token))
    const priceFeedTimeouts = await getPriceFeedTimeouts()

    const amountConverter = await ethers.getContractAt('AmountConverter', AMOUNT_CONVERTER_ADDRESS)

    for (const token of tokensToSell) {
      expect(await amountConverter.allowedTokensToSell(token)).to.equal(true)
    }

    for (const token of tokensToBuy) {
      expect(await amountConverter.allowedTokensToBuy(token)).to.equal(true)
    }

    const allowedTokenToBuyAddedFilter = amountConverter.filters['AllowedTokenToBuyAdded(address)']
    const allowedTokenToSellAddedFilter =
      amountConverter.filters['AllowedTokenToSellAdded(address)']

    const addTokenToSellEvents = await amountConverter.queryFilter(allowedTokenToSellAddedFilter)
    const addTokenToBuyEvents = await amountConverter.queryFilter(allowedTokenToBuyAddedFilter)

    expect(addTokenToSellEvents.length).to.equal(tokensToSell.length)
    expect(addTokenToBuyEvents.length).to.equal(tokensToBuy.length)

    for (const event of addTokenToSellEvents) {
      expect(tokensToSell).to.include(event.args[0])
    }

    for (const event of addTokenToBuyEvents) {
      expect(tokensToBuy).to.include(event.args[0])
    }

    expect(await amountConverter.ORACLE_ROUTER()).to.hexEqual(contracts.CHAINLINK_USD_QUOTE)
  })
})
