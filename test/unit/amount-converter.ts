import { ethers } from 'hardhat'

import { IAmountConverter } from '../../typechain-types'
import { mainnet } from '../../utils/contracts'

describe('AmountConverter', function () {
  let subject: IAmountConverter

  this.beforeAll(async function () {
    const ContractFactory = await ethers.getContractFactory('AmountConverter')
    subject = await ContractFactory.deploy(
      mainnet.CHAINLINK_PRICE_FEED_REGISTRY,
      '0x0000000000000000000000000000000000000348', // USD
      [mainnet.STETH, mainnet.DAI, mainnet.USDC, mainnet.USDT],
      [mainnet.DAI, mainnet.USDC, mainnet.USDT]
    )

    await subject.waitForDeployment()
  })

  describe('Price check', async function () {
    it('Should have the right price in the straigt direction', async function () {
      const stethToSell = ethers.parseEther('1')
      const price = await subject.getExpectedOut(
        mainnet.STETH,
        mainnet.DAI,
        stethToSell
      )
      console.log(price.toString())
    })
    it('Should have the right price in the straigt direction', async function () {
      const stethToSell = 1000000
      const price = await subject.getExpectedOut(
        mainnet.USDC,
        mainnet.DAI,
        stethToSell
      )
      console.log(price.toString())
    })
    it('Should have the right price in the straigt direction', async function () {
      const stethToSell = ethers.parseEther('1')
      const price = await subject.getExpectedOut(
        mainnet.DAI,
        mainnet.USDC,
        stethToSell
      )
      console.log(price.toString())
    })
  })
})
