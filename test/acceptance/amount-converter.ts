import { ethers } from 'hardhat'
import { expect } from 'chai'
import { getTokensToBuy, getTokensToSell, getPriceFeedTimeouts } from './configuration'
import { getContracts } from '../../utils/contracts'

const AMOUNT_CONVERTER_ADDRESS: string = ''

describe('AmountConverter: acceptance', async function () {
  it('should have correct params', async function () {
    if (AMOUNT_CONVERTER_ADDRESS === '') this.skip()
    const contracts = await getContracts()
    const tokensToSell = (await getTokensToSell()).map(token => ethers.getAddress(token))
    const tokensToBuy = (await getTokensToBuy()).map(token => ethers.getAddress(token))
    const priceFeedTimeouts = await getPriceFeedTimeouts()

    const amountConverter = await ethers.getContractAt('AmountConverter', AMOUNT_CONVERTER_ADDRESS)

    for (const token of tokensToSell) {
      expect(await amountConverter.allowedTokensToSell(ethers.getAddress(token))).to.equal(true)
    }

    for (const token of tokensToBuy) {
      expect(await amountConverter.allowedTokensToBuy(ethers.getAddress(token))).to.equal(true)
    }

    for (let i = 0; i < tokensToSell.length; i++) {
      expect(await amountConverter.priceFeedsHeartbeatTimeouts(tokensToSell[i])).to.equal(
        priceFeedTimeouts[i]
      )
    }

    const allowedTokenToBuyAddedFilter = amountConverter.filters['AllowedTokenToBuyAdded(address)']
    const allowedTokenToSellAddedFilter =
      amountConverter.filters['AllowedTokenToSellAdded(address)']
    const priceFeedHeartbeatTimeoutSetFilter =
      amountConverter.filters['PriceFeedHeartbeatTimeoutSet(address,uint256)']

    const addTokenToSellEvents = await amountConverter.queryFilter(allowedTokenToSellAddedFilter)
    const addTokenToBuyEvents = await amountConverter.queryFilter(allowedTokenToBuyAddedFilter)
    const priceFeedHeartbeatTimeoutSetEvents = await amountConverter.queryFilter(
      priceFeedHeartbeatTimeoutSetFilter
    )

    expect(addTokenToSellEvents.length).to.equal(tokensToSell.length)
    expect(addTokenToBuyEvents.length).to.equal(tokensToBuy.length)

    for (const event of addTokenToSellEvents) {
      expect(tokensToSell).to.include(event.args[0])
    }

    for (const event of addTokenToBuyEvents) {
      expect(tokensToBuy).to.include(event.args[0])
    }

    for (const event of priceFeedHeartbeatTimeoutSetEvents) {
      const token = event.args[0]
      const timeout = event.args[1]

      const index = tokensToSell.indexOf(token)
      expect(timeout).to.equal(priceFeedTimeouts[index])
    }

    expect(await amountConverter.CONVERSION_TARGET()).to.equal(contracts.CHAINLINK_USD_QUOTE)
    expect(await amountConverter.FEED_REGISTRY()).to.equal(
      ethers.getAddress(contracts.CHAINLINK_PRICE_FEED_REGISTRY)
    )
  })
})
