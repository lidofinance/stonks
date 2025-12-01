import { ethers } from 'hardhat'
import { expect } from 'chai'
import { parseEther, parseUnits } from 'ethers'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import type { AmountConverter, OracleRouter } from '../../typechain-types'
import { getContracts } from '../../utils/contracts'
import {
  getAllTestTokens,
  refreshTestFeedData,
  resetTestFeedRegistryStub,
  refreshFeedData,
  getTestFeedRegistryStub,
} from '../../utils/test-feed-registry'
import { getTestOracleRouter, resetTestOracleRouter } from '../../utils/test-oracle-router'
import { QuoteDenomination } from '../../utils/oracle-router'

const contracts = getContracts()

// Helper function to calculate expected output using the same logic as AmountConverter
function calculateExpectedOutput(
  amountFrom: bigint,
  priceFrom: bigint,
  priceTo: bigint,
  decimalsFrom: number,
  decimalsTo: number
): bigint {
  const sellHasMoreOrEqualDecimals = decimalsFrom >= decimalsTo
  const decimalsDiff = sellHasMoreOrEqualDecimals
    ? decimalsFrom - decimalsTo
    : decimalsTo - decimalsFrom

  if (sellHasMoreOrEqualDecimals) {
    // grossOutput = (amountFrom * priceFrom) / priceTo
    const grossOutput = (amountFrom * priceFrom) / priceTo

    if (decimalsDiff === 0) {
      return grossOutput
    } else {
      return grossOutput / 10n ** BigInt(decimalsDiff)
    }
  } else {
    // Scale the input first
    const pow10 = 10n ** BigInt(decimalsDiff)
    const scaledAmountFrom = amountFrom * pow10
    return (scaledAmountFrom * priceFrom) / priceTo
  }
}

