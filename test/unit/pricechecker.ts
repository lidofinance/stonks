import { ITokenConverter } from '../../typechain-types'
import { ethers } from 'hardhat'

import { mainnet } from '../../utils/contracts'

describe('Tokens converter', function () {
  let subject: ITokenConverter

  this.beforeAll(async function () {
    const ContractFactory = await ethers.getContractFactory(
      'TokenAmountConverter'
    )
    subject = await ContractFactory.deploy(
      mainnet.CHAINLINK_PRICE_FEED_REGISTRY,
      [mainnet.STETH, mainnet.DAI, mainnet.USDC, mainnet.USDT],
      [mainnet.DAI, mainnet.USDC, mainnet.USDT]
    )

    await subject.waitForDeployment()
  })

  describe('Price check', async function () {
    it('Should have the right price in the straigt direction', async function () {
      const stethToSell = ethers.parseEther('1')
      const price = await subject.getExpectedOut(
        stethToSell,
        mainnet.STETH,
        mainnet.DAI
      )
      console.log(price.toString())
    })
    it('Should have the right price in the straigt direction', async function () {
      const stethToSell = 1000000
      const price = await subject.getExpectedOut(
        stethToSell,
        mainnet.USDC,
        mainnet.DAI
      )
      console.log(price.toString())
    })
    it('Should have the right price in the straigt direction', async function () {
      const stethToSell = ethers.parseEther('1')
      const price = await subject.getExpectedOut(
        stethToSell,
        mainnet.DAI,
        mainnet.USDC
      )
      console.log(price.toString())
    })
  })
})
