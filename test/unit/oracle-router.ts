import { ethers } from 'hardhat'
import { expect } from 'chai'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs'
import { OracleRouter, OracleRouter__factory } from '../../typechain-types'
import { QuoteDenomination } from '../../utils/oracle-router'
import {
  getTestFeedRegistryStub,
  getAllTestTokens,
  updateTokenFeed,
  resetTestFeedRegistryStub,
  refreshFeedData,
} from '../../utils/test-feed-registry'
import { getContracts } from '../../utils/contracts'
import { calculatePriceRatio } from '../utils/oracle-router-helpers'

const contracts = getContracts()

describe('OracleRouter', function () {
  let oracleRouter: OracleRouter
  let oracleRouterFactory: OracleRouter__factory
  let snapshot: SnapshotRestorer
  let agentAddress: string
  let feedRegistryAddress: string

  const feedConfig = {
    tokens: getAllTestTokens(),
    useRealPrices: true,
  }

  const getCurrentTimestamp = async () => {
    const block = await ethers.provider.getBlock('latest')
    return BigInt(block!.timestamp)
  }

  const getAgentSigner = async () => {
    const agentSigner = await ethers.getImpersonatedSigner(agentAddress)
    await ethers.provider.send('hardhat_setBalance', [agentAddress, '0x1000000000000000000'])
    return agentSigner
  }

  const readNormalizedFeedPrice = async (
    base: string,
    quote: string,
    decimals: bigint
  ): Promise<bigint> => {
    const feedRegistry = await ethers.getContractAt(
      'ChainlinkFeedRegistryStub',
      feedRegistryAddress
    )
    const feed = await feedRegistry.feeds(base, quote)
    const feedAnswer = BigInt(feed.answer)
    const feedDecimals = BigInt(feed.decimals)

    if (feedDecimals === decimals) {
      return feedAnswer
    } else if (feedDecimals < decimals) {
      return feedAnswer * 10n ** (decimals - feedDecimals)
    } else {
      return feedAnswer / 10n ** (feedDecimals - decimals)
    }
  }

  const getRouterPriceDecimals = async (routerInstance: OracleRouter) =>
    BigInt(await routerInstance.PRICE_DECIMALS())

  const getRouterPriceUnit = async (routerInstance: OracleRouter) =>
    BigInt(await routerInstance.PRICE_UNIT())

  const getExpectedUsdPrice = async (routerInstance: OracleRouter, token: string) => {
    const decimals = await getRouterPriceDecimals(routerInstance)
    return readNormalizedFeedPrice(token, contracts.CHAINLINK_USD_QUOTE, decimals)
  }

  const getExpectedUsdBridgePrice = async (routerInstance: OracleRouter, token: string) => {
    const decimals = await getRouterPriceDecimals(routerInstance)
    const unit = await getRouterPriceUnit(routerInstance)
    const tokenEth = await readNormalizedFeedPrice(token, contracts.CHAINLINK_ETH_QUOTE, decimals)
    const ethUsd = await readNormalizedFeedPrice(
      contracts.CHAINLINK_ETH_QUOTE,
      contracts.CHAINLINK_USD_QUOTE,
      decimals
    )
    return (tokenEth * ethUsd) / unit
  }

  const getExpectedEthBridgePrice = async (routerInstance: OracleRouter, token: string) => {
    const decimals = await getRouterPriceDecimals(routerInstance)
    const unit = await getRouterPriceUnit(routerInstance)
    const tokenUsd = await readNormalizedFeedPrice(token, contracts.CHAINLINK_USD_QUOTE, decimals)
    const ethUsd = await readNormalizedFeedPrice(
      contracts.CHAINLINK_ETH_QUOTE,
      contracts.CHAINLINK_USD_QUOTE,
      decimals
    )
    return (tokenUsd * unit) / ethUsd
  }

  type QuoteValue = (typeof QuoteDenomination)[keyof typeof QuoteDenomination]

  const getExpectedPriceForQuote = async (
    routerInstance: OracleRouter,
    token: string,
    requestedQuote: QuoteValue
  ): Promise<bigint> => {
    const config = await routerInstance.tokenConfig(token)
    const primaryQuote = Number(config.primaryQuote)

    if (primaryQuote === requestedQuote) {
      const quoteAddress =
        requestedQuote === QuoteDenomination.USD
          ? contracts.CHAINLINK_USD_QUOTE
          : contracts.CHAINLINK_ETH_QUOTE
      const decimals = await getRouterPriceDecimals(routerInstance)
      return readNormalizedFeedPrice(token, quoteAddress, decimals)
    }

    if (primaryQuote === QuoteDenomination.ETH && requestedQuote === QuoteDenomination.USD) {
      return getExpectedUsdBridgePrice(routerInstance, token)
    }

    if (primaryQuote === QuoteDenomination.USD && requestedQuote === QuoteDenomination.ETH) {
      return getExpectedEthBridgePrice(routerInstance, token)
    }

    throw new Error('Unsupported quote transition')
  }

  const getExpectedPricesForPair = async (
    routerInstance: OracleRouter,
    base: string,
    quote: string,
    requestedQuote: QuoteValue
  ): Promise<[bigint, bigint]> => {
    const baseExpected = await getExpectedPriceForQuote(routerInstance, base, requestedQuote)
    const quoteExpected = await getExpectedPriceForQuote(routerInstance, quote, requestedQuote)
    return [baseExpected, quoteExpected]
  }

  before(async function () {
    snapshot = await takeSnapshot()
    oracleRouterFactory = await ethers.getContractFactory('OracleRouter')
    agentAddress = contracts.AGENT
    const stub = await getTestFeedRegistryStub(feedConfig)
    feedRegistryAddress = await stub.getAddress()
  })

  beforeEach(async function () {
    await refreshFeedData(feedConfig)
    oracleRouter = await oracleRouterFactory.deploy(agentAddress, 18, feedRegistryAddress)
    await oracleRouter.waitForDeployment()
  })

  describe('Constructor', function () {
    it('sets constructor parameters', async function () {
      expect(await oracleRouter.PRICE_DECIMALS()).to.equal(18)
      expect(await oracleRouter.PRICE_UNIT()).to.equal(ethers.parseUnits('1', 18))
      expect(await oracleRouter.FEED_REGISTRY()).to.equal(feedRegistryAddress)
    })

    it('reverts with zero agent address', async function () {
      await expect(
        oracleRouterFactory.deploy(ethers.ZeroAddress, 18, feedRegistryAddress)
      ).to.be.revertedWithCustomError(oracleRouter, 'InvalidAgentAddress')
    })

    it('reverts with zero unit decimals', async function () {
      await expect(
        oracleRouterFactory.deploy(agentAddress, 0, feedRegistryAddress)
      ).to.be.revertedWithCustomError(oracleRouter, 'InvalidUnitDecimals')
    })

    it('reverts with unit decimals > 38', async function () {
      await expect(
        oracleRouterFactory.deploy(agentAddress, 39, feedRegistryAddress)
      ).to.be.revertedWithCustomError(oracleRouter, 'InvalidUnitDecimals')
    })

    it('reverts with zero feed registry address', async function () {
      await expect(
        oracleRouterFactory.deploy(agentAddress, 18, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(oracleRouter, 'InvalidFeedRegistryAddress')
    })
  })

  describe('ETH/USD Bridge Configuration', function () {
    let originalEthUsdFeed: any

    before(async function () {
      const feedRegistry = await ethers.getContractAt(
        'ChainlinkFeedRegistryStub',
        feedRegistryAddress
      )
      originalEthUsdFeed = await feedRegistry.feeds(
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE
      )
    })

    after(async function () {
      const feedRegistry = await ethers.getContractAt(
        'ChainlinkFeedRegistryStub',
        feedRegistryAddress
      )
      await feedRegistry.setFeed(contracts.CHAINLINK_ETH_QUOTE, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: originalEthUsdFeed.aggregator,
        answer: originalEthUsdFeed.answer,
        updatedAt: originalEthUsdFeed.updatedAt,
        startedAt: originalEthUsdFeed.startedAt,
        answeredInRound: originalEthUsdFeed.answeredInRound,
        roundId: originalEthUsdFeed.roundId,
        decimals: originalEthUsdFeed.decimals,
      })
    })

    beforeEach(async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setEthUsdBridge(86_400)
    })

    it('configures bridge', async function () {
      const bridgeConfig = await oracleRouter.ethUsdBridge()
      expect(bridgeConfig.aggregator).to.not.equal(ethers.ZeroAddress)
      expect(bridgeConfig.maxStalenessSeconds).to.equal(86_400)
      expect(bridgeConfig.aggregatorDecimals).to.be.greaterThan(0)
      expect(bridgeConfig.scaleNumerator).to.be.greaterThan(0)
      expect(bridgeConfig.scaleDenominator).to.be.greaterThan(0)
    })

    it('emits EthUsdBridgeConfigured', async function () {
      const freshRouter = await oracleRouterFactory.deploy(agentAddress, 18, feedRegistryAddress)
      await freshRouter.waitForDeployment()
      const agentSigner = await getAgentSigner()

      await expect(freshRouter.connect(agentSigner).setEthUsdBridge(86_400))
        .to.emit(freshRouter, 'EthUsdBridgeConfigured')
        .withArgs(anyValue, anyValue, 86_400, anyValue, anyValue)
    })

    it('reverts with zero staleness', async function () {
      const agentSigner = await getAgentSigner()
      await expect(
        oracleRouter.connect(agentSigner).setEthUsdBridge(0)
      ).to.be.revertedWithCustomError(oracleRouter, 'InvalidStaleness')
    })

    it('reverts when ETH/USD feed is missing', async function () {
      const agentSigner = await getAgentSigner()
      const feedRegistry = await ethers.getContractAt(
        'ChainlinkFeedRegistryStub',
        feedRegistryAddress
      )

      await feedRegistry.setFeed(contracts.CHAINLINK_ETH_QUOTE, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: ethers.ZeroAddress,
        answer: 0n,
        updatedAt: 0n,
        startedAt: 0n,
        answeredInRound: 0n,
        roundId: 0n,
        decimals: 8,
      })

      await expect(
        oracleRouter.connect(agentSigner).setEthUsdBridge(86_400)
      ).to.be.revertedWithCustomError(oracleRouter, 'FeedMissing')

      // restore
      await feedRegistry.setFeed(contracts.CHAINLINK_ETH_QUOTE, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: originalEthUsdFeed.aggregator,
        answer: originalEthUsdFeed.answer,
        updatedAt: originalEthUsdFeed.updatedAt,
        startedAt: originalEthUsdFeed.startedAt,
        answeredInRound: originalEthUsdFeed.answeredInRound,
        roundId: originalEthUsdFeed.roundId,
        decimals: originalEthUsdFeed.decimals,
      })
    })

    it('reverts sync when called by non-agent', async function () {
      const [, nonAgentSigner] = await ethers.getSigners()
      await expect(
        oracleRouter.connect(nonAgentSigner).syncEthUsdBridge()
      ).to.be.revertedWithCustomError(oracleRouter, 'NotAgentOrManager')
    })

    it('syncs bridge', async function () {
      const agentSigner = await getAgentSigner()
      await expect(oracleRouter.connect(agentSigner).syncEthUsdBridge())
        .to.emit(oracleRouter, 'EthUsdBridgeConfigured')
        .withArgs(anyValue, anyValue, 86_400, anyValue, anyValue)

      const bridgeConfig = await oracleRouter.ethUsdBridge()
      expect(bridgeConfig.aggregator).to.not.equal(ethers.ZeroAddress)
      expect(bridgeConfig.maxStalenessSeconds).to.equal(86_400)
    })
  })

  describe('18 Decimal Scaling Tests', function () {
    let oracleRouter18: OracleRouter

    beforeEach(async function () {
      await refreshFeedData(feedConfig)

      // Deploy OracleRouter with 18 decimals
      oracleRouter18 = await oracleRouterFactory.deploy(agentAddress, 18, feedRegistryAddress)
      await oracleRouter18.waitForDeployment()

      const agentSigner = await getAgentSigner()
      await oracleRouter18.connect(agentSigner).setEthUsdBridge(86_400)
    })

    it('should correctly scale 8-decimal feed to 18-decimal unit', async function () {
      const agentSigner = await getAgentSigner()

      // Configure a token with 8-decimal feed
      await oracleRouter18
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)

      const targetDecimals = BigInt(await oracleRouter18.PRICE_DECIMALS())
      const expectedPrice = await readNormalizedFeedPrice(
        contracts.DAI,
        contracts.CHAINLINK_USD_QUOTE,
        targetDecimals
      )

      const [basePrice, quotePrice] = await oracleRouter18.getUsdPrices(
        contracts.DAI,
        contracts.DAI
      )
      expect(basePrice).to.equal(expectedPrice)
      expect(quotePrice).to.equal(expectedPrice)
    })

    it('should correctly scale 18-decimal feed to 18-decimal unit', async function () {
      const agentSigner = await getAgentSigner()

      // Configure a token with 18-decimal feed (if any exist)
      await oracleRouter18
        .connect(agentSigner)
        .setTokenFeed(contracts.STETH, QuoteDenomination.USD, 86_400, true)

      const targetDecimals = BigInt(await oracleRouter18.PRICE_DECIMALS())
      const expectedPrice = await readNormalizedFeedPrice(
        contracts.STETH,
        contracts.CHAINLINK_USD_QUOTE,
        targetDecimals
      )

      const [basePrice, quotePrice] = await oracleRouter18.getUsdPrices(
        contracts.STETH,
        contracts.STETH
      )
      expect(basePrice).to.equal(expectedPrice)
      expect(quotePrice).to.equal(expectedPrice)
    })

    it('should handle cross-decimal conversions correctly with 18-decimal unit', async function () {
      const agentSigner = await getAgentSigner()

      // Configure tokens with different decimals
      await oracleRouter18
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)

      await oracleRouter18
        .connect(agentSigner)
        .setTokenFeed(contracts.USDT, QuoteDenomination.USD, 86_400, true)

      const targetDecimals = BigInt(await oracleRouter18.PRICE_DECIMALS())
      const expectedDai = await readNormalizedFeedPrice(
        contracts.DAI,
        contracts.CHAINLINK_USD_QUOTE,
        targetDecimals
      )
      const expectedUsdt = await readNormalizedFeedPrice(
        contracts.USDT,
        contracts.CHAINLINK_USD_QUOTE,
        targetDecimals
      )

      const [daiPrice, usdtPrice] = await oracleRouter18.getUsdPrices(contracts.DAI, contracts.USDT)
      expect(daiPrice).to.equal(expectedDai)
      expect(usdtPrice).to.equal(expectedUsdt)
    })

    it('should maintain precision with 18-decimal unit', async function () {
      const agentSigner = await getAgentSigner()

      await oracleRouter18
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)

      // Test that we don't lose precision due to scaling
      const [price1, price2] = await oracleRouter18.getUsdPrices(contracts.DAI, contracts.DAI)
      expect(price1).to.equal(price2) // Same token should have same price
    })

    it('should have correct 18-decimal unit values', async function () {
      expect(await oracleRouter18.PRICE_DECIMALS()).to.equal(18)
      expect(await oracleRouter18.PRICE_UNIT()).to.equal(ethers.parseEther('1'))
    })

    it('should scale differently than 8-decimal router for same tokens', async function () {
      const agentSigner = await getAgentSigner()

      const router8 = await oracleRouterFactory.deploy(agentAddress, 8, feedRegistryAddress)
      await router8.waitForDeployment()
      await router8.connect(agentSigner).setEthUsdBridge(86_400)
      await router8
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)

      await oracleRouter18
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)

      const [price8, _] = await router8.getUsdPrices(contracts.DAI, contracts.DAI)
      const [price18, __] = await oracleRouter18.getUsdPrices(contracts.DAI, contracts.DAI)

      // Prices should be different due to different decimal scaling
      // 18-decimal router should have 10^10 times larger values than 8-decimal router
      const scaleFactor = 10n ** 10n
      expect(price18).to.equal(price8 * scaleFactor)
    })
  })

  describe('8 Decimal Scaling Tests', function () {
    let oracleRouterLegacy: OracleRouter

    beforeEach(async function () {
      oracleRouterLegacy = await oracleRouterFactory.deploy(agentAddress, 8, feedRegistryAddress)
      await oracleRouterLegacy.waitForDeployment()
      const agentSigner = await getAgentSigner()
      await oracleRouterLegacy.connect(agentSigner).setEthUsdBridge(86_400)
    })

    it('should correctly scale 8-decimal feed to 8-decimal unit', async function () {
      const agentSigner = await getAgentSigner()

      // Configure a token with 8-decimal feed
      await oracleRouterLegacy
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)

      const targetDecimals = BigInt(await oracleRouterLegacy.PRICE_DECIMALS())
      const expectedPrice = await readNormalizedFeedPrice(
        contracts.DAI,
        contracts.CHAINLINK_USD_QUOTE,
        targetDecimals
      )

      const [basePrice, quotePrice] = await oracleRouterLegacy.getUsdPrices(
        contracts.DAI,
        contracts.DAI
      )
      expect(basePrice).to.equal(expectedPrice)
      expect(quotePrice).to.equal(expectedPrice)
    })

    it('should correctly scale 18-decimal feed to 8-decimal unit', async function () {
      const agentSigner = await getAgentSigner()

      // Configure a token with 18-decimal feed (if any exist)
      await oracleRouterLegacy
        .connect(agentSigner)
        .setTokenFeed(contracts.STETH, QuoteDenomination.USD, 86_400, true)

      const targetDecimals = BigInt(await oracleRouterLegacy.PRICE_DECIMALS())
      const expectedPrice = await readNormalizedFeedPrice(
        contracts.STETH,
        contracts.CHAINLINK_USD_QUOTE,
        targetDecimals
      )

      const [basePrice, quotePrice] = await oracleRouterLegacy.getUsdPrices(
        contracts.STETH,
        contracts.STETH
      )
      expect(basePrice).to.equal(expectedPrice)
      expect(quotePrice).to.equal(expectedPrice)
    })

    it('should handle cross-decimal conversions correctly', async function () {
      const agentSigner = await getAgentSigner()

      // Configure tokens with different decimals
      await oracleRouterLegacy.connect(agentSigner).setTokenFeed(
        contracts.DAI, // 18 decimals
        QuoteDenomination.USD,
        86_400,
        true
      )

      await oracleRouterLegacy.connect(agentSigner).setTokenFeed(
        contracts.USDT, // 6 decimals
        QuoteDenomination.USD,
        86_400,
        true
      )

      const targetDecimals = BigInt(await oracleRouterLegacy.PRICE_DECIMALS())
      const expectedDai = await readNormalizedFeedPrice(
        contracts.DAI,
        contracts.CHAINLINK_USD_QUOTE,
        targetDecimals
      )
      const expectedUsdt = await readNormalizedFeedPrice(
        contracts.USDT,
        contracts.CHAINLINK_USD_QUOTE,
        targetDecimals
      )

      const [daiPrice, usdtPrice] = await oracleRouterLegacy.getUsdPrices(
        contracts.DAI,
        contracts.USDT
      )
      expect(daiPrice).to.equal(expectedDai)
      expect(usdtPrice).to.equal(expectedUsdt)
    })

    it('should maintain precision with 8-decimal unit', async function () {
      const agentSigner = await getAgentSigner()

      await oracleRouterLegacy
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)

      // Test that we don't lose precision due to scaling
      const [price1, price2] = await oracleRouterLegacy.getUsdPrices(contracts.DAI, contracts.DAI)
      expect(price1).to.equal(price2) // Same token should have same price
    })
  })

  describe('Token Configuration', function () {
    beforeEach(async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setEthUsdBridge(86_400)
    })

    describe('setTokenFeed', function () {
      it('configures token with USD feed', async function () {
        const agentSigner = await getAgentSigner()
        await oracleRouter
          .connect(agentSigner)
          .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)

        const tokenConfig = await oracleRouter.tokenConfig(contracts.DAI)
        expect(tokenConfig.primaryQuote).to.equal(0)
        expect(tokenConfig.primaryFeed.aggregator).to.not.equal(ethers.ZeroAddress)
        expect(tokenConfig.primaryFeed.maxStalenessSeconds).to.equal(86_400)
        expect(tokenConfig.tokenDecimals).to.equal(18)
        expect(tokenConfig.isActive).to.be.true
      })

      it('emits TokenConfigured', async function () {
        const agentSigner = await getAgentSigner()
        await expect(
          oracleRouter
            .connect(agentSigner)
            .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)
        )
          .to.emit(oracleRouter, 'TokenConfigured')
          .withArgs(contracts.DAI, 0, anyValue, anyValue, 86_400, 18, anyValue, anyValue, true)
      })

      it('reverts with zero token address', async function () {
        const agentSigner = await getAgentSigner()
        await expect(
          oracleRouter
            .connect(agentSigner)
            .setTokenFeed(ethers.ZeroAddress, QuoteDenomination.USD, 86_400, true)
        ).to.be.revertedWithCustomError(oracleRouter, 'InvalidTokenAddress')
      })

      it('reverts with zero staleness', async function () {
        const agentSigner = await getAgentSigner()
        await expect(
          oracleRouter
            .connect(agentSigner)
            .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 0, true)
        ).to.be.revertedWithCustomError(oracleRouter, 'InvalidStaleness')
      })

      it('reverts when USD feed is missing', async function () {
        const agentSigner = await getAgentSigner()
        const feedRegistry = await ethers.getContractAt(
          'ChainlinkFeedRegistryStub',
          feedRegistryAddress
        )

        const originalFeed = await feedRegistry.feeds(contracts.USDC, contracts.CHAINLINK_USD_QUOTE)
        await feedRegistry.setFeed(contracts.USDC, contracts.CHAINLINK_USD_QUOTE, {
          aggregator: ethers.ZeroAddress,
          answer: 0n,
          updatedAt: 0n,
          startedAt: 0n,
          answeredInRound: 0n,
          roundId: 0n,
          decimals: 8,
        })

        await expect(
          oracleRouter
            .connect(agentSigner)
            .setTokenFeed(contracts.USDC, QuoteDenomination.USD, 86_400, true)
        ).to.be.revertedWithCustomError(oracleRouter, 'FeedMissing')

        // restore
        await feedRegistry.setFeed(contracts.USDC, contracts.CHAINLINK_USD_QUOTE, {
          aggregator: originalFeed.aggregator,
          answer: originalFeed.answer,
          updatedAt: originalFeed.updatedAt,
          startedAt: originalFeed.startedAt,
          answeredInRound: originalFeed.answeredInRound,
          roundId: originalFeed.roundId,
          decimals: originalFeed.decimals,
        })
      })
    })

    describe('setTokenFeed', function () {
      it('configures token with ETH feed', async function () {
        const agentSigner = await getAgentSigner()
        await oracleRouter
          .connect(agentSigner)
          .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86_400, true)

        const tokenConfig = await oracleRouter.tokenConfig(contracts.STETH)
        expect(tokenConfig.primaryQuote).to.equal(1)
        expect(tokenConfig.primaryFeed.aggregator).to.not.equal(ethers.ZeroAddress)
        expect(tokenConfig.primaryFeed.maxStalenessSeconds).to.equal(86_400)
        expect(tokenConfig.tokenDecimals).to.equal(18)
        expect(tokenConfig.isActive).to.be.true
      })

      it('emits TokenConfigured for ETH feed', async function () {
        const agentSigner = await getAgentSigner()
        await expect(
          oracleRouter
            .connect(agentSigner)
            .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86_400, true)
        )
          .to.emit(oracleRouter, 'TokenConfigured')
          .withArgs(contracts.STETH, 1, anyValue, anyValue, 86_400, 18, anyValue, anyValue, true)
      })
    })

    describe('setTokenActive', function () {
      beforeEach(async function () {
        const agentSigner = await getAgentSigner()
        await oracleRouter
          .connect(agentSigner)
          .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)
      })

      it('toggles token active status', async function () {
        const agentSigner = await getAgentSigner()
        await oracleRouter.connect(agentSigner).setTokenActive(contracts.DAI, false)
        let tokenConfig = await oracleRouter.tokenConfig(contracts.DAI)
        expect(tokenConfig.isActive).to.be.false

        await oracleRouter.connect(agentSigner).setTokenActive(contracts.DAI, true)
        tokenConfig = await oracleRouter.tokenConfig(contracts.DAI)
        expect(tokenConfig.isActive).to.be.true
      })

      it('emits TokenActiveUpdated', async function () {
        const agentSigner = await getAgentSigner()
        await expect(oracleRouter.connect(agentSigner).setTokenActive(contracts.DAI, false))
          .to.emit(oracleRouter, 'TokenActiveUpdated')
          .withArgs(contracts.DAI, false)
      })

      it('reverts with zero token address', async function () {
        const agentSigner = await getAgentSigner()
        await expect(
          oracleRouter.connect(agentSigner).setTokenActive(ethers.ZeroAddress, true)
        ).to.be.revertedWithCustomError(oracleRouter, 'InvalidTokenAddress')
      })

      it('reverts when activating unconfigured token', async function () {
        const agentSigner = await getAgentSigner()
        await expect(
          oracleRouter.connect(agentSigner).setTokenActive(contracts.USDC, true)
        ).to.be.revertedWithCustomError(oracleRouter, 'TokenNotConfigured')
      })
    })

    describe('setTokenEthUsdStalenessOverride', function () {
      beforeEach(async function () {
        const agentSigner = await getAgentSigner()
        await oracleRouter
          .connect(agentSigner)
          .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)
      })

      it('sets ETH/USD staleness override', async function () {
        const agentSigner = await getAgentSigner()
        await expect(
          oracleRouter.connect(agentSigner).setTokenEthUsdStalenessOverride(contracts.DAI, 43_200)
        )
          .to.emit(oracleRouter, 'TokenEthUsdStalenessOverridden')
          .withArgs(contracts.DAI, 43_200)

        const tokenConfig = await oracleRouter.tokenConfig(contracts.DAI)
        expect(tokenConfig.ethUsdMaxStalenessOverrideSeconds).to.equal(43_200)
      })

      it('reverts with zero token address', async function () {
        const agentSigner = await getAgentSigner()
        await expect(
          oracleRouter
            .connect(agentSigner)
            .setTokenEthUsdStalenessOverride(ethers.ZeroAddress, 43_200)
        ).to.be.revertedWithCustomError(oracleRouter, 'InvalidTokenAddress')
      })

      it('reverts when called by non-agent', async function () {
        const [, nonAgentSigner] = await ethers.getSigners()
        await expect(
          oracleRouter
            .connect(nonAgentSigner)
            .setTokenEthUsdStalenessOverride(contracts.DAI, 43_200)
        ).to.be.revertedWithCustomError(oracleRouter, 'NotAgentOrManager')
      })
    })
  })

  describe('Sync Functions', function () {
    beforeEach(async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setEthUsdBridge(86_400)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.STETH, QuoteDenomination.USD, 86_400, true)
    })

    it('isBridgeInSync returns true when in sync', async function () {
      expect(await oracleRouter.isBridgeInSync()).to.be.true
    })

    it('isFeedInSync returns true for configured tokens, false otherwise', async function () {
      expect(await oracleRouter.isFeedInSync(contracts.DAI)).to.be.true
      expect(await oracleRouter.isFeedInSync(contracts.STETH)).to.be.true
      expect(await oracleRouter.isFeedInSync(contracts.USDC)).to.be.false
    })

    it('syncTokenFeed emits TokenConfigured', async function () {
      const agentSigner = await getAgentSigner()
      await expect(oracleRouter.connect(agentSigner).syncTokenFeed(contracts.DAI))
        .to.emit(oracleRouter, 'TokenConfigured')
        .withArgs(contracts.DAI, 0, anyValue, anyValue, 86_400, 18, anyValue, anyValue, true)
    })

    it('syncTokenFeed reverts for unconfigured token and non-agent', async function () {
      const agentSigner = await getAgentSigner()
      await expect(
        oracleRouter.connect(agentSigner).syncTokenFeed(contracts.USDC)
      ).to.be.revertedWithCustomError(oracleRouter, 'TokenNotConfigured')

      const [, nonAgentSigner] = await ethers.getSigners()
      await expect(
        oracleRouter.connect(nonAgentSigner).syncTokenFeed(contracts.DAI)
      ).to.be.revertedWithCustomError(oracleRouter, 'NotAgentOrManager')
    })
  })

  describe('Price Queries', function () {
    beforeEach(async function () {
      const agentSigner = await getAgentSigner()

      // Ensure ETH/USD feed exists and is fresh before setting bridge
      const currentTimestamp = await getCurrentTimestamp()
      await updateTokenFeed(
        feedConfig,
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE,
        {
          updatedAt: currentTimestamp,
        }
      )

      await oracleRouter.connect(agentSigner).setEthUsdBridge(86_400)

      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.USDC, QuoteDenomination.USD, 86_400, true)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.STETH, QuoteDenomination.USD, 86_400, true)

      // keep feeds fresh for price reads
      await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        updatedAt: currentTimestamp,
      })
      await updateTokenFeed(feedConfig, contracts.USDC, contracts.CHAINLINK_USD_QUOTE, {
        updatedAt: currentTimestamp,
      })
      await updateTokenFeed(feedConfig, contracts.STETH, contracts.CHAINLINK_ETH_QUOTE, {
        updatedAt: currentTimestamp,
      })
    })

    describe('getUsdPrices', function () {
      it('returns USD prices for both tokens', async function () {
        const [daiUsdPrice, usdcUsdPrice] = await oracleRouter.getUsdPrices(
          contracts.DAI,
          contracts.USDC
        )

        const expectedDai = await getExpectedUsdPrice(oracleRouter, contracts.DAI)
        const expectedUsdc = await getExpectedUsdPrice(oracleRouter, contracts.USDC)

        expect(daiUsdPrice).to.equal(expectedDai)
        expect(usdcUsdPrice).to.equal(expectedUsdc)
      })

      it('handles ETH bridge path', async function () {
        // Configure STETH as ETH-quoted for this test (beforeEach configures it as USD-quoted)
        const agentSigner = await getAgentSigner()
        const currentTimestamp = await getCurrentTimestamp()
        await updateTokenFeed(feedConfig, contracts.STETH, contracts.CHAINLINK_ETH_QUOTE, {
          updatedAt: currentTimestamp,
        })
        await oracleRouter
          .connect(agentSigner)
          .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86_400, true)

        const [stethUsdPrice, daiUsdPrice] = await oracleRouter.getUsdPrices(
          contracts.STETH,
          contracts.DAI
        )

        const expectedSteth = await getExpectedUsdBridgePrice(oracleRouter, contracts.STETH)
        const expectedDai = await getExpectedUsdPrice(oracleRouter, contracts.DAI)

        expect(stethUsdPrice).to.equal(expectedSteth)
        expect(daiUsdPrice).to.equal(expectedDai)
      })
    })

    describe('getPricesAndDecimals', function () {
      describe('Happy paths', function () {
        it('returns correct prices and decimals', async function () {
          const [daiPrice, usdcPrice, daiDecimals, usdcDecimals] =
            await oracleRouter.getPricesAndDecimals(
              contracts.DAI,
              contracts.USDC,
              QuoteDenomination.USD
            )
          expect(daiDecimals).to.equal(18)
          expect(usdcDecimals).to.equal(6)

          const expectedDai = await getExpectedUsdPrice(oracleRouter, contracts.DAI)
          const expectedUsdc = await getExpectedUsdPrice(oracleRouter, contracts.USDC)

          expect(daiPrice).to.equal(expectedDai)
          expect(usdcPrice).to.equal(expectedUsdc)
        })

        it('should handle same token for base and quote', async function () {
          const result = await oracleRouter.getPricesAndDecimals(
            contracts.DAI,
            contracts.DAI,
            QuoteDenomination.USD
          )
          expect(result.basePrice).to.equal(result.quotePrice)
          expect(result.baseTokenDecimals).to.equal(result.quoteTokenDecimals)
          expect(result.baseTokenDecimals).to.equal(18)
        })

        it('should handle tokens with different decimals', async function () {
          const result = await oracleRouter.getPricesAndDecimals(
            contracts.DAI,
            contracts.USDC,
            QuoteDenomination.USD
          )
          expect(result.baseTokenDecimals).to.equal(18)
          expect(result.quoteTokenDecimals).to.equal(6)

          const expectedDai = await getExpectedUsdPrice(oracleRouter, contracts.DAI)
          const expectedUsdc = await getExpectedUsdPrice(oracleRouter, contracts.USDC)

          expect(result.basePrice).to.equal(expectedDai)
          expect(result.quotePrice).to.equal(expectedUsdc)
        })
      })

      describe('Validation - Token not configured', function () {
        it('should revert if base token not configured', async function () {
          const randomAddress = ethers.Wallet.createRandom().address

          await expect(
            oracleRouter.getPricesAndDecimals(randomAddress, contracts.DAI, QuoteDenomination.USD)
          )
            .to.be.revertedWithCustomError(oracleRouter, 'TokenNotConfigured')
            .withArgs(randomAddress)
        })

        it('should revert if quote token not configured', async function () {
          const randomAddress = ethers.Wallet.createRandom().address

          await expect(
            oracleRouter.getPricesAndDecimals(contracts.DAI, randomAddress, QuoteDenomination.USD)
          )
            .to.be.revertedWithCustomError(oracleRouter, 'TokenNotConfigured')
            .withArgs(randomAddress)
        })

        it('should revert if base token inactive', async function () {
          const agent = await getAgentSigner()

          await oracleRouter.connect(agent).setTokenActive(contracts.DAI, false)

          await expect(
            oracleRouter.getPricesAndDecimals(contracts.DAI, contracts.USDC, QuoteDenomination.USD)
          )
            .to.be.revertedWithCustomError(oracleRouter, 'TokenNotConfigured')
            .withArgs(contracts.DAI)
        })

        it('should revert if quote token inactive', async function () {
          const agent = await getAgentSigner()

          await oracleRouter.connect(agent).setTokenActive(contracts.USDC, false)

          await expect(
            oracleRouter.getPricesAndDecimals(contracts.DAI, contracts.USDC, QuoteDenomination.USD)
          )
            .to.be.revertedWithCustomError(oracleRouter, 'TokenNotConfigured')
            .withArgs(contracts.USDC)
        })
      })

      describe('Bridging - Mixed Denominations', function () {
        beforeEach(async function () {
          const agent = await getAgentSigner()
          const currentTimestamp = await getCurrentTimestamp()

          // Configure LDO as ETH-quoted
          await oracleRouter
            .connect(agent)
            .setTokenFeed(contracts.LDO, QuoteDenomination.ETH, 86400, true)

          // Update feeds to be fresh
          await updateTokenFeed(feedConfig, contracts.LDO, contracts.CHAINLINK_ETH_QUOTE, {
            updatedAt: currentTimestamp,
          })
          await updateTokenFeed(
            feedConfig,
            contracts.CHAINLINK_ETH_QUOTE,
            contracts.CHAINLINK_USD_QUOTE,
            {
              updatedAt: currentTimestamp,
            }
          )
        })

        it('should bridge ETH-quoted base token to USD when requesting USD quote', async function () {
          const agent = await getAgentSigner()
          await oracleRouter
            .connect(agent)
            .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86400, true)

          const currentTimestamp = await getCurrentTimestamp()
          await updateTokenFeed(feedConfig, contracts.STETH, contracts.CHAINLINK_ETH_QUOTE, {
            updatedAt: currentTimestamp,
          })

          const [stethPrice, daiPrice, stethDecimals, daiDecimals] =
            await oracleRouter.getPricesAndDecimals(
              contracts.STETH,
              contracts.DAI,
              QuoteDenomination.USD
            )

          expect(stethDecimals).to.equal(18)
          expect(daiDecimals).to.equal(18)

          const expectedSteth = await getExpectedUsdBridgePrice(oracleRouter, contracts.STETH)
          const expectedDai = await getExpectedUsdPrice(oracleRouter, contracts.DAI)

          expect(stethPrice).to.equal(expectedSteth)
          expect(daiPrice).to.equal(expectedDai)
        })

        it('should bridge ETH-quoted quote token to USD when requesting USD quote', async function () {
          const [daiPrice, ldoPrice, daiDecimals, ldoDecimals] =
            await oracleRouter.getPricesAndDecimals(
              contracts.DAI,
              contracts.LDO,
              QuoteDenomination.USD
            )

          expect(daiDecimals).to.equal(18)
          expect(ldoDecimals).to.equal(18)

          const expectedDai = await getExpectedUsdPrice(oracleRouter, contracts.DAI)
          const expectedLdo = await getExpectedUsdBridgePrice(oracleRouter, contracts.LDO)

          expect(daiPrice).to.equal(expectedDai)
          expect(ldoPrice).to.equal(expectedLdo)
        })

        it('should bridge both tokens when both are ETH-quoted and requesting USD', async function () {
          const agent = await getAgentSigner()
          await oracleRouter
            .connect(agent)
            .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86400, true)

          const currentTimestamp = await getCurrentTimestamp()
          await updateTokenFeed(feedConfig, contracts.STETH, contracts.CHAINLINK_ETH_QUOTE, {
            updatedAt: currentTimestamp,
          })

          const [stethPrice, ldoPrice, stethDecimals, ldoDecimals] =
            await oracleRouter.getPricesAndDecimals(
              contracts.STETH,
              contracts.LDO,
              QuoteDenomination.USD
            )

          expect(stethDecimals).to.equal(18)
          expect(ldoDecimals).to.equal(18)

          const expectedSteth = await getExpectedUsdBridgePrice(oracleRouter, contracts.STETH)
          const expectedLdo = await getExpectedUsdBridgePrice(oracleRouter, contracts.LDO)

          expect(stethPrice).to.equal(expectedSteth)
          expect(ldoPrice).to.equal(expectedLdo)
        })

        it('should bridge USD-quoted base token to ETH when requesting ETH quote', async function () {
          const agent = await getAgentSigner()
          // Configure STETH as USD-quoted so it needs bridging (beforeEach configures it as USD-quoted, but we need to ensure it's fresh)
          const currentTimestamp = await getCurrentTimestamp()
          await updateTokenFeed(feedConfig, contracts.STETH, contracts.CHAINLINK_USD_QUOTE, {
            updatedAt: currentTimestamp,
          })
          await oracleRouter
            .connect(agent)
            .setTokenFeed(contracts.STETH, QuoteDenomination.USD, 86400, true)

          const [daiPrice, stethPrice, daiDecimals, stethDecimals] =
            await oracleRouter.getPricesAndDecimals(
              contracts.DAI,
              contracts.STETH,
              QuoteDenomination.ETH
            )

          expect(daiDecimals).to.equal(18)
          expect(stethDecimals).to.equal(18)

          // Both DAI and STETH are USD-quoted, so both need bridging to ETH
          const expectedDai = await getExpectedEthBridgePrice(oracleRouter, contracts.DAI)
          const expectedSteth = await getExpectedEthBridgePrice(oracleRouter, contracts.STETH)

          expect(daiPrice).to.equal(expectedDai)
          expect(stethPrice).to.equal(expectedSteth)
        })

        it('should bridge USD-quoted quote token to ETH when requesting ETH quote', async function () {
          const agent = await getAgentSigner()
          await oracleRouter
            .connect(agent)
            .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86400, true)

          const currentTimestamp = await getCurrentTimestamp()
          await updateTokenFeed(feedConfig, contracts.STETH, contracts.CHAINLINK_ETH_QUOTE, {
            updatedAt: currentTimestamp,
          })

          const [stethPrice, daiPrice, stethDecimals, daiDecimals] =
            await oracleRouter.getPricesAndDecimals(
              contracts.STETH,
              contracts.DAI,
              QuoteDenomination.ETH
            )

          expect(stethDecimals).to.equal(18)
          expect(daiDecimals).to.equal(18)

          const routerDecimals = await getRouterPriceDecimals(oracleRouter)
          const expectedSteth = await readNormalizedFeedPrice(
            contracts.STETH,
            contracts.CHAINLINK_ETH_QUOTE,
            routerDecimals
          )
          const expectedDai = await getExpectedEthBridgePrice(oracleRouter, contracts.DAI)

          expect(stethPrice).to.equal(expectedSteth)
          expect(daiPrice).to.equal(expectedDai)
        })

        it('should bridge both tokens when both are USD-quoted and requesting ETH', async function () {
          const [daiPrice, usdcPrice, daiDecimals, usdcDecimals] =
            await oracleRouter.getPricesAndDecimals(
              contracts.DAI,
              contracts.USDC,
              QuoteDenomination.ETH
            )

          const [expectedDai, expectedUsdc] = await getExpectedPricesForPair(
            oracleRouter,
            contracts.DAI,
            contracts.USDC,
            QuoteDenomination.ETH
          )

          expect(daiPrice).to.equal(expectedDai)
          expect(usdcPrice).to.equal(expectedUsdc)
          expect(daiDecimals).to.equal(18)
          expect(usdcDecimals).to.equal(6)
        })

        it('should revert if ETH/USD bridge is not configured when bridging is needed', async function () {
          const agent = await getAgentSigner()
          // Deploy a fresh router without bridge configured
          const freshRouter = await oracleRouterFactory.deploy(
            agentAddress,
            18,
            feedRegistryAddress
          )
          await freshRouter.waitForDeployment()

          await freshRouter
            .connect(agent)
            .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86400, true)
          await freshRouter
            .connect(agent)
            .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, true)

          // Should revert when trying to bridge without ETH/USD bridge configured
          await expect(
            freshRouter.getPricesAndDecimals(contracts.STETH, contracts.DAI, QuoteDenomination.USD)
          ).to.be.revertedWithCustomError(freshRouter, 'EthUsdBridgeMissing')
        })
      })

      describe('Staleness checks', function () {
        it('should revert if base token feed is stale', async function () {
          const maxStaleness = 86400 + 3600
          await ethers.provider.send('evm_increaseTime', [maxStaleness])
          await ethers.provider.send('evm_mine', [])

          await expect(
            oracleRouter.getPricesAndDecimals(contracts.DAI, contracts.USDC, QuoteDenomination.USD)
          ).to.be.revertedWithCustomError(oracleRouter, 'OracleStale')
        })

        it('should revert if quote token feed is stale', async function () {
          const maxStaleness = 86400 + 3600
          await ethers.provider.send('evm_increaseTime', [maxStaleness])
          await ethers.provider.send('evm_mine', [])

          await expect(
            oracleRouter.getPricesAndDecimals(contracts.DAI, contracts.USDC, QuoteDenomination.USD)
          ).to.be.revertedWithCustomError(oracleRouter, 'OracleStale')
        })
      })

      describe('Edge cases', function () {
        it('should work with maximum valid staleness value', async function () {
          const agent = await getAgentSigner()
          const maxStaleness = 2 ** 32 - 1

          await oracleRouter
            .connect(agent)
            .setTokenFeed(contracts.DAI, QuoteDenomination.USD, maxStaleness, true)
          await oracleRouter
            .connect(agent)
            .setTokenFeed(contracts.USDC, QuoteDenomination.USD, maxStaleness, true)

          const result = await oracleRouter.getPricesAndDecimals(
            contracts.DAI,
            contracts.USDC,
            QuoteDenomination.USD
          )
          const [expectedDai, expectedUsdc] = await getExpectedPricesForPair(
            oracleRouter,
            contracts.DAI,
            contracts.USDC,
            QuoteDenomination.USD
          )
          expect(result.basePrice).to.equal(expectedDai)
          expect(result.quotePrice).to.equal(expectedUsdc)
        })
      })
    })
  })

  describe('Oracle Staleness', function () {
    beforeEach(async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setEthUsdBridge(1)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 1, true)
    })

    it('reverts with OracleStale when token feed is stale', async function () {
      const staleTimestamp = (await getCurrentTimestamp()) - 2n
      await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        updatedAt: staleTimestamp,
      })
      await expect(
        oracleRouter.getUsdPrices(contracts.DAI, contracts.DAI)
      ).to.be.revertedWithCustomError(oracleRouter, 'OracleStale')
    })

    it('reverts with OracleStale when ETH/USD bridge is stale', async function () {
      const staleTimestamp = (await getCurrentTimestamp()) - 2n
      await updateTokenFeed(
        feedConfig,
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE,
        { updatedAt: staleTimestamp }
      )
      await expect(
        oracleRouter.getUsdPrices(contracts.DAI, contracts.DAI)
      ).to.be.revertedWithCustomError(oracleRouter, 'OracleStale')
    })

    it('accepts updatedAt exactly at staleness boundary', async function () {
      const agentSigner = await getAgentSigner()
      const maxStalenessSeconds = 10
      await oracleRouter.connect(agentSigner).setEthUsdBridge(maxStalenessSeconds)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, maxStalenessSeconds, true)

      // anchor on a known block timestamp
      const latestBlock = await ethers.provider.getBlock('latest')
      const baseTimestamp = BigInt(latestBlock!.timestamp)

      // set both feeds' updatedAt to baseTimestamp
      await updateTokenFeed(
        feedConfig,
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE,
        { updatedAt: baseTimestamp }
      )
      await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        updatedAt: baseTimestamp,
      })

      // mine a block exactly at boundary
      await ethers.provider.send('evm_mine', [Number(baseTimestamp + BigInt(maxStalenessSeconds))])

      const [firstUsdPrice, secondUsdPrice] = await oracleRouter.getUsdPrices(
        contracts.DAI,
        contracts.DAI
      )
      expect(firstUsdPrice).to.be.greaterThan(0)
      expect(secondUsdPrice).to.be.greaterThan(0)
    })
  })

  describe('Oracle Bad Answer', function () {
    beforeEach(async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setEthUsdBridge(86_400)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)
    })

    it('reverts with OracleBadAnswer when answer is zero', async function () {
      await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        answer: 0n,
      })
      await expect(
        oracleRouter.getUsdPrices(contracts.DAI, contracts.DAI)
      ).to.be.revertedWithCustomError(oracleRouter, 'OracleBadAnswer')
    })

    it('reverts with OracleBadAnswer when answer is negative', async function () {
      await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        answer: -1n,
      })
      await expect(
        oracleRouter.getUsdPrices(contracts.DAI, contracts.DAI)
      ).to.be.revertedWithCustomError(oracleRouter, 'OracleBadAnswer')
    })

    it('reverts with OracleUnanswered when answeredInRound < roundId', async function () {
      const feedRegistry = await ethers.getContractAt(
        'ChainlinkFeedRegistryStub',
        feedRegistryAddress
      )
      const existingFeed = await feedRegistry.feeds(contracts.DAI, contracts.CHAINLINK_USD_QUOTE)

      await feedRegistry.setFeed(contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: existingFeed.aggregator,
        answer: existingFeed.answer,
        updatedAt: await getCurrentTimestamp(),
        startedAt: existingFeed.startedAt,
        answeredInRound: 9n,
        roundId: 10n,
        decimals: existingFeed.decimals,
      })

      await expect(
        oracleRouter.getUsdPrices(contracts.DAI, contracts.DAI)
      ).to.be.revertedWithCustomError(oracleRouter, 'OracleUnanswered')
    })
  })

  describe('Scale Factors', function () {
    beforeEach(async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setEthUsdBridge(86_400)

      const feedRegistry = await ethers.getContractAt(
        'ChainlinkFeedRegistryStub',
        feedRegistryAddress
      )

      await feedRegistry.setFeed(contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: await feedRegistry.getAddress(),
        answer: 1n * 10n ** 8n,
        updatedAt: await getCurrentTimestamp(),
        startedAt: 0n,
        answeredInRound: 0n,
        roundId: 0n,
        decimals: 8,
      })

      await feedRegistry.setFeed(contracts.USDC, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: await feedRegistry.getAddress(),
        answer: 1n * 10n ** 8n,
        updatedAt: await getCurrentTimestamp(),
        startedAt: 0n,
        answeredInRound: 0n,
        roundId: 0n,
        decimals: 8,
      })
    })

    it('handles different aggregator decimals', async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.USDC, QuoteDenomination.USD, 86_400, true)

      const daiConfig = await oracleRouter.tokenConfig(contracts.DAI)
      const usdcConfig = await oracleRouter.tokenConfig(contracts.USDC)

      expect(daiConfig.primaryFeed.scaleNumerator).to.be.greaterThan(0)
      expect(daiConfig.primaryFeed.scaleDenominator).to.be.greaterThan(0)
      expect(usdcConfig.primaryFeed.scaleNumerator).to.be.greaterThan(0)
      expect(usdcConfig.primaryFeed.scaleDenominator).to.be.greaterThan(0)
    })
  })

  describe('Edge Cases', function () {
    beforeEach(async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setEthUsdBridge(86_400)

      const feedRegistry = await ethers.getContractAt(
        'ChainlinkFeedRegistryStub',
        feedRegistryAddress
      )

      await feedRegistry.setFeed(contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: await feedRegistry.getAddress(),
        answer: 1n * 10n ** 8n,
        updatedAt: await getCurrentTimestamp(),
        startedAt: 0n,
        answeredInRound: 0n,
        roundId: 0n,
        decimals: 8,
      })
    })

    it('handles same token for base and quote', async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)

      const [firstUsdPrice, secondUsdPrice] = await oracleRouter.getUsdPrices(
        contracts.DAI,
        contracts.DAI
      )
      expect(firstUsdPrice).to.equal(secondUsdPrice)
    })

    it('handles maximum staleness values', async function () {
      const agentSigner = await getAgentSigner()
      const maxStalenessSeconds = 2 ** 32 - 1
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, maxStalenessSeconds, true)

      const tokenConfig = await oracleRouter.tokenConfig(contracts.DAI)
      expect(tokenConfig.primaryFeed.maxStalenessSeconds).to.equal(maxStalenessSeconds)
    })
  })

  // -------- Feed drift detection and recovery

  describe('Feed drift detection', function () {
    beforeEach(async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setEthUsdBridge(86_400)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)
    })

    it('reverts with FeedConfigOutOfSync when registry aggregator changes', async function () {
      const feedRegistry = await ethers.getContractAt(
        'ChainlinkFeedRegistryStub',
        feedRegistryAddress
      )
      const existingFeed = await feedRegistry.feeds(contracts.DAI, contracts.CHAINLINK_USD_QUOTE)
      const fakeAggregator = ethers.Wallet.createRandom().address

      await feedRegistry.setFeed(contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: fakeAggregator,
        answer: existingFeed.answer,
        updatedAt: await getCurrentTimestamp(),
        startedAt: existingFeed.startedAt,
        answeredInRound: existingFeed.answeredInRound,
        roundId: existingFeed.roundId,
        decimals: existingFeed.decimals,
      })

      await expect(
        oracleRouter.getUsdPrices(contracts.DAI, contracts.DAI)
      ).to.be.revertedWithCustomError(oracleRouter, 'FeedConfigOutOfSync')
    })

    it('reverts with FeedConfigOutOfSync when registry decimals change', async function () {
      const feedRegistry = await ethers.getContractAt(
        'ChainlinkFeedRegistryStub',
        feedRegistryAddress
      )
      const existingFeed = await feedRegistry.feeds(contracts.DAI, contracts.CHAINLINK_USD_QUOTE)

      await feedRegistry.setFeed(contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: existingFeed.aggregator,
        answer: existingFeed.answer,
        updatedAt: await getCurrentTimestamp(),
        startedAt: existingFeed.startedAt,
        answeredInRound: existingFeed.answeredInRound,
        roundId: existingFeed.roundId,
        decimals: Number(existingFeed.decimals) === 8 ? 18 : 8,
      })

      await expect(
        oracleRouter.getUsdPrices(contracts.DAI, contracts.DAI)
      ).to.be.revertedWithCustomError(oracleRouter, 'FeedConfigOutOfSync')
    })

    it('recovers after syncTokenFeed', async function () {
      const agentSigner = await getAgentSigner()
      const feedRegistry = await ethers.getContractAt(
        'ChainlinkFeedRegistryStub',
        feedRegistryAddress
      )
      const existingFeed = await feedRegistry.feeds(contracts.DAI, contracts.CHAINLINK_USD_QUOTE)
      const fakeAggregator = ethers.Wallet.createRandom().address

      await feedRegistry.setFeed(contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: fakeAggregator,
        answer: existingFeed.answer,
        updatedAt: await getCurrentTimestamp(),
        startedAt: existingFeed.startedAt,
        answeredInRound: existingFeed.answeredInRound,
        roundId: existingFeed.roundId,
        decimals: existingFeed.decimals,
      })

      await expect(
        oracleRouter.getUsdPrices(contracts.DAI, contracts.DAI)
      ).to.be.revertedWithCustomError(oracleRouter, 'FeedConfigOutOfSync')

      await oracleRouter.connect(agentSigner).syncTokenFeed(contracts.DAI)
      const [firstUsdPrice, secondUsdPrice] = await oracleRouter.getUsdPrices(
        contracts.DAI,
        contracts.DAI
      )
      expect(firstUsdPrice).to.be.greaterThan(0)
      expect(secondUsdPrice).to.be.greaterThan(0)
    })
  })

  // -------- Quantization guard

  describe('OracleQuantizedToZero guard', function () {
    it('reverts when normalization floors to zero at chosen PRICE_UNIT', async function () {
      const smallUnitFactory = await ethers.getContractFactory('OracleRouter')
      const smallUnitRouter = await smallUnitFactory.deploy(
        agentAddress,
        2, // PRICE_DECIMALS = 2
        feedRegistryAddress
      )
      await smallUnitRouter.waitForDeployment()

      const agentSigner = await getAgentSigner()
      await smallUnitRouter.connect(agentSigner).setEthUsdBridge(86_400)

      const feedRegistry = await ethers.getContractAt(
        'ChainlinkFeedRegistryStub',
        feedRegistryAddress
      )

      await feedRegistry.setFeed(contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: await feedRegistry.getAddress(),
        answer: 1n, // tiny value with 18 decimals → 0 at PRICE_UNIT=1e2
        updatedAt: await getCurrentTimestamp(),
        startedAt: 0n,
        answeredInRound: 1n,
        roundId: 1n,
        decimals: 18,
      })

      await expect(
        smallUnitRouter
          .connect(agentSigner)
          .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)
      ).to.emit(smallUnitRouter, 'TokenConfigured')

      await expect(
        smallUnitRouter.getUsdPrices(contracts.DAI, contracts.DAI)
      ).to.be.revertedWithCustomError(smallUnitRouter, 'OracleQuantizedToZero')
    })
  })

  // -------- Per-token ETH/USD staleness override semantics

  describe('Per-token ETH/USD staleness override', function () {
    beforeEach(async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setEthUsdBridge(86_400)
      // Configure STETH as ETH-quoted so the override applies
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 300, true)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)
    })

    it('uses min(override, global) when override is set', async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setTokenEthUsdStalenessOverride(contracts.STETH, 60)

      // Make ETH/USD bridge stale (5 minutes old, which is > 60 second override)
      const currentTimestamp = await getCurrentTimestamp()
      const fiveMinutesOld = currentTimestamp - 300n
      await updateTokenFeed(
        feedConfig,
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE,
        { updatedAt: fiveMinutesOld }
      )

      // Ensure STETH/ETH feed is fresh
      await updateTokenFeed(feedConfig, contracts.STETH, contracts.CHAINLINK_ETH_QUOTE, {
        updatedAt: currentTimestamp,
      })

      // Advance time to ensure the staleness check passes
      await ethers.provider.send('evm_increaseTime', [1])
      await ethers.provider.send('evm_mine', [])

      await expect(
        oracleRouter.getUsdPrices(contracts.STETH, contracts.DAI)
      ).to.be.revertedWithCustomError(oracleRouter, 'OracleStale')
    })

    it('falls back to global when override is zero', async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setTokenEthUsdStalenessOverride(contracts.STETH, 0)

      // anchor to the latest mined block timestamp to avoid drift
      const latestBlock = await ethers.provider.getBlock('latest')
      const baseTimestamp = BigInt(latestBlock!.timestamp)

      // ETH/USD is 120s old relative to baseTimestamp, which is < global cap 86,400
      await updateTokenFeed(
        feedConfig,
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE,
        { updatedAt: baseTimestamp - 120n }
      )
      // STETH/ETH is fresh at the same baseTimestamp
      await updateTokenFeed(feedConfig, contracts.STETH, contracts.CHAINLINK_ETH_QUOTE, {
        updatedAt: baseTimestamp,
      })

      // do not advance time; call in the same block context to keep staleness exact
      const [stethUsdPrice, daiUsdPrice] = await oracleRouter.getUsdPrices(
        contracts.STETH,
        contracts.DAI
      )
      const [expectedSteth, expectedDai] = await getExpectedPricesForPair(
        oracleRouter,
        contracts.STETH,
        contracts.DAI,
        QuoteDenomination.USD
      )
      expect(stethUsdPrice).to.equal(expectedSteth)
      expect(daiUsdPrice).to.equal(expectedDai)
    })
  })

  describe('getPricesAndDecimals()', function () {
    beforeEach(async function () {
      const agent = await getAgentSigner()

      // Configure ETH-quoted tokens for testing
      await oracleRouter
        .connect(agent)
        .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86400, true)
      await oracleRouter
        .connect(agent)
        .setTokenFeed(contracts.LDO, QuoteDenomination.ETH, 86400, true)
    })

    describe('Happy paths', function () {
      it('should return ETH prices for two ETH-quoted tokens (stETH/LDO)', async function () {
        const result = await oracleRouter.getPricesAndDecimals(
          contracts.STETH,
          contracts.LDO,
          QuoteDenomination.ETH
        )

        const [expectedSteth, expectedLdo] = await getExpectedPricesForPair(
          oracleRouter,
          contracts.STETH,
          contracts.LDO,
          QuoteDenomination.ETH
        )
        expect(result.basePrice).to.equal(expectedSteth)
        expect(result.quotePrice).to.equal(expectedLdo)
        expect(result.baseTokenDecimals).to.equal(18)
        expect(result.quoteTokenDecimals).to.equal(18)
      })

      it('should return ETH prices for same token pair (stETH/stETH)', async function () {
        const result = await oracleRouter.getPricesAndDecimals(
          contracts.STETH,
          contracts.STETH,
          QuoteDenomination.ETH
        )

        const [expectedSteth] = await getExpectedPricesForPair(
          oracleRouter,
          contracts.STETH,
          contracts.STETH,
          QuoteDenomination.ETH
        )
        expect(result.basePrice).to.equal(expectedSteth)
        expect(result.quotePrice).to.equal(expectedSteth)
        // Same token should have identical prices
        expect(result.basePrice).to.equal(result.quotePrice)
        expect(result.baseTokenDecimals).to.equal(18)
        expect(result.quoteTokenDecimals).to.equal(18)
      })

      it('should return correct token decimals', async function () {
        const result = await oracleRouter.getPricesAndDecimals(
          contracts.STETH,
          contracts.LDO,
          QuoteDenomination.ETH
        )

        // Verify decimals match configured values
        expect(result.baseTokenDecimals).to.equal(18)
        expect(result.quoteTokenDecimals).to.equal(18)
      })

      it('should normalize prices to PRICE_UNIT', async function () {
        const result = await oracleRouter.getPricesAndDecimals(
          contracts.STETH,
          contracts.LDO,
          QuoteDenomination.ETH
        )

        const [expectedSteth, expectedLdo] = await getExpectedPricesForPair(
          oracleRouter,
          contracts.STETH,
          contracts.LDO,
          QuoteDenomination.ETH
        )
        expect(result.basePrice).to.equal(expectedSteth)
        expect(result.quotePrice).to.equal(expectedLdo)

        // Prices should be normalized to the configured unit decimals
        const priceUnit = await oracleRouter.PRICE_UNIT()

        // stETH/ETH should be close to 1 (allowing for small deviations)
        const minPrice = (priceUnit * 8n) / 10n // 0.8
        const maxPrice = (priceUnit * 12n) / 10n // 1.2

        expect(result.basePrice).to.be.gte(minPrice)
        expect(result.basePrice).to.be.lte(maxPrice)

        // LDO should have a reasonable ETH price
        expect(result.quotePrice).to.be.lt(priceUnit)
      })
    })

    describe('Validation - Token not configured', function () {
      it('should revert if base token not configured', async function () {
        const randomAddress = ethers.Wallet.createRandom().address

        await expect(
          oracleRouter.getPricesAndDecimals(randomAddress, contracts.LDO, QuoteDenomination.USD)
        )
          .to.be.revertedWithCustomError(oracleRouter, 'TokenNotConfigured')
          .withArgs(randomAddress)
      })

      it('should revert if quote token not configured', async function () {
        const randomAddress = ethers.Wallet.createRandom().address

        await expect(
          oracleRouter.getPricesAndDecimals(contracts.STETH, randomAddress, QuoteDenomination.ETH)
        )
          .to.be.revertedWithCustomError(oracleRouter, 'TokenNotConfigured')
          .withArgs(randomAddress)
      })

      it('should revert if base token inactive', async function () {
        const agent = await getAgentSigner()

        // Deactivate stETH
        await oracleRouter.connect(agent).setTokenActive(contracts.STETH, false)

        await expect(
          oracleRouter.getPricesAndDecimals(contracts.STETH, contracts.LDO, QuoteDenomination.ETH)
        )
          .to.be.revertedWithCustomError(oracleRouter, 'TokenNotConfigured')
          .withArgs(contracts.STETH)
      })

      it('should revert if quote token inactive', async function () {
        const agent = await getAgentSigner()

        // Deactivate LDO
        await oracleRouter.connect(agent).setTokenActive(contracts.LDO, false)

        await expect(
          oracleRouter.getPricesAndDecimals(contracts.STETH, contracts.LDO, QuoteDenomination.ETH)
        )
          .to.be.revertedWithCustomError(oracleRouter, 'TokenNotConfigured')
          .withArgs(contracts.LDO)
      })
    })

    describe('Bridging - Mixed Denominations (ETH Quote)', function () {
      beforeEach(async function () {
        const agent = await getAgentSigner()
        const currentTimestamp = await getCurrentTimestamp()

        // Ensure ETH/USD bridge is configured
        await oracleRouter.connect(agent).setEthUsdBridge(86400)

        // Configure USD-quoted tokens
        await oracleRouter
          .connect(agent)
          .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, true)
        await oracleRouter
          .connect(agent)
          .setTokenFeed(contracts.USDC, QuoteDenomination.USD, 86400, true)

        // Update feeds to be fresh
        await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
          updatedAt: currentTimestamp,
        })
        await updateTokenFeed(feedConfig, contracts.USDC, contracts.CHAINLINK_USD_QUOTE, {
          updatedAt: currentTimestamp,
        })
        await updateTokenFeed(
          feedConfig,
          contracts.CHAINLINK_ETH_QUOTE,
          contracts.CHAINLINK_USD_QUOTE,
          {
            updatedAt: currentTimestamp,
          }
        )
      })

      it('should bridge USD-quoted base token to ETH when requesting ETH quote', async function () {
        const [daiPrice, stethPrice, daiDecimals, stethDecimals] =
          await oracleRouter.getPricesAndDecimals(
            contracts.DAI,
            contracts.STETH,
            QuoteDenomination.ETH
          )

        expect(daiDecimals).to.equal(18)
        expect(stethDecimals).to.equal(18)

        const expectedDai = await getExpectedEthBridgePrice(oracleRouter, contracts.DAI)
        const expectedSteth = await getExpectedPriceForQuote(
          oracleRouter,
          contracts.STETH,
          QuoteDenomination.ETH
        )
        expect(daiPrice).to.equal(expectedDai)
        expect(stethPrice).to.equal(expectedSteth)
      })

      it('should bridge USD-quoted quote token to ETH when requesting ETH quote', async function () {
        const [stethPrice, daiPrice, stethDecimals, daiDecimals] =
          await oracleRouter.getPricesAndDecimals(
            contracts.STETH,
            contracts.DAI,
            QuoteDenomination.ETH
          )

        expect(stethDecimals).to.equal(18)
        expect(daiDecimals).to.equal(18)

        const expectedSteth = await getExpectedPriceForQuote(
          oracleRouter,
          contracts.STETH,
          QuoteDenomination.ETH
        )
        const expectedDai = await getExpectedEthBridgePrice(oracleRouter, contracts.DAI)
        expect(stethPrice).to.equal(expectedSteth)
        expect(daiPrice).to.equal(expectedDai)
      })

      it('should bridge both tokens when both are USD-quoted and requesting ETH', async function () {
        const [daiPrice, usdcPrice, daiDecimals, usdcDecimals] =
          await oracleRouter.getPricesAndDecimals(
            contracts.DAI,
            contracts.USDC,
            QuoteDenomination.ETH
          )

        expect(daiDecimals).to.equal(18)
        expect(usdcDecimals).to.equal(6)

        const [expectedDai, expectedUsdc] = await getExpectedPricesForPair(
          oracleRouter,
          contracts.DAI,
          contracts.USDC,
          QuoteDenomination.ETH
        )
        expect(daiPrice).to.equal(expectedDai)
        expect(usdcPrice).to.equal(expectedUsdc)
      })

      it('should revert if ETH/USD bridge is not configured when bridging is needed', async function () {
        const agent = await getAgentSigner()
        // Deploy a fresh router without bridge configured
        const freshRouter = await oracleRouterFactory.deploy(agentAddress, 18, feedRegistryAddress)
        await freshRouter.waitForDeployment()

        await freshRouter
          .connect(agent)
          .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, true)
        await freshRouter
          .connect(agent)
          .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86400, true)

        // Should revert when trying to bridge without ETH/USD bridge configured
        await expect(
          freshRouter.getPricesAndDecimals(contracts.DAI, contracts.STETH, QuoteDenomination.ETH)
        ).to.be.revertedWithCustomError(freshRouter, 'EthUsdBridgeMissing')
      })
    })

    describe('Staleness checks', function () {
      it('should revert if base token feed is stale', async function () {
        // Advance time beyond staleness threshold
        const maxStaleness = 86400 + 3600 // 25 hours
        await ethers.provider.send('evm_increaseTime', [maxStaleness])
        await ethers.provider.send('evm_mine', [])

        await expect(
          oracleRouter.getPricesAndDecimals(contracts.STETH, contracts.LDO, QuoteDenomination.ETH)
        ).to.be.revertedWithCustomError(oracleRouter, 'OracleStale')
      })

      it('should revert if quote token feed is stale', async function () {
        // Advance time beyond staleness threshold
        const maxStaleness = 86400 + 3600 // 25 hours
        await ethers.provider.send('evm_increaseTime', [maxStaleness])
        await ethers.provider.send('evm_mine', [])

        await expect(
          oracleRouter.getPricesAndDecimals(contracts.STETH, contracts.LDO, QuoteDenomination.ETH)
        ).to.be.revertedWithCustomError(oracleRouter, 'OracleStale')
      })
    })

    describe('Edge cases', function () {
      it('should work without ETH/USD bridge configured (does not need bridge)', async function () {
        // getPricesAndDecimals should not require ETH/USD bridge since it reads ETH prices directly
        const agent = await getAgentSigner()

        // Deploy a fresh router without bridge
        const freshRouter = await oracleRouterFactory.deploy(agentAddress, 18, feedRegistryAddress)
        await freshRouter.waitForDeployment()

        // Configure only ETH-quoted tokens (no bridge)
        await freshRouter
          .connect(agent)
          .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86400, true)
        await freshRouter
          .connect(agent)
          .setTokenFeed(contracts.LDO, QuoteDenomination.ETH, 86400, true)

        // Should work without bridge
        const result = await freshRouter.getPricesAndDecimals(
          contracts.STETH,
          contracts.LDO,
          QuoteDenomination.ETH
        )
        const [expectedSteth, expectedLdo] = await getExpectedPricesForPair(
          freshRouter,
          contracts.STETH,
          contracts.LDO,
          QuoteDenomination.ETH
        )
        expect(result.basePrice).to.equal(expectedSteth)
        expect(result.quotePrice).to.equal(expectedLdo)
      })

      it('should work with tokens that have different decimals', async function () {
        const agent = await getAgentSigner()

        // Configure STETH as USD-quoted for this test
        await oracleRouter
          .connect(agent)
          .setTokenFeed(contracts.STETH, QuoteDenomination.USD, 86400, true)

        // Configure a token with 6 decimals
        await oracleRouter
          .connect(agent)
          .setTokenFeed(contracts.USDC, QuoteDenomination.USD, 86400, true)

        // Should handle the decimal difference - use USD since both are USD-quoted
        const result = await oracleRouter.getPricesAndDecimals(
          contracts.STETH,
          contracts.USDC,
          QuoteDenomination.USD
        )
        expect(result.baseTokenDecimals).to.equal(18)
        expect(result.quoteTokenDecimals).to.equal(6)
        const [expectedSteth, expectedUsdc] = await getExpectedPricesForPair(
          oracleRouter,
          contracts.STETH,
          contracts.USDC,
          QuoteDenomination.USD
        )
        expect(result.basePrice).to.equal(expectedSteth)
        expect(result.quotePrice).to.equal(expectedUsdc)
      })
    })
  })

  describe('Edge Cases', function () {
    it('should handle maximum valid staleness value', async function () {
      const agent = await getAgentSigner()
      const maxStaleness = 2n ** 32n - 1n

      await expect(
        oracleRouter
          .connect(agent)
          .setTokenFeed(contracts.USDT, QuoteDenomination.USD, maxStaleness, true)
      ).to.not.be.reverted
    })
  })

  describe('Bridge Cache Edge Cases', function () {
    beforeEach(async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setEthUsdBridge(86_400)
    })

    it('should fetch bridge twice when tokens have different staleness caps', async function () {
      const agentSigner = await getAgentSigner()

      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86_400, true)
      await oracleRouter
        .connect(agentSigner)
        .setTokenEthUsdStalenessOverride(contracts.STETH, 3_600)

      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.LDO, QuoteDenomination.ETH, 86_400, true)
      const [stethPrice, ldoPrice] = await oracleRouter.getUsdPrices(contracts.STETH, contracts.LDO)

      const expectedSteth = await getExpectedUsdBridgePrice(oracleRouter, contracts.STETH)
      const expectedLdo = await getExpectedUsdBridgePrice(oracleRouter, contracts.LDO)

      expect(stethPrice).to.equal(expectedSteth)
      expect(ldoPrice).to.equal(expectedLdo)
    })

    it('should use bridge cache when both tokens have same staleness cap', async function () {
      const agentSigner = await getAgentSigner()

      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86_400, true)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.LDO, QuoteDenomination.ETH, 86_400, true)

      await oracleRouter
        .connect(agentSigner)
        .setTokenEthUsdStalenessOverride(contracts.STETH, 3_600)
      await oracleRouter.connect(agentSigner).setTokenEthUsdStalenessOverride(contracts.LDO, 3_600)
      const [stethPrice, ldoPrice] = await oracleRouter.getUsdPrices(contracts.STETH, contracts.LDO)

      const expectedSteth = await getExpectedUsdBridgePrice(oracleRouter, contracts.STETH)
      const expectedLdo = await getExpectedUsdBridgePrice(oracleRouter, contracts.LDO)

      expect(stethPrice).to.equal(expectedSteth)
      expect(ldoPrice).to.equal(expectedLdo)
    })

    it('should handle bridge cache invalidation when override changes', async function () {
      const agentSigner = await getAgentSigner()

      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86_400, true)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.LDO, QuoteDenomination.ETH, 86_400, true)

      await oracleRouter
        .connect(agentSigner)
        .setTokenEthUsdStalenessOverride(contracts.STETH, 3_600)
      await oracleRouter.connect(agentSigner).setTokenEthUsdStalenessOverride(contracts.LDO, 3_600)

      const [price1, price2] = await oracleRouter.getUsdPrices(contracts.STETH, contracts.LDO)

      await oracleRouter
        .connect(agentSigner)
        .setTokenEthUsdStalenessOverride(contracts.STETH, 7_200)

      const [price3, price4] = await oracleRouter.getUsdPrices(contracts.STETH, contracts.LDO)
      const expectedStethNew = await getExpectedUsdBridgePrice(oracleRouter, contracts.STETH)
      expect(price3).to.equal(expectedStethNew)
    })
  })

  describe('Price Consistency Invariants', function () {
    beforeEach(async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setEthUsdBridge(86_400)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.USDC, QuoteDenomination.USD, 86_400, true)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86_400, true)
    })

    it('should return same price ratio for same token pair in same block', async function () {
      const [price1, price2] = await oracleRouter.getUsdPrices(contracts.DAI, contracts.USDC)
      const [price3, price4] = await oracleRouter.getUsdPrices(contracts.DAI, contracts.USDC)

      const ratio1 = calculatePriceRatio(price1, price2)
      const ratio2 = calculatePriceRatio(price3, price4)

      expect(ratio1).to.equal(ratio2)
    })

    it('should maintain price ratio symmetry: (A/B) * (B/A) = 1', async function () {
      const [daiPrice1, usdcPrice1] = await oracleRouter.getUsdPrices(contracts.DAI, contracts.USDC)
      const [usdcPrice2, daiPrice2] = await oracleRouter.getUsdPrices(contracts.USDC, contracts.DAI)

      expect(daiPrice1).to.equal(daiPrice2)
      expect(usdcPrice1).to.equal(usdcPrice2)

      const crossProduct1 = daiPrice1 * usdcPrice2
      const crossProduct2 = usdcPrice1 * daiPrice2

      expect(crossProduct1).to.equal(crossProduct2)
    })

    it('should return consistent bridge price across multiple queries', async function () {
      const [steth1, dai1] = await oracleRouter.getUsdPrices(contracts.STETH, contracts.DAI)
      const [steth2, dai2] = await oracleRouter.getUsdPrices(contracts.STETH, contracts.DAI)
      const [steth3, dai3] = await oracleRouter.getUsdPrices(contracts.STETH, contracts.DAI)

      expect(steth1).to.equal(steth2)
      expect(steth2).to.equal(steth3)
      expect(dai1).to.equal(dai2)
      expect(dai2).to.equal(dai3)
    })

    it('should return consistent prices for getPricesAndDecimals across calls', async function () {
      const [base1, quote1, dec1, dec2] = await oracleRouter.getPricesAndDecimals(
        contracts.DAI,
        contracts.USDC,
        QuoteDenomination.USD
      )
      const [base2, quote2, dec3, dec4] = await oracleRouter.getPricesAndDecimals(
        contracts.DAI,
        contracts.USDC,
        QuoteDenomination.USD
      )

      expect(base1).to.equal(base2)
      expect(quote1).to.equal(quote2)
      expect(dec1).to.equal(dec3)
      expect(dec2).to.equal(dec4)
    })
  })

  describe('Error Propagation', function () {
    beforeEach(async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setEthUsdBridge(86_400)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.USDC, QuoteDenomination.USD, 86_400, true)
    })

    it('should revert with base token error when base is stale and quote is fresh', async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 1, true)

      const currentTimestamp = await getCurrentTimestamp()
      const staleTimestamp = currentTimestamp - 2n

      await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        updatedAt: staleTimestamp,
      })

      await updateTokenFeed(feedConfig, contracts.USDC, contracts.CHAINLINK_USD_QUOTE, {
        updatedAt: currentTimestamp,
      })

      await expect(oracleRouter.getUsdPrices(contracts.DAI, contracts.USDC))
        .to.be.revertedWithCustomError(oracleRouter, 'OracleStale')
        .withArgs(anyValue, staleTimestamp)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)
    })

    it('should revert with quote token error when quote is stale and base is fresh', async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.USDC, QuoteDenomination.USD, 1, true)

      const currentTimestamp = await getCurrentTimestamp()
      const staleTimestamp = currentTimestamp - 2n

      await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        updatedAt: currentTimestamp,
      })

      await updateTokenFeed(feedConfig, contracts.USDC, contracts.CHAINLINK_USD_QUOTE, {
        updatedAt: staleTimestamp,
      })

      await expect(oracleRouter.getUsdPrices(contracts.DAI, contracts.USDC))
        .to.be.revertedWithCustomError(oracleRouter, 'OracleStale')
        .withArgs(anyValue, staleTimestamp)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.USDC, QuoteDenomination.USD, 86_400, true)
    })

    it('should revert with bridge error when bridge is stale during bridging', async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86_400, true)

      const currentTimestamp = await getCurrentTimestamp()
      const staleTimestamp = currentTimestamp - 86_401n

      await updateTokenFeed(
        feedConfig,
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE,
        {
          updatedAt: staleTimestamp,
        }
      )

      await expect(oracleRouter.getUsdPrices(contracts.STETH, contracts.DAI))
        .to.be.revertedWithCustomError(oracleRouter, 'OracleStale')
        .withArgs(anyValue, staleTimestamp)
    })

    it('should include correct aggregator address in error', async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 1, true)

      const feedRegistry = await ethers.getContractAt(
        'ChainlinkFeedRegistryStub',
        feedRegistryAddress
      )
      const feed = await feedRegistry.feeds(contracts.DAI, contracts.CHAINLINK_USD_QUOTE)
      const aggregatorAddress = feed.aggregator

      const currentTimestamp = await getCurrentTimestamp()
      const staleTimestamp = currentTimestamp - 2n

      await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        updatedAt: staleTimestamp,
      })

      await expect(oracleRouter.getUsdPrices(contracts.DAI, contracts.USDC))
        .to.be.revertedWithCustomError(oracleRouter, 'OracleStale')
        .withArgs(aggregatorAddress, staleTimestamp)
    })
  })

  describe('Extreme Values', function () {
    beforeEach(async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setEthUsdBridge(86_400)
    })

    it('should handle maximum valid price value without overflow', async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)

      const currentTimestamp = await getCurrentTimestamp()
      const decimals = await getRouterPriceDecimals(oracleRouter)
      const feedDecimals = 8n

      const maxUint256 = 2n ** 256n - 1n
      const scaleFactor = 10n ** (decimals - feedDecimals)
      const maxValidPrice = maxUint256 / scaleFactor
      const maxInt256 = 2n ** 255n - 1n
      const maxPrice = maxValidPrice > maxInt256 ? maxInt256 : maxValidPrice

      await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        answer: maxPrice,
        updatedAt: currentTimestamp,
        roundId: 1n,
        answeredInRound: 1n,
      })

      const [price] = await oracleRouter.getUsdPrices(contracts.DAI, contracts.DAI)

      const expectedPrice = maxPrice * scaleFactor
      expect(price).to.equal(expectedPrice)
    })

    it('should revert with Math: mulDiv overflow when price causes overflow during normalization', async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)

      const currentTimestamp = await getCurrentTimestamp()
      const decimals = await getRouterPriceDecimals(oracleRouter)
      const feedDecimals = 8n

      const maxUint256 = 2n ** 256n - 1n
      const scaleFactor = 10n ** (decimals - feedDecimals)
      const maxValidPrice = maxUint256 / scaleFactor
      const overflowPrice = maxValidPrice + 1n

      await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        answer: overflowPrice,
        updatedAt: currentTimestamp,
        roundId: 1n,
        answeredInRound: 1n,
      })

      await expect(oracleRouter.getUsdPrices(contracts.DAI, contracts.DAI)).to.be.revertedWith(
        'Math: mulDiv overflow'
      )
    })

    it('should handle minimum non-zero price (1 wei)', async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)

      const currentTimestamp = await getCurrentTimestamp()
      const minPrice = 1n

      await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        answer: minPrice,
        updatedAt: currentTimestamp,
        roundId: 1n,
        answeredInRound: 1n,
        decimals: 8,
      })

      const [price] = await oracleRouter.getUsdPrices(contracts.DAI, contracts.DAI)

      const decimals = await getRouterPriceDecimals(oracleRouter)
      if (decimals > 8n) {
        const expectedPrice = minPrice * 10n ** (decimals - 8n)
        expect(price).to.equal(expectedPrice)
      } else {
        // If decimals <= 8, might quantize to zero
        expect(price).to.be.gte(0n)
      }
    })

    it('should handle price that normalizes to exactly PRICE_UNIT', async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)

      const priceDecimals = await getRouterPriceDecimals(oracleRouter)
      const feedDecimals = 8n
      const priceValue = priceDecimals > feedDecimals ? 10n ** feedDecimals : priceDecimals

      const currentTimestamp = await getCurrentTimestamp()

      await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        answer: priceValue,
        updatedAt: currentTimestamp,
        roundId: 1n,
        answeredInRound: 1n,
        decimals: Number(feedDecimals),
      })

      const [price] = await oracleRouter.getUsdPrices(contracts.DAI, contracts.DAI)
      const expectedPrice = await getExpectedUsdPrice(oracleRouter, contracts.DAI)

      expect(price).to.equal(expectedPrice)
    })

    it('should handle maximum staleness value (type(uint32).max)', async function () {
      const agentSigner = await getAgentSigner()
      const maxStaleness = 2n ** 32n - 1n

      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, maxStaleness, true)

      const veryOldTimestamp = 1n
      await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        updatedAt: veryOldTimestamp,
        roundId: 1n,
        answeredInRound: 1n,
      })

      const [price] = await oracleRouter.getUsdPrices(contracts.DAI, contracts.DAI)
      expect(price).to.be.gte(0n)
    })

    it('should handle override staleness greater than global staleness', async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setEthUsdBridge(86_400)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86_400, true)

      await oracleRouter
        .connect(agentSigner)
        .setTokenEthUsdStalenessOverride(contracts.STETH, 100_000)

      const currentTimestamp = await getCurrentTimestamp()
      const oldTimestamp = currentTimestamp - 90_000n

      await updateTokenFeed(
        feedConfig,
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE,
        {
          updatedAt: oldTimestamp,
          roundId: 1n,
          answeredInRound: 1n,
        }
      )

      await expect(
        oracleRouter.getUsdPrices(contracts.STETH, contracts.DAI)
      ).to.be.revertedWithCustomError(oracleRouter, 'OracleStale')
    })
  })

  describe('Timestamp Edge Cases', function () {
    beforeEach(async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.USDC, QuoteDenomination.USD, 86_400, true)
    })

    it('should revert with OracleStale when feed has updatedAt = 0', async function () {
      const agentSigner = await getAgentSigner()
      const feedRegistry = await ethers.getContractAt(
        'ChainlinkFeedRegistryStub',
        feedRegistryAddress
      )
      const feed = await feedRegistry.feeds(contracts.DAI, contracts.CHAINLINK_USD_QUOTE)

      const currentFeed = await feedRegistry.feeds(contracts.DAI, contracts.CHAINLINK_USD_QUOTE)
      const validAnswer = currentFeed.answer > 0n ? currentFeed.answer : 100000000n

      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 1, true)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.USDC, QuoteDenomination.USD, 1, true)

      const currentTimestamp = await getCurrentTimestamp()
      const staleTimestamp = 1n

      await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        answer: validAnswer,
        updatedAt: staleTimestamp,
        roundId: 1n,
        answeredInRound: 1n,
      })

      await updateTokenFeed(feedConfig, contracts.USDC, contracts.CHAINLINK_USD_QUOTE, {
        answer: validAnswer,
        updatedAt: staleTimestamp,
        roundId: 1n,
        answeredInRound: 1n,
      })

      if (currentTimestamp <= 2n) {
        await ethers.provider.send('evm_increaseTime', [2])
        await ethers.provider.send('evm_mine', [])
      }

      const finalTimestamp = await getCurrentTimestamp()
      expect(finalTimestamp).to.be.gt(2n)

      await expect(oracleRouter.getUsdPrices(contracts.DAI, contracts.USDC))
        .to.be.revertedWithCustomError(oracleRouter, 'OracleStale')
        .withArgs(feed.aggregator, staleTimestamp)
    })

    it('should accept feed with updatedAt = block.timestamp', async function () {
      const currentTimestamp = await getCurrentTimestamp()

      await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        updatedAt: currentTimestamp,
        roundId: 1n,
        answeredInRound: 1n,
      })

      const [price] = await oracleRouter.getUsdPrices(contracts.DAI, contracts.USDC)
      const expectedPrice = await getExpectedUsdPrice(oracleRouter, contracts.DAI)
      expect(price).to.equal(expectedPrice)
    })

    it('should revert with OracleStale when feed has updatedAt in the past beyond staleness cap', async function () {
      const currentTimestamp = await getCurrentTimestamp()
      const staleTimestamp = currentTimestamp - 86_401n

      await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        updatedAt: staleTimestamp,
        roundId: 1n,
        answeredInRound: 1n,
      })

      await expect(oracleRouter.getUsdPrices(contracts.DAI, contracts.USDC))
        .to.be.revertedWithCustomError(oracleRouter, 'OracleStale')
        .withArgs(anyValue, staleTimestamp)
    })

    it('should revert with panic when feed has updatedAt in the future due to underflow', async function () {
      const currentTimestamp = await getCurrentTimestamp()
      const futureTimestamp = currentTimestamp + 3600n

      await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        updatedAt: futureTimestamp,
        roundId: 1n,
        answeredInRound: 1n,
      })

      await expect(
        oracleRouter.getUsdPrices(contracts.DAI, contracts.USDC)
      ).to.be.revertedWithPanic(0x11)
    })
  })

  describe('Decimal Validation', function () {
    it('should revert with InvalidTokenDecimals when token decimals exceed MAX_DECIMALS', async function () {
      const agentSigner = await getAgentSigner()
      const maxDecimals = await oracleRouter.MAX_DECIMALS()

      const mockTokenFactory = await ethers.getContractFactory('ERC_20')
      const mockToken = await mockTokenFactory.deploy()
      await mockToken.waitForDeployment()

      const feedRegistry = await ethers.getContractAt(
        'ChainlinkFeedRegistryStub',
        feedRegistryAddress
      )

      await feedRegistry.setFeed(await mockToken.getAddress(), contracts.CHAINLINK_USD_QUOTE, {
        aggregator: await feedRegistry.getAddress(),
        answer: 100000000n,
        updatedAt: await getCurrentTimestamp(),
        startedAt: await getCurrentTimestamp(),
        answeredInRound: 1n,
        roundId: 1n,
        decimals: 8,
      })

      const tokenDecimals = await mockToken.decimals()
      if (tokenDecimals > maxDecimals) {
        await expect(
          oracleRouter
            .connect(agentSigner)
            .setTokenFeed(await mockToken.getAddress(), QuoteDenomination.USD, 86_400, true)
        ).to.be.revertedWithCustomError(oracleRouter, 'InvalidTokenDecimals')
      } else {
        await oracleRouter
          .connect(agentSigner)
          .setTokenFeed(await mockToken.getAddress(), QuoteDenomination.USD, 86_400, true)
        const config = await oracleRouter.tokenConfig(await mockToken.getAddress())
        expect(config.tokenDecimals).to.equal(tokenDecimals)
      }
    })
  })

  after(async function () {
    await snapshot.restore()
    resetTestFeedRegistryStub()
  })
})
