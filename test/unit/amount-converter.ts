import { ethers, network } from 'hardhat'

import { IAmountConverter } from '../../typechain-types'
import { mainnet } from '../../utils/contracts'
import { getExpectedOut } from '../../utils/chainlink-helpers'
import { expect } from 'chai'

describe('AmountConverter', function () {
  let subject: IAmountConverter
  let snapshotId: string

  this.beforeAll(async function () {
    snapshotId = await network.provider.send('evm_snapshot')
    const ContractFactory = await ethers.getContractFactory('AmountConverter')
    subject = await ContractFactory.deploy(
      mainnet.CHAINLINK_PRICE_FEED_REGISTRY,
      '0x0000000000000000000000000000000000000348', // USD
      [mainnet.STETH, mainnet.DAI, mainnet.USDC, mainnet.USDT],
      [mainnet.DAI, mainnet.USDC, mainnet.USDT],
      [3600, 3600, 86400, 86400]
    )

    await subject.waitForDeployment()
  })

  describe('initialization:', async function () {
    it('should not initialize with feed registry zero address', async function () {
      const ContractFactory = await ethers.getContractFactory('AmountConverter')

      await expect(
        ContractFactory.deploy(
          ethers.ZeroAddress,
          mainnet.CHAINLINK_USD_QUOTE,
          [mainnet.STETH, mainnet.DAI, mainnet.USDC, mainnet.USDT],
          [mainnet.DAI, mainnet.USDC, mainnet.USDT],
          [3600, 3600, 86400, 86400]
        )
      ).to.be.revertedWithCustomError(
        ContractFactory,
        'InvalidFeedRegistryAddress'
      )
    })

    it('should not initialize with conversion target zero address', async function () {
      const ContractFactory = await ethers.getContractFactory('AmountConverter')

      await expect(
        ContractFactory.deploy(
          mainnet.CHAINLINK_PRICE_FEED_REGISTRY,
          ethers.ZeroAddress,
          [mainnet.STETH, mainnet.DAI, mainnet.USDC, mainnet.USDT],
          [mainnet.DAI, mainnet.USDC, mainnet.USDT],
          [3600, 3600, 86400, 86400]
        )
      ).to.be.revertedWithCustomError(
        ContractFactory,
        'InvalidConversionTargetAddress'
      )
    })

    it('should not initialize with zero address in allowedTokensToSell', async function () {
      const ContractFactory = await ethers.getContractFactory('AmountConverter')

      await expect(
        ContractFactory.deploy(
          mainnet.CHAINLINK_PRICE_FEED_REGISTRY,
          mainnet.CHAINLINK_USD_QUOTE,
          [mainnet.STETH, ethers.ZeroAddress],
          [mainnet.DAI, mainnet.USDC, mainnet.USDT],
          [3600, 3600]
        )
      ).to.be.revertedWithCustomError(
        ContractFactory,
        'InvalidAllowedTokenToSell'
      )
    })

    it('should not initialize with zero address in allowedTokensToBuy', async function () {
      const ContractFactory = await ethers.getContractFactory('AmountConverter')

      await expect(
        ContractFactory.deploy(
          mainnet.CHAINLINK_PRICE_FEED_REGISTRY,
          mainnet.CHAINLINK_USD_QUOTE,
          [mainnet.STETH],
          [ethers.ZeroAddress, mainnet.DAI, mainnet.USDC, mainnet.USDT],
          [3600]
        )
      ).to.be.revertedWithCustomError(
        ContractFactory,
        'InvalidAllowedTokenToBuy'
      )
    })

    it('should not initialize with wrong length priceFeedsHeartbeatTimeouts', async function () {
      const ContractFactory = await ethers.getContractFactory('AmountConverter')

      await expect(
        ContractFactory.deploy(
          mainnet.CHAINLINK_PRICE_FEED_REGISTRY,
          mainnet.CHAINLINK_USD_QUOTE,
          [mainnet.STETH],
          [ethers.ZeroAddress, mainnet.DAI, mainnet.USDC, mainnet.USDT],
          []
        )
      ).to.be.revertedWithCustomError(
        ContractFactory,
        'InvalidHeartbeatArrayLength'
      )
    })
  })

  describe('getExpectedOut:', async function () {
    it('should revert if amount is zero', async function () {
      await expect(
        subject.getExpectedOut(mainnet.STETH, mainnet.DAI, 0)
      ).to.be.revertedWithCustomError(subject, 'InvalidAmount')
    })
    it('should revert if tokenFrom is not allowed', async function () {
      await expect(
        subject.getExpectedOut(mainnet.WETH, mainnet.DAI, 1)
      ).to.be.revertedWithCustomError(subject, 'SellTokenNotAllowed')
    })
    it('should revert if tokenTo is not allowed', async function () {
      await expect(
        subject.getExpectedOut(mainnet.STETH, mainnet.WETH, 1)
      ).to.be.revertedWithCustomError(subject, 'BuyTokenNotAllowed')
    })
    it('should revert if tokenFrom is the same as tokenTo', async function () {
      await expect(
        subject.getExpectedOut(mainnet.STETH, mainnet.STETH, 1)
      ).to.be.revertedWithCustomError(subject, 'SameTokensConversion')
    })
    it('should have the right price steth -> dai', async function () {
      const amountToSell = ethers.parseEther('1')
      const price = await subject.getExpectedOut(
        mainnet.STETH,
        mainnet.DAI,
        amountToSell
      )
      expect(price.toString()).to.equal(
        (
          await getExpectedOut(mainnet.STETH, mainnet.DAI, amountToSell)
        ).toString()
      )
    })
    it('should have the right price usdc -> dai', async function () {
      const amountToSell = BigInt(1000000)
      const resultAmount = await subject.getExpectedOut(
        mainnet.USDC,
        mainnet.DAI,
        amountToSell
      )
      expect(resultAmount.toString()).to.equal(
        (
          await getExpectedOut(mainnet.USDC, mainnet.DAI, amountToSell)
        ).toString()
      )
    })
    it('should have the right price dai -> usdc', async function () {
      const amountToSell = ethers.parseEther('1')
      const resultAmount = await subject.getExpectedOut(
        mainnet.DAI,
        mainnet.USDC,
        amountToSell
      )
      expect(resultAmount.toString()).to.equal(
        (
          await getExpectedOut(mainnet.DAI, mainnet.USDC, amountToSell)
        ).toString()
      )
    })
    it('should revert if updatedAt is behind heartbeat', async function () {
      const FeedRegistryTestFactory =
        await ethers.getContractFactory('FeedRegistryTest')
      const feedRegistryTest = await FeedRegistryTestFactory.deploy(
        mainnet.CHAINLINK_PRICE_FEED_REGISTRY
      )
      await feedRegistryTest.waitForDeployment()

      const ContractFactory = await ethers.getContractFactory('AmountConverter')
      const localSubject = await ContractFactory.deploy(
        await feedRegistryTest.getAddress(),
        '0x0000000000000000000000000000000000000348', // USD
        [mainnet.STETH],
        [mainnet.DAI],
        [3600]
      )
      localSubject.waitForDeployment()

      const amountToSell = ethers.parseEther('1')
      const resultAmount = await localSubject.getExpectedOut(
        mainnet.STETH,
        mainnet.DAI,
        amountToSell
      )

      await feedRegistryTest.setHeartbeat(3600)
      const result = await getExpectedOut(
        mainnet.STETH,
        mainnet.DAI,
        amountToSell
      )
      expect(resultAmount.toString()).to.equal(result.toString())

      await feedRegistryTest.setHeartbeat(3601)
      await expect(
        localSubject.getExpectedOut(mainnet.STETH, mainnet.DAI, amountToSell)
      ).to.be.revertedWithCustomError(localSubject, 'PriceFeedNotUpdated')
    })
  })

  this.afterAll(async function () {
    await network.provider.send('evm_revert', [snapshotId])
  })
})
