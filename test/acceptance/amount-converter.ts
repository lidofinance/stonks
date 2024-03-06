import { ethers } from 'hardhat'
import { expect } from 'chai'

const AMOUNT_CONVERTER_ADDRESS = ''

const tokensToSell = [
  "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84", // STETH
  "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
  "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
]
const tokensToBuy = [
  "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
  "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
]

// https://docs.chain.link/data-feeds/price-feeds/addresses?network=ethereum&page=1
const priceFeedTimeouts = [
  3600, // STETH
  3600, // DAI
  86400, // USDT
  86400, // USDC
]

// Conversion targets: https://github.com/smartcontractkit/chainlink/blob/develop/contracts/src/v0.8/Denominations.sol
const conversionTarget = "0x0000000000000000000000000000000000000348"

describe('AmountConverter: acceptance', async function () {
  it('should have correct params', async function () {
    if (AMOUNT_CONVERTER_ADDRESS === '') this.skip()

    const amountConverter = await ethers.getContractAt('AmountConverter', AMOUNT_CONVERTER_ADDRESS)

    for (const token of tokensToSell) {
      expect(await amountConverter.allowedTokensToSell(token)).to.equal(true)
    }

    for (const token of tokensToBuy) {
      expect(await amountConverter.allowedTokensToBuy(token)).to.equal(true)
    }

    for (let i = 0; i < tokensToSell.length; i++) {
      expect(await amountConverter.priceFeedsHeartbeatTimeouts(tokensToSell[i])).to.equal(priceFeedTimeouts[i])
    }

    expect(await amountConverter.CONVERSION_TARGET()).to.equal(conversionTarget)
  })
})
