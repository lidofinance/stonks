import { ethers } from 'hardhat'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

import { AmountConverter__factory, IAmountConverter } from '../../typechain-types'
import { getContracts } from '../../utils/contracts'
import { getExpectedOut } from '../../utils/chainlink-helpers'

const contracts = getContracts()

describe('AmountConverter', function () {
  let subject: IAmountConverter
  let contractFactory: AmountConverter__factory
  let snapshot: SnapshotRestorer

  this.beforeAll(async function () {
    snapshot = await takeSnapshot()
    contractFactory = await ethers.getContractFactory('AmountConverter')
    subject = await contractFactory.deploy(
      contracts.CHAINLINK_PRICE_FEED_REGISTRY,
      '0x0000000000000000000000000000000000000348', // USD
      [contracts.STETH, contracts.DAI, contracts.USDC, contracts.USDT],
      [contracts.DAI, contracts.USDC, contracts.USDT],
      [3600, 3600, 86400, 86400]
    )

    await subject.waitForDeployment()
  })

  describe('initialization:', async function () {
    it('should not initialize with feed registry zero address', async function () {
      await expect(
        contractFactory.deploy(
          ethers.ZeroAddress,
          contracts.CHAINLINK_USD_QUOTE,
          [contracts.STETH, contracts.DAI, contracts.USDC, contracts.USDT],
          [contracts.DAI, contracts.USDC, contracts.USDT],
          [3600, 3600, 86400, 86400]
        )
      )
        .to.be.revertedWithCustomError(contractFactory, 'InvalidFeedRegistryAddress')
        .withArgs(ethers.ZeroAddress)
    })

    it('should not initialize with conversion target zero address', async function () {
      await expect(
        contractFactory.deploy(
          contracts.CHAINLINK_PRICE_FEED_REGISTRY,
          ethers.ZeroAddress,
          [contracts.STETH, contracts.DAI, contracts.USDC, contracts.USDT],
          [contracts.DAI, contracts.USDC, contracts.USDT],
          [3600, 3600, 86400, 86400]
        )
      )
        .to.be.revertedWithCustomError(contractFactory, 'InvalidConversionTargetAddress')
        .withArgs(ethers.ZeroAddress)
    })

    it('should not initialize with empty allowedTokensToSell', async function () {
      await expect(
        contractFactory.deploy(
          contracts.CHAINLINK_PRICE_FEED_REGISTRY,
          contracts.CHAINLINK_USD_QUOTE,
          [],
          [contracts.DAI, contracts.USDC, contracts.USDT],
          [3600, 3600, 86400, 86400]
        )
      ).to.be.revertedWithCustomError(contractFactory, 'InvalidTokensToSellArrayLength')
    })

    it('should not initialize with empty allowedTokensToBuy', async function () {
      await expect(
        contractFactory.deploy(
          contracts.CHAINLINK_PRICE_FEED_REGISTRY,
          contracts.CHAINLINK_USD_QUOTE,
          [contracts.STETH, contracts.DAI, contracts.USDC, contracts.USDT],
          [],
          [3600, 3600, 86400, 86400]
        )
      ).to.be.revertedWithCustomError(contractFactory, 'InvalidTokensToBuyArrayLength')
    })

    it('should not initialize with zero address in allowedTokensToSell', async function () {
      await expect(
        contractFactory.deploy(
          contracts.CHAINLINK_PRICE_FEED_REGISTRY,
          contracts.CHAINLINK_USD_QUOTE,
          [contracts.STETH, ethers.ZeroAddress],
          [contracts.DAI, contracts.USDC, contracts.USDT],
          [3600, 3600]
        )
      )
        .to.be.revertedWithCustomError(contractFactory, 'InvalidAllowedTokenToSell')
        .withArgs(ethers.ZeroAddress)
    })

    it('should not initialize with zero address in allowedTokensToBuy', async function () {
      await expect(
        contractFactory.deploy(
          contracts.CHAINLINK_PRICE_FEED_REGISTRY,
          contracts.CHAINLINK_USD_QUOTE,
          [contracts.STETH],
          [ethers.ZeroAddress, contracts.DAI, contracts.USDC, contracts.USDT],
          [3600]
        )
      )
        .to.be.revertedWithCustomError(contractFactory, 'InvalidAllowedTokenToBuy')
        .withArgs(ethers.ZeroAddress)
    })

    it('should not initialize with wrong length priceFeedsHeartbeatTimeouts', async function () {
      await expect(
        contractFactory.deploy(
          contracts.CHAINLINK_PRICE_FEED_REGISTRY,
          contracts.CHAINLINK_USD_QUOTE,
          [contracts.STETH],
          [ethers.ZeroAddress, contracts.DAI, contracts.USDC, contracts.USDT],
          []
        )
      ).to.be.revertedWithCustomError(contractFactory, 'InvalidHeartbeatArrayLength')
    })
  })

  describe('getExpectedOut:', async function () {
    it('should revert if amount is zero', async function () {
      await expect(subject.getExpectedOut(contracts.STETH, contracts.DAI, 0))
        .to.be.revertedWithCustomError(subject, 'InvalidAmount')
        .withArgs(0)
    })
    it('should revert if tokenFrom is not allowed', async function () {
      await expect(subject.getExpectedOut(contracts.LDO, contracts.DAI, 1))
        .to.be.revertedWithCustomError(subject, 'SellTokenNotAllowed')
        .withArgs(contracts.LDO)
    })
    it('should revert if tokenTo is not allowed', async function () {
      await expect(subject.getExpectedOut(contracts.STETH, contracts.LDO, 1))
        .to.be.revertedWithCustomError(subject, 'BuyTokenNotAllowed')
        .withArgs(contracts.LDO)
    })
    it('should revert if tokenFrom is the same as tokenTo', async function () {
      await expect(
        subject.getExpectedOut(contracts.STETH, contracts.STETH, 1)
      ).to.be.revertedWithCustomError(subject, 'SameTokensConversion')
    })
    it('should have the right price steth -> dai', async function () {
      const amountToSell = ethers.parseEther('1')
      const price = await subject.getExpectedOut(contracts.STETH, contracts.DAI, amountToSell)
      expect(price.toString()).to.equal(
        (await getExpectedOut(contracts.STETH, contracts.DAI, amountToSell)).toString()
      )
    })
    it('should have the right price usdc -> dai', async function () {
      const amountToSell = BigInt(1000000)
      const resultAmount = await subject.getExpectedOut(contracts.USDC, contracts.DAI, amountToSell)
      expect(resultAmount.toString()).to.equal(
        (await getExpectedOut(contracts.USDC, contracts.DAI, amountToSell)).toString()
      )
    })
    it('should have the right price dai -> usdc', async function () {
      const amountToSell = ethers.parseEther('1')
      const resultAmount = await subject.getExpectedOut(contracts.DAI, contracts.USDC, amountToSell)
      expect(resultAmount.toString()).to.equal(
        (await getExpectedOut(contracts.DAI, contracts.USDC, amountToSell)).toString()
      )
    })
    it('should revert if updatedAt is behind heartbeat', async function () {
      const FeedRegistryTestFactory = await ethers.getContractFactory('FeedRegistryTest')
      const feedRegistryTest = await FeedRegistryTestFactory.deploy(
        contracts.CHAINLINK_PRICE_FEED_REGISTRY
      )
      await feedRegistryTest.waitForDeployment()

      const localSubject = await contractFactory.deploy(
        feedRegistryTest,
        '0x0000000000000000000000000000000000000348', // USD
        [contracts.STETH],
        [contracts.DAI],
        [3600]
      )
      localSubject.waitForDeployment()

      const amountToSell = ethers.parseEther('1')
      const resultAmount = await localSubject.getExpectedOut(
        contracts.STETH,
        contracts.DAI,
        amountToSell
      )

      await feedRegistryTest.setHeartbeat(3600)
      const result = await getExpectedOut(contracts.STETH, contracts.DAI, amountToSell)
      expect(resultAmount.toString()).to.equal(result.toString())

      const unacceptableHeartbeat = 3601
      await feedRegistryTest.setHeartbeat(unacceptableHeartbeat)
      const blockNumber = await ethers.provider.getBlockNumber()
      const expectedTimestamp = (await ethers.provider.getBlock(blockNumber))?.timestamp!

      await expect(localSubject.getExpectedOut(contracts.STETH, contracts.DAI, amountToSell))
        .to.be.revertedWithCustomError(localSubject, 'PriceFeedNotUpdated')
        .withArgs(expectedTimestamp - unacceptableHeartbeat)
    })
  })

  describe('events:', async function () {
    it('constructor should emits events about configuration', async function () {
      const localSubject = await contractFactory.deploy(
        contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        '0x0000000000000000000000000000000000000348', // USD
        [contracts.STETH],
        [contracts.DAI],
        [3600]
      )
      await localSubject.waitForDeployment()

      await expect(localSubject.deploymentTransaction())
        .to.emit(localSubject, 'AllowedTokenToSellAdded')
        .withArgs(contracts.STETH)
      await expect(localSubject.deploymentTransaction())
        .to.emit(localSubject, 'AllowedTokenToBuyAdded')
        .withArgs(contracts.DAI)
      await expect(localSubject.deploymentTransaction())
        .to.emit(localSubject, 'PriceFeedHeartbeatTimeoutSet')
        .withArgs(contracts.STETH, 3600)
    })
  })

  this.afterAll(async function () {
    await snapshot.restore()
  })
})
