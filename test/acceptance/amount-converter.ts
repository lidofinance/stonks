import { ethers } from 'hardhat'
import { expect } from 'chai'

const AMOUNT_CONVERTER_ADDRESS: string = ''
const ORACLE_ROUTER_ADDRESS: string = ''

describe('AmountConverter: acceptance', async function () {
  it('should have correct params', async function () {
    if (AMOUNT_CONVERTER_ADDRESS === '') this.skip()
    if (ORACLE_ROUTER_ADDRESS === '') this.skip()

    const tokensToSell: string[] = []
    const tokensToBuy: string[] = []
    if (tokensToSell.length === 0) this.skip()
    if (tokensToBuy.length === 0) this.skip()

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

    expect(await amountConverter.ORACLE_ROUTER()).to.hexEqual(ORACLE_ROUTER_ADDRESS)
  })
})
