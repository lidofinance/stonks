import { ethers } from 'hardhat'
import { expect } from 'chai'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import {
  OracleRouter,
  OracleRouter__factory,
  ChainlinkFeedRegistryStub,
} from '../../typechain-types'
import { QuoteDenomination } from '../../utils/oracle-router'
import {
  getTestFeedRegistryStub,
  getAllTestTokens,
  updateTokenFeed,
  resetTestFeedRegistryStub,
  refreshFeedData,
} from '../../utils/test-feed-registry'
import { getContracts } from '../../utils/contracts'

const contracts = getContracts()

// Helper function to calculate normalized price from feed data
function calculateNormalizedPrice(
  rawAnswer: bigint,
  feedDecimals: number,
  priceDecimals: number
): bigint {
  if (feedDecimals === priceDecimals) {
    return rawAnswer
  }
  if (feedDecimals < priceDecimals) {
    const upDiff = priceDecimals - feedDecimals
    return rawAnswer * 10n ** BigInt(upDiff)
  } else {
    const downDiff = feedDecimals - priceDecimals
    return rawAnswer / 10n ** BigInt(downDiff)
  }
}

// Helper function to get expected price in requested quote
async function getExpectedPriceInQuote(
  feedRegistry: ChainlinkFeedRegistryStub,
  token: string,
  tokenPrimaryQuote: (typeof QuoteDenomination)[keyof typeof QuoteDenomination],
  requestedQuote: (typeof QuoteDenomination)[keyof typeof QuoteDenomination],
  priceDecimals: number,
  ethUsdPrice: bigint
): Promise<bigint> {
  const PRICE_UNIT = 10n ** BigInt(priceDecimals)

  // If primary quote matches requested quote, return direct price
  if (tokenPrimaryQuote === requestedQuote) {
    const quoteAddress =
      requestedQuote === QuoteDenomination.USD
        ? contracts.CHAINLINK_USD_QUOTE
        : contracts.CHAINLINK_ETH_QUOTE
    const feed = await feedRegistry.feeds(token, quoteAddress)
    const rawAnswer = BigInt(feed.answer)
    const feedDecimals = Number(feed.decimals)
    return calculateNormalizedPrice(rawAnswer, feedDecimals, priceDecimals)
  }

  // Need to bridge
  const primaryQuoteAddress =
    tokenPrimaryQuote === QuoteDenomination.USD
      ? contracts.CHAINLINK_USD_QUOTE
      : contracts.CHAINLINK_ETH_QUOTE
  const feed = await feedRegistry.feeds(token, primaryQuoteAddress)
  const rawAnswer = BigInt(feed.answer)
  const feedDecimals = Number(feed.decimals)
  const tokenInPrimaryQuote = calculateNormalizedPrice(rawAnswer, feedDecimals, priceDecimals)

  // Bridge through ETH/USD
  if (requestedQuote === QuoteDenomination.USD) {
    // Token is ETH-quoted, need USD: token/ETH * ETH/USD / PRICE_UNIT
    return (tokenInPrimaryQuote * ethUsdPrice) / PRICE_UNIT
  } else {
    // Token is USD-quoted, need ETH: token/USD * PRICE_UNIT / ETH/USD
    return (tokenInPrimaryQuote * PRICE_UNIT) / ethUsdPrice
  }
}

