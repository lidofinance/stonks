import { ethers } from 'hardhat'
import { expect } from 'chai'
import { parseEther } from 'ethers'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import type { AmountConverter, AmountConverterFactory, OracleRouter } from '../../typechain-types'
import { getContracts } from '../../utils/contracts'
import { QuoteDenomination } from '../../utils/oracle-router'
import { fetchFeedData, isFeedFresh } from '../../utils/chainlink-helpers'
import { getExpectedPrice, getExpectedConversion } from '../helpers/oracle-helpers'

const contracts = getContracts()

describe('OracleRouter integration', function () {
  let router: OracleRouter
  let factory: AmountConverterFactory
  let snapshot: SnapshotRestorer

  before(async () => {
    snapshot = await takeSnapshot()

    const [deployer] = await ethers.getSigners()
    const routerFactory = await ethers.getContractFactory('OracleRouter')
    router = await routerFactory.deploy(
      await deployer.getAddress(),
      18,
      contracts.CHAINLINK_PRICE_FEED_REGISTRY
    )
    await router.waitForDeployment()

    const factoryContract = await ethers.getContractFactory('AmountConverterFactory')
    factory = await factoryContract.deploy(await router.getAddress())
    await factory.waitForDeployment()

    const feedsToCheck = [
      { token: contracts.STETH, quote: contracts.CHAINLINK_USD_QUOTE, symbol: 'STETH/USD' },
      { token: contracts.STETH, quote: contracts.CHAINLINK_ETH_QUOTE, symbol: 'STETH/ETH' },
      { token: contracts.DAI, quote: contracts.CHAINLINK_USD_QUOTE, symbol: 'DAI/USD' },
      { token: contracts.USDC, quote: contracts.CHAINLINK_USD_QUOTE, symbol: 'USDC/USD' },
      { token: contracts.USDT, quote: contracts.CHAINLINK_USD_QUOTE, symbol: 'USDT/USD' },
      { token: contracts.LDO, quote: contracts.CHAINLINK_ETH_QUOTE, symbol: 'LDO/ETH' },
      {
        token: contracts.CHAINLINK_ETH_QUOTE,
        quote: contracts.CHAINLINK_USD_QUOTE,
        symbol: 'ETH/USD',
      },
    ]

    for (const { token, quote, symbol } of feedsToCheck) {
      const feedData = await fetchFeedData(token, quote)

      if (!feedData.exists) {
        throw new Error(`Required feed ${symbol} does not exist on mainnet fork`)
      }

      const isFresh = await isFeedFresh(token, quote, 86400)
      if (!isFresh) {
      }
    }
  })

  after(async () => {
    await snapshot.restore()
  })

  describe('Price queries', function () {
    it('should query STETH/USD price', async () => {
      await router.setTokenFeed(contracts.STETH, QuoteDenomination.USD, 86400, true)

      const [priceFrom, priceTo, decimalsFrom, decimalsTo] = await router.getPricesAndDecimals(
        contracts.STETH,
        contracts.STETH,
        QuoteDenomination.USD
      )

      const expectedPrice = await getExpectedPrice(contracts.STETH, contracts.CHAINLINK_USD_QUOTE)

      expect(priceFrom).to.equal(expectedPrice)
      expect(priceTo).to.equal(expectedPrice)
      expect(decimalsFrom).to.equal(18n)
      expect(decimalsTo).to.equal(18n)
    })

    it('should query DAI/USD price', async () => {
      await router.setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, true)

      const [priceFrom, priceTo] = await router.getPricesAndDecimals(
        contracts.DAI,
        contracts.DAI,
        QuoteDenomination.USD
      )

      const expectedPrice = await getExpectedPrice(contracts.DAI, contracts.CHAINLINK_USD_QUOTE)

      expect(priceFrom).to.equal(expectedPrice)
      expect(priceTo).to.equal(expectedPrice)
    })

    it('should query STETH/ETH price', async () => {
      await router.setEthUsdBridge(86400)
      await router.setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86400, true)

      const [priceFrom, priceTo] = await router.getPricesAndDecimals(
        contracts.STETH,
        contracts.STETH,
        QuoteDenomination.ETH
      )

      const expectedPrice = await getExpectedPrice(contracts.STETH, contracts.CHAINLINK_ETH_QUOTE)

      expect(priceFrom).to.equal(expectedPrice)
      expect(priceTo).to.equal(expectedPrice)
    })

    it('should handle cross-token price queries correctly', async () => {
      await router.setTokenFeed(contracts.STETH, QuoteDenomination.USD, 86400, true)
      await router.setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, true)

      const [priceSteth, priceDai] = await router.getPricesAndDecimals(
        contracts.STETH,
        contracts.DAI,
        QuoteDenomination.USD
      )

      const registry = await ethers.getContractAt(
        'IFeedRegistry',
        contracts.CHAINLINK_PRICE_FEED_REGISTRY
      )
      const [, stethUsdAnswer] = await registry.latestRoundData(
        contracts.STETH,
        contracts.CHAINLINK_USD_QUOTE
      )
      const [, daiUsdAnswer] = await registry.latestRoundData(
        contracts.DAI,
        contracts.CHAINLINK_USD_QUOTE
      )
      const stethUsdDecimals = await registry.decimals(
        contracts.STETH,
        contracts.CHAINLINK_USD_QUOTE
      )
      const daiUsdDecimals = await registry.decimals(contracts.DAI, contracts.CHAINLINK_USD_QUOTE)

      const expectedStethPrice =
        (BigInt(stethUsdAnswer) * 10n ** 18n) / 10n ** BigInt(stethUsdDecimals)
      const expectedDaiPrice = (BigInt(daiUsdAnswer) * 10n ** 18n) / 10n ** BigInt(daiUsdDecimals)

      expect(priceSteth).to.equal(expectedStethPrice)
      expect(priceDai).to.equal(expectedDaiPrice)
    })
  })

  describe('Amount conversions', function () {
    let converter: AmountConverter

    beforeEach(async () => {
      await router.setTokenFeed(contracts.STETH, QuoteDenomination.USD, 86400, true)
      await router.setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, true)
      await router.setTokenFeed(contracts.USDC, QuoteDenomination.USD, 86400, true)

      const tx = await factory.deployAmountConverter(
        [contracts.STETH],
        [contracts.DAI, contracts.USDC],
        false
      )
      const receipt = await tx.wait()
      const factoryAddress = (await factory.getAddress()).toLowerCase()
      const eventLog = receipt?.logs.find(
        (log: any) => log.address?.toLowerCase() === factoryAddress
      )
      if (!eventLog) {
        throw new Error('AmountConverterDeployed event not found')
      }
      // Fix: ensure compatibility with ethers v6 types by copying topics and data to mutable object
      const { topics, data } = eventLog
      const converterAddress = factory.interface.parseLog({ topics: [...topics], data })?.args[0]
      converter = await ethers.getContractAt('AmountConverter', converterAddress)
    })

    it('should convert 1 STETH to DAI', async () => {
      const amount = parseEther('1')
      const result = await converter.getExpectedOut(contracts.STETH, contracts.DAI, amount)

      const expected = await getExpectedConversion(contracts.STETH, contracts.DAI, amount)

      expect(result).to.equal(expected)
    })

    it('should convert 1 STETH to USDC with 6 decimals', async () => {
      const amount = parseEther('1')
      const result = await converter.getExpectedOut(contracts.STETH, contracts.USDC, amount)

      const expected = await getExpectedConversion(contracts.STETH, contracts.USDC, amount)

      expect(result).to.equal(expected)
    })

    it('should handle decimal precision correctly', async () => {
      const amount = parseEther('1.123456789123456789')
      const result = await converter.getExpectedOut(contracts.STETH, contracts.DAI, amount)

      const result1 = await converter.getExpectedOut(
        contracts.STETH,
        contracts.DAI,
        parseEther('1')
      )

      const expected = (result1 * 1123456789123456789n) / parseEther('1')

      expect(result).to.be.closeTo(expected, 1n)
    })

    it('should produce consistent results for repeated queries', async () => {
      const amount = parseEther('1')

      const result1 = await converter.getExpectedOut(contracts.STETH, contracts.DAI, amount)
      const result2 = await converter.getExpectedOut(contracts.STETH, contracts.DAI, amount)
      const result3 = await converter.getExpectedOut(contracts.STETH, contracts.DAI, amount)

      expect(result1).to.equal(result2)
      expect(result2).to.equal(result3)
    })
  })

  describe('Admin Operations', function () {
    it('should allow admin to activate/deactivate tokens', async () => {
      await router.setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, true)

      let config = await router.tokenConfig(contracts.DAI)
      expect(config.isActive).to.be.true

      await router.setTokenActive(contracts.DAI, false)
      config = await router.tokenConfig(contracts.DAI)
      expect(config.isActive).to.be.false

      await router.setTokenActive(contracts.DAI, true)
      config = await router.tokenConfig(contracts.DAI)
      expect(config.isActive).to.be.true
    })

    it('should revert queries for deactivated tokens', async () => {
      await router.setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, true)
      await router.setTokenActive(contracts.DAI, false)

      await expect(
        router.getPricesAndDecimals(contracts.DAI, contracts.DAI, QuoteDenomination.USD)
      ).to.be.revertedWithCustomError(router, 'TokenNotConfigured')
    })

    it('should allow admin to change heartbeat timeout', async () => {
      await router.setTokenFeed(contracts.DAI, QuoteDenomination.USD, 3600, true)

      let config = await router.tokenConfig(contracts.DAI)
      const feedConfig1 = config[1]
      expect(feedConfig1[3]).to.equal(3600)

      await router.setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, true)

      config = await router.tokenConfig(contracts.DAI)
      const feedConfig2 = config[1]
      expect(feedConfig2[3]).to.equal(86400)
    })
  })

  describe('Error handling', function () {
    it('should revert for unconfigured token', async () => {
      await expect(
        router.getPricesAndDecimals(contracts.LDO, contracts.DAI, QuoteDenomination.USD)
      ).to.be.revertedWithCustomError(router, 'TokenNotConfigured')
    })

    it('should revert when ETH/USD bridge missing in ETH mode', async () => {
      const [deployer] = await ethers.getSigners()
      const freshRouter = await ethers.deployContract('OracleRouter', [
        await deployer.getAddress(),
        18,
        contracts.CHAINLINK_PRICE_FEED_REGISTRY,
      ])

      await freshRouter.setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, true)
      await freshRouter.setTokenFeed(contracts.USDC, QuoteDenomination.USD, 86400, true)

      await expect(
        freshRouter.getPricesAndDecimals(contracts.DAI, contracts.USDC, QuoteDenomination.ETH)
      ).to.be.revertedWithCustomError(freshRouter, 'EthUsdBridgeMissing')
    })

    it('should revert for zero address token', async () => {
      await expect(
        router.setTokenFeed(ethers.ZeroAddress, QuoteDenomination.USD, 86400, true)
      ).to.be.revertedWithCustomError(router, 'InvalidTokenAddress')
    })
  })

  describe('Cross-denomination consistency', function () {
    it('should produce consistent results between USD and ETH modes', async () => {
      await router.setEthUsdBridge(86400)
      await router.setTokenFeed(contracts.STETH, QuoteDenomination.USD, 86400, true)
      await router.setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86400, true)
      await router.setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, true)

      const [priceStethUsd, priceDaiUsd] = await router.getPricesAndDecimals(
        contracts.STETH,
        contracts.DAI,
        QuoteDenomination.USD
      )

      const [priceStethEth, priceDaiEth] = await router.getPricesAndDecimals(
        contracts.STETH,
        contracts.DAI,
        QuoteDenomination.ETH
      )

      const ratioUsd = (priceStethUsd * 10n ** 18n) / priceDaiUsd
      const ratioEth = (priceStethEth * 10n ** 18n) / priceDaiEth

      const maxDelta = ratioUsd / 100n

      expect(ratioUsd).to.be.closeTo(ratioEth, maxDelta)
    })
  })
})