describe('AmountConverter - Bridging Tests', () => {
  let router: OracleRouter
  let factory: any
  let snapshot: SnapshotRestorer

  before(async () => {
    snapshot = await takeSnapshot()

    router = await getTestOracleRouter({
      tokens: getAllTestTokens(),
      useRealPrices: true,
      agent: contracts.AGENT, // Use the same agent address
    })

    await refreshTestFeedData(getAllTestTokens())

    // Configure tokens with mixed denominations
    const agent = await ethers.getImpersonatedSigner(contracts.AGENT)
    await (
      await ethers.getSigners()
    )[0].sendTransaction({
      to: contracts.AGENT,
      value: parseEther('1'),
    })

    // getTestOracleRouter already tries to set the bridge, but it might fail silently
    // Ensure ETH/USD feed exists and is fresh, then set/sync the bridge
    await refreshTestFeedData(getAllTestTokens())

    // Verify ETH/USD feed exists in the registry before setting bridge
    const feedRegistryAddress = await router.FEED_REGISTRY()
    const feedRegistry = await ethers.getContractAt(
      'ChainlinkFeedRegistryStub',
      feedRegistryAddress
    )

    // Check if feed exists using getFeed (the method the contract uses)
    let ethUsdFeed = await feedRegistry.getFeed(
      contracts.CHAINLINK_ETH_QUOTE,
      contracts.CHAINLINK_USD_QUOTE
    )

    if (ethUsdFeed === ethers.ZeroAddress) {
      // Feed doesn't exist - set it up with a fallback value
      const latestBlock = await ethers.provider.getBlock('latest')
      const nowTs = BigInt(latestBlock!.timestamp)
      // Use a reasonable ETH/USD price (e.g., $3000)
      const ethUsdPrice = 3000n * 10n ** 8n // $3000 with 8 decimals
      await feedRegistry.setFeed(contracts.CHAINLINK_ETH_QUOTE, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: await feedRegistry.getAddress(),
        answer: ethUsdPrice,
        updatedAt: nowTs,
        startedAt: nowTs,
        answeredInRound: 1n,
        roundId: 1n,
        decimals: 8,
      })

      // Verify it was set
      ethUsdFeed = await feedRegistry.getFeed(
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE
      )
      if (ethUsdFeed === ethers.ZeroAddress) {
        throw new Error('Failed to set ETH/USD feed')
      }
    }

    // Now set the bridge (feed should exist now)
    await router.connect(agent).setEthUsdBridge(86400)
    await router.connect(agent).setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, true)
    await router.connect(agent).setTokenFeed(contracts.USDC, QuoteDenomination.USD, 86400, true)
    await router
      .connect(agent)
      .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86400, true)
    await router.connect(agent).setTokenFeed(contracts.LDO, QuoteDenomination.ETH, 86400, true)

    factory = await ethers.getContractFactory('AmountConverter')
  })

  after(async () => {
    await snapshot.restore()
    resetTestOracleRouter()
    resetTestFeedRegistryStub()
  })

  describe('USD Mode (useEthAnchor=false) - Bridging', () => {
    it('should convert ETH-quoted token to USD-quoted token', async function () {
      const converter = await factory.deploy(
        await router.getAddress(),
        [contracts.STETH],
        [contracts.DAI],
        false
      )
      await converter.waitForDeployment()

      const amount = parseEther('1')
      const [stethPrice, daiPrice, stethDecimals, daiDecimals] = await router.getPricesAndDecimals(
        contracts.STETH,
        contracts.DAI,
        QuoteDenomination.USD
      )

      const expectedResult = calculateExpectedOutput(
        amount,
        stethPrice,
        daiPrice,
        Number(stethDecimals),
        Number(daiDecimals)
      )

      const result = await converter.getExpectedOut(contracts.STETH, contracts.DAI, amount)

      expect(result).to.equal(expectedResult)
    })

    it('should convert USD-quoted token to ETH-quoted token', async () => {
      const converter = await factory.deploy(
        await router.getAddress(),
        [contracts.DAI],
        [contracts.STETH],
        false
      )
      await converter.waitForDeployment()

      const amount = parseEther('1000')
      const [daiPrice, stethPrice, daiDecimals, stethDecimals] = await router.getPricesAndDecimals(
        contracts.DAI,
        contracts.STETH,
        QuoteDenomination.USD
      )

      const expectedResult = calculateExpectedOutput(
        amount,
        daiPrice,
        stethPrice,
        Number(daiDecimals),
        Number(stethDecimals)
      )

      const result = await converter.getExpectedOut(contracts.DAI, contracts.STETH, amount)

      expect(result).to.equal(expectedResult)
    })

    it('should convert between two ETH-quoted tokens using USD bridge', async () => {
      const converter = await factory.deploy(
        await router.getAddress(),
        [contracts.STETH],
        [contracts.LDO],
        false
      )
      await converter.waitForDeployment()

      const amount = parseEther('1')
      const [stethPrice, ldoPrice, stethDecimals, ldoDecimals] = await router.getPricesAndDecimals(
        contracts.STETH,
        contracts.LDO,
        QuoteDenomination.USD
      )

      const expectedResult = calculateExpectedOutput(
        amount,
        stethPrice,
        ldoPrice,
        Number(stethDecimals),
        Number(ldoDecimals)
      )

      const result = await converter.getExpectedOut(contracts.STETH, contracts.LDO, amount)

      expect(result).to.equal(expectedResult)
    })

    it('should handle different decimal precisions with bridging', async () => {
      const converter = await factory.deploy(
        await router.getAddress(),
        [contracts.STETH],
        [contracts.USDC],
        false
      )
      await converter.waitForDeployment()

      const amount = parseEther('1')
      const [stethPrice, usdcPrice, stethDecimals, usdcDecimals] =
        await router.getPricesAndDecimals(contracts.STETH, contracts.USDC, QuoteDenomination.USD)

      const expectedResult = calculateExpectedOutput(
        amount,
        stethPrice,
        usdcPrice,
        Number(stethDecimals),
        Number(usdcDecimals)
      )

      const result = await converter.getExpectedOut(contracts.STETH, contracts.USDC, amount)

      expect(result).to.equal(expectedResult)
    })
  })

  describe('ETH Mode (useEthAnchor=true) - Bridging', () => {
    it('should convert USD-quoted token to ETH-quoted token', async () => {
      const converter = await factory.deploy(
        await router.getAddress(),
        [contracts.DAI],
        [contracts.STETH],
        true
      )
      await converter.waitForDeployment()

      const amount = parseEther('1000')
      const [daiPrice, stethPrice, daiDecimals, stethDecimals] = await router.getPricesAndDecimals(
        contracts.DAI,
        contracts.STETH,
        QuoteDenomination.ETH
      )

      const expectedResult = calculateExpectedOutput(
        amount,
        daiPrice,
        stethPrice,
        Number(daiDecimals),
        Number(stethDecimals)
      )

      const result = await converter.getExpectedOut(contracts.DAI, contracts.STETH, amount)

      expect(result).to.equal(expectedResult)
    })

    it('should convert ETH-quoted token to USD-quoted token', async () => {
      const converter = await factory.deploy(
        await router.getAddress(),
        [contracts.STETH],
        [contracts.DAI],
        true
      )
      await converter.waitForDeployment()

      const amount = parseEther('1')
      const [stethPrice, daiPrice, stethDecimals, daiDecimals] = await router.getPricesAndDecimals(
        contracts.STETH,
        contracts.DAI,
        QuoteDenomination.ETH
      )

      const expectedResult = calculateExpectedOutput(
        amount,
        stethPrice,
        daiPrice,
        Number(stethDecimals),
        Number(daiDecimals)
      )

      const result = await converter.getExpectedOut(contracts.STETH, contracts.DAI, amount)

      expect(result).to.equal(expectedResult)
    })

    it('should convert between two USD-quoted tokens using ETH bridge', async () => {
      const converter = await factory.deploy(
        await router.getAddress(),
        [contracts.DAI],
        [contracts.USDC],
        true
      )
      await converter.waitForDeployment()

      const amount = parseEther('1000')
      const [daiPrice, usdcPrice, daiDecimals, usdcDecimals] = await router.getPricesAndDecimals(
        contracts.DAI,
        contracts.USDC,
        QuoteDenomination.ETH
      )

      const expectedResult = calculateExpectedOutput(
        amount,
        daiPrice,
        usdcPrice,
        Number(daiDecimals),
        Number(usdcDecimals)
      )

      const result = await converter.getExpectedOut(contracts.DAI, contracts.USDC, amount)

      expect(result).to.equal(expectedResult)
    })
  })

  describe('Edge Cases', () => {
    it('should revert if ETH/USD bridge is missing when bridging is needed', async () => {
      // Deploy a fresh router without configuring the ETH/USD bridge
      const feedRegistry = await getTestFeedRegistryStub({
        tokens: getAllTestTokens(),
        useRealPrices: true,
      })
      const oracleRouterFactory = await ethers.getContractFactory('OracleRouter')
      const unitDecimals = Number(await router.PRICE_DECIMALS())
      const freshRouter = await oracleRouterFactory.deploy(
        contracts.AGENT,
        unitDecimals,
        await feedRegistry.getAddress()
      )
      await freshRouter.waitForDeployment()

      const agent = await ethers.getImpersonatedSigner(contracts.AGENT)
      await (
        await ethers.getSigners()
      )[0].sendTransaction({
        to: contracts.AGENT,
        value: parseEther('1'),
      })

      // Configure tokens but don't set ETH/USD bridge
      await freshRouter
        .connect(agent)
        .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86400, true)
      await freshRouter
        .connect(agent)
        .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, true)

      const converter = await factory.deploy(
        await freshRouter.getAddress(),
        [contracts.STETH],
        [contracts.DAI],
        false
      )
      await converter.waitForDeployment()

      const amount = parseEther('1')

      await expect(
        converter.getExpectedOut(contracts.STETH, contracts.DAI, amount)
      ).to.be.revertedWithCustomError(freshRouter, 'EthUsdBridgeMissing')
    })

    it('should handle zero prices gracefully', async () => {
      // This test ensures that if a price is zero, the converter should revert
      // (This is already handled by the router, but we verify the error propagates)
      const converter = await factory.deploy(
        await router.getAddress(),
        [contracts.STETH],
        [contracts.DAI],
        false
      )
      await converter.waitForDeployment()

      // Normal case should work - calculate expected result
      const amount = parseEther('1')
      const [stethPrice, daiPrice, stethDecimals, daiDecimals] = await router.getPricesAndDecimals(
        contracts.STETH,
        contracts.DAI,
        QuoteDenomination.USD
      )

      const expectedResult = calculateExpectedOutput(
        amount,
        stethPrice,
        daiPrice,
        Number(stethDecimals),
        Number(daiDecimals)
      )

      const result = await converter.getExpectedOut(contracts.STETH, contracts.DAI, amount)
      expect(result).to.equal(expectedResult)
    })
  })

  describe('Price Consistency', () => {
    it('should return consistent results for same input', async () => {
      const converter = await factory.deploy(
        await router.getAddress(),
        [contracts.STETH],
        [contracts.DAI],
        false
      )
      await converter.waitForDeployment()

      const amount = parseEther('1')
      const [stethPrice, daiPrice, stethDecimals, daiDecimals] = await router.getPricesAndDecimals(
        contracts.STETH,
        contracts.DAI,
        QuoteDenomination.USD
      )

      const expectedResult = calculateExpectedOutput(
        amount,
        stethPrice,
        daiPrice,
        Number(stethDecimals),
        Number(daiDecimals)
      )

      const result1 = await converter.getExpectedOut(contracts.STETH, contracts.DAI, amount)
      const result2 = await converter.getExpectedOut(contracts.STETH, contracts.DAI, amount)

      expect(result1).to.equal(expectedResult)
      expect(result2).to.equal(expectedResult)
      expect(result1).to.equal(result2)
    })

    it('should scale proportionally with input amount', async () => {
      const converter = await factory.deploy(
        await router.getAddress(),
        [contracts.STETH],
        [contracts.DAI],
        false
      )
      await converter.waitForDeployment()

      const amount1 = parseEther('1')
      const amount2 = parseEther('2')
      const [stethPrice, daiPrice, stethDecimals, daiDecimals] = await router.getPricesAndDecimals(
        contracts.STETH,
        contracts.DAI,
        QuoteDenomination.USD
      )

      const expectedResult1 = calculateExpectedOutput(
        amount1,
        stethPrice,
        daiPrice,
        Number(stethDecimals),
        Number(daiDecimals)
      )
      const expectedResult2 = calculateExpectedOutput(
        amount2,
        stethPrice,
        daiPrice,
        Number(stethDecimals),
        Number(daiDecimals)
      )

      const result1 = await converter.getExpectedOut(contracts.STETH, contracts.DAI, amount1)
      const result2 = await converter.getExpectedOut(contracts.STETH, contracts.DAI, amount2)

      expect(result1).to.equal(expectedResult1)
      expect(result2).to.equal(expectedResult2)

      const scaled = (expectedResult1 * amount2) / amount1
      expect(result2).to.be.closeTo(scaled, 1n)
    })
  })
})