describe('OracleRouter - Bridging Tests', function () {
  let oracleRouter: OracleRouter
  let oracleRouterFactory: OracleRouter__factory
  let snapshot: SnapshotRestorer
  let adminAddress: string
  let feedRegistryAddress: string
  let feedRegistry: ChainlinkFeedRegistryStub

  const feedConfig = {
    tokens: getAllTestTokens(),
    useRealPrices: true,
  }
  const PRICE_DECIMALS = 18

  const getCurrentTimestamp = async () => {
    const block = await ethers.provider.getBlock('latest')
    return BigInt(block!.timestamp)
  }

  const getAdminSigner = async () => {
    const adminSigner = await ethers.getImpersonatedSigner(adminAddress)
    await ethers.provider.send('hardhat_setBalance', [adminAddress, '0x1000000000000000000'])
    return adminSigner
  }

  before(async function () {
    snapshot = await takeSnapshot()
    oracleRouterFactory = await ethers.getContractFactory('OracleRouter')
    adminAddress = contracts.ADMIN
    feedRegistry = await getTestFeedRegistryStub(feedConfig)
    feedRegistryAddress = await feedRegistry.getAddress()
  })

  beforeEach(async function () {
    await refreshFeedData(feedConfig)
    oracleRouter = await oracleRouterFactory.deploy(adminAddress, 18, feedRegistryAddress)
    await oracleRouter.waitForDeployment()

    const admin = await getAdminSigner()
    const currentTimestamp = await getCurrentTimestamp()

    // Always configure ETH/USD bridge
    await oracleRouter.connect(admin).setEthUsdBridge(86400)

    // Configure tokens with mixed denominations
    await oracleRouter
      .connect(admin)
      .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, true)
    await oracleRouter
      .connect(admin)
      .setTokenFeed(contracts.USDC, QuoteDenomination.USD, 86400, true)
    await oracleRouter
      .connect(admin)
      .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86400, true)
    await oracleRouter
      .connect(admin)
      .setTokenFeed(contracts.LDO, QuoteDenomination.ETH, 86400, true)

    // Update all feeds to be fresh
    await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
      updatedAt: currentTimestamp,
    })
    await updateTokenFeed(feedConfig, contracts.USDC, contracts.CHAINLINK_USD_QUOTE, {
      updatedAt: currentTimestamp,
    })
    await updateTokenFeed(feedConfig, contracts.STETH, contracts.CHAINLINK_ETH_QUOTE, {
      updatedAt: currentTimestamp,
    })
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

  after(async function () {
    await snapshot.restore()
    resetTestFeedRegistryStub()
  })

  describe('USD Quote - Bridging Scenarios', function () {
    it('should bridge ETH-quoted base token (stETH) to USD', async function () {
      // Get ETH/USD price for bridging
      const ethUsdFeed = await feedRegistry.feeds(
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE
      )
      const ethUsdRawAnswer = BigInt(ethUsdFeed.answer)
      const ethUsdFeedDecimals = Number(ethUsdFeed.decimals)
      const ethUsdPrice = calculateNormalizedPrice(
        ethUsdRawAnswer,
        ethUsdFeedDecimals,
        PRICE_DECIMALS
      )

      // Calculate expected prices
      const expectedStethPrice = await getExpectedPriceInQuote(
        feedRegistry,
        contracts.STETH,
        QuoteDenomination.ETH,
        QuoteDenomination.USD,
        PRICE_DECIMALS,
        ethUsdPrice
      )
      const expectedDaiPrice = await getExpectedPriceInQuote(
        feedRegistry,
        contracts.DAI,
        QuoteDenomination.USD,
        QuoteDenomination.USD,
        PRICE_DECIMALS,
        ethUsdPrice
      )

      const [stethPrice, daiPrice, stethDecimals, daiDecimals] =
        await oracleRouter.getPricesAndDecimals(
          contracts.STETH,
          contracts.DAI,
          QuoteDenomination.USD
        )

      expect(stethPrice).to.equal(expectedStethPrice)
      expect(daiPrice).to.equal(expectedDaiPrice)
      expect(stethDecimals).to.equal(18)
      expect(daiDecimals).to.equal(18)
    })

    it('should bridge ETH-quoted quote token (LDO) to USD', async function () {
      // Get ETH/USD price for bridging
      const ethUsdFeed = await feedRegistry.feeds(
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE
      )
      const ethUsdRawAnswer = BigInt(ethUsdFeed.answer)
      const ethUsdFeedDecimals = Number(ethUsdFeed.decimals)
      const ethUsdPrice = calculateNormalizedPrice(
        ethUsdRawAnswer,
        ethUsdFeedDecimals,
        PRICE_DECIMALS
      )

      // Calculate expected prices
      const expectedDaiPrice = await getExpectedPriceInQuote(
        feedRegistry,
        contracts.DAI,
        QuoteDenomination.USD,
        QuoteDenomination.USD,
        PRICE_DECIMALS,
        ethUsdPrice
      )
      const expectedLdoPrice = await getExpectedPriceInQuote(
        feedRegistry,
        contracts.LDO,
        QuoteDenomination.ETH,
        QuoteDenomination.USD,
        PRICE_DECIMALS,
        ethUsdPrice
      )

      const [daiPrice, ldoPrice, daiDecimals, ldoDecimals] =
        await oracleRouter.getPricesAndDecimals(contracts.DAI, contracts.LDO, QuoteDenomination.USD)

      expect(daiPrice).to.equal(expectedDaiPrice)
      expect(ldoPrice).to.equal(expectedLdoPrice)
      expect(daiDecimals).to.equal(18)
      expect(ldoDecimals).to.equal(18)
    })

    it('should bridge both tokens when both are ETH-quoted', async function () {
      // Get ETH/USD price for bridging
      const ethUsdFeed = await feedRegistry.feeds(
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE
      )
      const ethUsdRawAnswer = BigInt(ethUsdFeed.answer)
      const ethUsdFeedDecimals = Number(ethUsdFeed.decimals)
      const ethUsdPrice = calculateNormalizedPrice(
        ethUsdRawAnswer,
        ethUsdFeedDecimals,
        PRICE_DECIMALS
      )

      // Calculate expected prices
      const expectedStethPrice = await getExpectedPriceInQuote(
        feedRegistry,
        contracts.STETH,
        QuoteDenomination.ETH,
        QuoteDenomination.USD,
        PRICE_DECIMALS,
        ethUsdPrice
      )
      const expectedLdoPrice = await getExpectedPriceInQuote(
        feedRegistry,
        contracts.LDO,
        QuoteDenomination.ETH,
        QuoteDenomination.USD,
        PRICE_DECIMALS,
        ethUsdPrice
      )

      const [stethPrice, ldoPrice, stethDecimals, ldoDecimals] =
        await oracleRouter.getPricesAndDecimals(
          contracts.STETH,
          contracts.LDO,
          QuoteDenomination.USD
        )

      expect(stethPrice).to.equal(expectedStethPrice)
      expect(ldoPrice).to.equal(expectedLdoPrice)
      expect(stethDecimals).to.equal(18)
      expect(ldoDecimals).to.equal(18)
    })

    it('should use direct prices when both tokens are USD-quoted', async function () {
      // Get ETH/USD price (not needed for direct prices, but required for helper)
      const ethUsdFeed = await feedRegistry.feeds(
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE
      )
      const ethUsdRawAnswer = BigInt(ethUsdFeed.answer)
      const ethUsdFeedDecimals = Number(ethUsdFeed.decimals)
      const ethUsdPrice = calculateNormalizedPrice(
        ethUsdRawAnswer,
        ethUsdFeedDecimals,
        PRICE_DECIMALS
      )

      // Calculate expected prices
      const expectedDaiPrice = await getExpectedPriceInQuote(
        feedRegistry,
        contracts.DAI,
        QuoteDenomination.USD,
        QuoteDenomination.USD,
        PRICE_DECIMALS,
        ethUsdPrice
      )
      const expectedUsdcPrice = await getExpectedPriceInQuote(
        feedRegistry,
        contracts.USDC,
        QuoteDenomination.USD,
        QuoteDenomination.USD,
        PRICE_DECIMALS,
        ethUsdPrice
      )

      const [daiPrice, usdcPrice, daiDecimals, usdcDecimals] =
        await oracleRouter.getPricesAndDecimals(
          contracts.DAI,
          contracts.USDC,
          QuoteDenomination.USD
        )

      expect(daiPrice).to.equal(expectedDaiPrice)
      expect(usdcPrice).to.equal(expectedUsdcPrice)
      expect(daiDecimals).to.equal(18)
      expect(usdcDecimals).to.equal(6)
    })
  })

  describe('ETH Quote - Bridging Scenarios', function () {
    it('should bridge USD-quoted base token (DAI) to ETH', async function () {
      // Get ETH/USD price for bridging
      const ethUsdFeed = await feedRegistry.feeds(
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE
      )
      const ethUsdRawAnswer = BigInt(ethUsdFeed.answer)
      const ethUsdFeedDecimals = Number(ethUsdFeed.decimals)
      const ethUsdPrice = calculateNormalizedPrice(
        ethUsdRawAnswer,
        ethUsdFeedDecimals,
        PRICE_DECIMALS
      )

      // Calculate expected prices
      const expectedDaiPrice = await getExpectedPriceInQuote(
        feedRegistry,
        contracts.DAI,
        QuoteDenomination.USD,
        QuoteDenomination.ETH,
        PRICE_DECIMALS,
        ethUsdPrice
      )
      const expectedStethPrice = await getExpectedPriceInQuote(
        feedRegistry,
        contracts.STETH,
        QuoteDenomination.ETH,
        QuoteDenomination.ETH,
        PRICE_DECIMALS,
        ethUsdPrice
      )

      const [daiPrice, stethPrice, daiDecimals, stethDecimals] =
        await oracleRouter.getPricesAndDecimals(
          contracts.DAI,
          contracts.STETH,
          QuoteDenomination.ETH
        )

      expect(daiPrice).to.equal(expectedDaiPrice)
      expect(stethPrice).to.equal(expectedStethPrice)
      expect(daiDecimals).to.equal(18)
      expect(stethDecimals).to.equal(18)
    })

    it('should bridge USD-quoted quote token (USDC) to ETH', async function () {
      // Get ETH/USD price for bridging
      const ethUsdFeed = await feedRegistry.feeds(
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE
      )
      const ethUsdRawAnswer = BigInt(ethUsdFeed.answer)
      const ethUsdFeedDecimals = Number(ethUsdFeed.decimals)
      const ethUsdPrice = calculateNormalizedPrice(
        ethUsdRawAnswer,
        ethUsdFeedDecimals,
        PRICE_DECIMALS
      )

      // Calculate expected prices
      const expectedStethPrice = await getExpectedPriceInQuote(
        feedRegistry,
        contracts.STETH,
        QuoteDenomination.ETH,
        QuoteDenomination.ETH,
        PRICE_DECIMALS,
        ethUsdPrice
      )
      const expectedUsdcPrice = await getExpectedPriceInQuote(
        feedRegistry,
        contracts.USDC,
        QuoteDenomination.USD,
        QuoteDenomination.ETH,
        PRICE_DECIMALS,
        ethUsdPrice
      )

      const [stethPrice, usdcPrice, stethDecimals, usdcDecimals] =
        await oracleRouter.getPricesAndDecimals(
          contracts.STETH,
          contracts.USDC,
          QuoteDenomination.ETH
        )

      expect(stethPrice).to.equal(expectedStethPrice)
      expect(usdcPrice).to.equal(expectedUsdcPrice)
      expect(stethDecimals).to.equal(18)
      expect(usdcDecimals).to.equal(6)
    })

    it('should bridge both tokens when both are USD-quoted', async function () {
      // Get ETH/USD price for bridging
      const ethUsdFeed = await feedRegistry.feeds(
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE
      )
      const ethUsdRawAnswer = BigInt(ethUsdFeed.answer)
      const ethUsdFeedDecimals = Number(ethUsdFeed.decimals)
      const ethUsdPrice = calculateNormalizedPrice(
        ethUsdRawAnswer,
        ethUsdFeedDecimals,
        PRICE_DECIMALS
      )

      // Calculate expected prices
      const expectedDaiPrice = await getExpectedPriceInQuote(
        feedRegistry,
        contracts.DAI,
        QuoteDenomination.USD,
        QuoteDenomination.ETH,
        PRICE_DECIMALS,
        ethUsdPrice
      )
      const expectedUsdcPrice = await getExpectedPriceInQuote(
        feedRegistry,
        contracts.USDC,
        QuoteDenomination.USD,
        QuoteDenomination.ETH,
        PRICE_DECIMALS,
        ethUsdPrice
      )

      const [daiPrice, usdcPrice, daiDecimals, usdcDecimals] =
        await oracleRouter.getPricesAndDecimals(
          contracts.DAI,
          contracts.USDC,
          QuoteDenomination.ETH
        )

      expect(daiPrice).to.equal(expectedDaiPrice)
      expect(usdcPrice).to.equal(expectedUsdcPrice)
      expect(daiDecimals).to.equal(18)
      expect(usdcDecimals).to.equal(6)
    })

    it('should use direct prices when both tokens are ETH-quoted', async function () {
      // Get ETH/USD price (not needed for direct prices, but required for helper)
      const ethUsdFeed = await feedRegistry.feeds(
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE
      )
      const ethUsdRawAnswer = BigInt(ethUsdFeed.answer)
      const ethUsdFeedDecimals = Number(ethUsdFeed.decimals)
      const ethUsdPrice = calculateNormalizedPrice(
        ethUsdRawAnswer,
        ethUsdFeedDecimals,
        PRICE_DECIMALS
      )

      // Calculate expected prices
      const expectedStethPrice = await getExpectedPriceInQuote(
        feedRegistry,
        contracts.STETH,
        QuoteDenomination.ETH,
        QuoteDenomination.ETH,
        PRICE_DECIMALS,
        ethUsdPrice
      )
      const expectedLdoPrice = await getExpectedPriceInQuote(
        feedRegistry,
        contracts.LDO,
        QuoteDenomination.ETH,
        QuoteDenomination.ETH,
        PRICE_DECIMALS,
        ethUsdPrice
      )

      const [stethPrice, ldoPrice, stethDecimals, ldoDecimals] =
        await oracleRouter.getPricesAndDecimals(
          contracts.STETH,
          contracts.LDO,
          QuoteDenomination.ETH
        )

      expect(stethPrice).to.equal(expectedStethPrice)
      expect(ldoPrice).to.equal(expectedLdoPrice)
      expect(stethDecimals).to.equal(18)
      expect(ldoDecimals).to.equal(18)
    })
  })

  describe('Edge Cases', function () {
    it('should revert if ETH/USD bridge is missing when bridging is needed', async function () {
      const freshRouter = await oracleRouterFactory.deploy(adminAddress, 18, feedRegistryAddress)
      await freshRouter.waitForDeployment()

      const admin = await getAdminSigner()
      await freshRouter
        .connect(admin)
        .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86400, true)
      await freshRouter
        .connect(admin)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, true)

      // Should revert when trying to bridge without ETH/USD bridge configured
      await expect(
        freshRouter.getPricesAndDecimals(contracts.STETH, contracts.DAI, QuoteDenomination.USD)
      ).to.be.revertedWithCustomError(freshRouter, 'EthUsdBridgeMissing')
    })

    it('should handle staleness override for ETH/USD bridge during bridging', async function () {
      const admin = await getAdminSigner()
      const currentTimestamp = await getCurrentTimestamp()

      // Set a custom staleness override for DAI
      await oracleRouter.connect(admin).setTokenEthUsdStalenessOverride(contracts.DAI, 3600)

      // Make ETH/USD feed stale beyond override but within global limit
      await updateTokenFeed(
        feedConfig,
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE,
        {
          updatedAt: currentTimestamp - 1800n, // 30 minutes old
        }
      )

      // Should work with override - calculate expected prices
      const ethUsdFeed = await feedRegistry.feeds(
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE
      )
      const ethUsdRawAnswer = BigInt(ethUsdFeed.answer)
      const ethUsdFeedDecimals = Number(ethUsdFeed.decimals)
      const ethUsdPrice = calculateNormalizedPrice(
        ethUsdRawAnswer,
        ethUsdFeedDecimals,
        PRICE_DECIMALS
      )

      const expectedDaiPrice = await getExpectedPriceInQuote(
        feedRegistry,
        contracts.DAI,
        QuoteDenomination.USD,
        QuoteDenomination.ETH,
        PRICE_DECIMALS,
        ethUsdPrice
      )
      const expectedStethPrice = await getExpectedPriceInQuote(
        feedRegistry,
        contracts.STETH,
        QuoteDenomination.ETH,
        QuoteDenomination.ETH,
        PRICE_DECIMALS,
        ethUsdPrice
      )

      const [daiPrice, stethPrice] = await oracleRouter.getPricesAndDecimals(
        contracts.DAI,
        contracts.STETH,
        QuoteDenomination.ETH
      )

      expect(daiPrice).to.equal(expectedDaiPrice)
      expect(stethPrice).to.equal(expectedStethPrice)

      // Make ETH/USD feed stale beyond override
      await updateTokenFeed(
        feedConfig,
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE,
        {
          updatedAt: currentTimestamp - 7200n, // 2 hours old
        }
      )

      // Should revert due to override staleness
      await expect(
        oracleRouter.getPricesAndDecimals(contracts.DAI, contracts.STETH, QuoteDenomination.ETH)
      ).to.be.revertedWithCustomError(oracleRouter, 'OracleStale')
    })

    it('should handle different decimal precisions correctly', async function () {
      // Get ETH/USD price for bridging
      const ethUsdFeed = await feedRegistry.feeds(
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE
      )
      const ethUsdRawAnswer = BigInt(ethUsdFeed.answer)
      const ethUsdFeedDecimals = Number(ethUsdFeed.decimals)
      const ethUsdPrice = calculateNormalizedPrice(
        ethUsdRawAnswer,
        ethUsdFeedDecimals,
        PRICE_DECIMALS
      )

      // Calculate expected prices
      const expectedDaiPrice = await getExpectedPriceInQuote(
        feedRegistry,
        contracts.DAI,
        QuoteDenomination.USD,
        QuoteDenomination.ETH,
        PRICE_DECIMALS,
        ethUsdPrice
      )
      const expectedUsdcPrice = await getExpectedPriceInQuote(
        feedRegistry,
        contracts.USDC,
        QuoteDenomination.USD,
        QuoteDenomination.ETH,
        PRICE_DECIMALS,
        ethUsdPrice
      )

      // USDC has 6 decimals, DAI has 18
      const [daiPrice, usdcPrice, daiDecimals, usdcDecimals] =
        await oracleRouter.getPricesAndDecimals(
          contracts.DAI,
          contracts.USDC,
          QuoteDenomination.ETH
        )

      expect(daiPrice).to.equal(expectedDaiPrice)
      expect(usdcPrice).to.equal(expectedUsdcPrice)
      expect(daiDecimals).to.equal(18)
      expect(usdcDecimals).to.equal(6)
    })
  })

  describe('Price Consistency', function () {
    it('should return consistent prices regardless of token order', async function () {
      // Get ETH/USD price for bridging
      const ethUsdFeed = await feedRegistry.feeds(
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE
      )
      const ethUsdRawAnswer = BigInt(ethUsdFeed.answer)
      const ethUsdFeedDecimals = Number(ethUsdFeed.decimals)
      const ethUsdPrice = calculateNormalizedPrice(
        ethUsdRawAnswer,
        ethUsdFeedDecimals,
        PRICE_DECIMALS
      )

      // Calculate expected prices
      const expectedDaiPrice = await getExpectedPriceInQuote(
        feedRegistry,
        contracts.DAI,
        QuoteDenomination.USD,
        QuoteDenomination.USD,
        PRICE_DECIMALS,
        ethUsdPrice
      )
      const expectedStethPrice = await getExpectedPriceInQuote(
        feedRegistry,
        contracts.STETH,
        QuoteDenomination.ETH,
        QuoteDenomination.USD,
        PRICE_DECIMALS,
        ethUsdPrice
      )

      const [price1, price2] = await oracleRouter.getPricesAndDecimals(
        contracts.DAI,
        contracts.STETH,
        QuoteDenomination.USD
      )

      const [price3, price4] = await oracleRouter.getPricesAndDecimals(
        contracts.STETH,
        contracts.DAI,
        QuoteDenomination.USD
      )

      // Prices should be consistent (swapped order)
      expect(price1).to.equal(expectedDaiPrice)
      expect(price2).to.equal(expectedStethPrice)
      expect(price3).to.equal(expectedStethPrice)
      expect(price4).to.equal(expectedDaiPrice)
      expect(price1).to.equal(price4)
      expect(price2).to.equal(price3)
    })

    it('should return same price when querying same token', async function () {
      // Get ETH/USD price (not needed for direct prices, but required for helper)
      const ethUsdFeed = await feedRegistry.feeds(
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE
      )
      const ethUsdRawAnswer = BigInt(ethUsdFeed.answer)
      const ethUsdFeedDecimals = Number(ethUsdFeed.decimals)
      const ethUsdPrice = calculateNormalizedPrice(
        ethUsdRawAnswer,
        ethUsdFeedDecimals,
        PRICE_DECIMALS
      )

      // Calculate expected price
      const expectedDaiPrice = await getExpectedPriceInQuote(
        feedRegistry,
        contracts.DAI,
        QuoteDenomination.USD,
        QuoteDenomination.USD,
        PRICE_DECIMALS,
        ethUsdPrice
      )

      const [price1, price2] = await oracleRouter.getPricesAndDecimals(
        contracts.DAI,
        contracts.DAI,
        QuoteDenomination.USD
      )

      expect(price1).to.equal(expectedDaiPrice)
      expect(price2).to.equal(expectedDaiPrice)
      expect(price1).to.equal(price2)
    })
  })
})
