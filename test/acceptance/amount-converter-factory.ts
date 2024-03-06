import { ethers } from 'hardhat'
import { expect } from 'chai'

const AMOUNT_CONVERTER_FACTORY_ADDRESS = ''

describe('AmountConverterFactory: acceptance', async function () {
  it('should have correct chainlink feed registry', async function () {
    if (AMOUNT_CONVERTER_FACTORY_ADDRESS === '') this.skip()
    const amountConverterFactory = await ethers.getContractAt(
      'AmountConverterFactory',
      AMOUNT_CONVERTER_FACTORY_ADDRESS
    )

    // https://docs.chain.link/data-feeds/feed-registry#contract-addresses
    expect(await amountConverterFactory.FEED_REGISTRY()).to.equal(
      '0x47Fb2585D2C56Fe188D0E6ec628a38b74fCeeeDf'
    )
  })
})
