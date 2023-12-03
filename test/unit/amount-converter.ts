import { ethers } from 'hardhat'

import { IAmountConverter } from '../../typechain-types'
import { mainnet } from '../../utils/contracts'
import { expect } from "chai";

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

  describe('deploy check', async function () {
    it('should not initialize with zero address', async function () {
      const ContractFactory = await ethers.getContractFactory('AmountConverter')

      await expect(ContractFactory.deploy(
        ethers.ZeroAddress,
        mainnet.CHAINLINK_USD_QUOTE,
        [mainnet.STETH, mainnet.DAI, mainnet.USDC, mainnet.USDT],
        [mainnet.DAI, mainnet.USDC, mainnet.USDT]
      )).to.be.revertedWithCustomError(ContractFactory, "ZeroAddress")
    })
  })

  describe('Price check', async function () {
    it('should have the right price in the straigt direction', async function () {
      const stethToSell = ethers.parseEther('1')
      const price = await subject.getExpectedOut(
        mainnet.STETH,
        mainnet.DAI,
        stethToSell
      )
      console.log(price.toString())
    })
    it('should have the right price in the straigt direction', async function () {
      const stethToSell = 1000000
      const price = await subject.getExpectedOut(
        mainnet.USDC,
        mainnet.DAI,
        stethToSell
      )
      console.log(price.toString())
    })
    it('should have the right price in the straigt direction', async function () {
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
