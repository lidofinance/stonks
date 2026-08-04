import { ethers } from 'hardhat'
import type { OracleRouter } from '../../typechain-types'
import { QuoteDenomination } from '../../utils/oracle-router'
import { getContracts } from '../../utils/contracts'

const contracts = getContracts()

export type QuoteValue = (typeof QuoteDenomination)[keyof typeof QuoteDenomination]

/**
 * Reads normalized feed price from Chainlink registry
 */
export async function readNormalizedFeedPrice(
  feedRegistryAddress: string,
  base: string,
  quote: string,
  targetDecimals: bigint
): Promise<bigint> {
  const feedRegistry = await ethers.getContractAt('ChainlinkFeedRegistryStub', feedRegistryAddress)
  const feed = await feedRegistry.feeds(base, quote)
  const feedAnswer = BigInt(feed.answer)
  const feedDecimals = BigInt(feed.decimals)

  if (feedDecimals === targetDecimals) {
    return feedAnswer
  } else if (feedDecimals < targetDecimals) {
    return feedAnswer * 10n ** (targetDecimals - feedDecimals)
  } else {
    return feedAnswer / 10n ** (feedDecimals - targetDecimals)
  }
}

/**
 * Gets router's PRICE_DECIMALS
 */
export async function getRouterPriceDecimals(router: OracleRouter): Promise<bigint> {
  return BigInt(await router.PRICE_DECIMALS())
}

/**
 * Gets router's PRICE_UNIT
 */
export async function getRouterPriceUnit(router: OracleRouter): Promise<bigint> {
  return BigInt(await router.PRICE_UNIT())
}

/**
 * Calculates expected USD price for a token (direct USD feed)
 */
export async function getExpectedUsdPrice(
  router: OracleRouter,
  feedRegistryAddress: string,
  token: string
): Promise<bigint> {
  const decimals = await getRouterPriceDecimals(router)
  return readNormalizedFeedPrice(
    feedRegistryAddress,
    token,
    contracts.CHAINLINK_USD_QUOTE,
    decimals
  )
}

/**
 * Calculates expected USD price for an ETH-quoted token (via bridge)
 */
export async function getExpectedUsdBridgePrice(
  router: OracleRouter,
  feedRegistryAddress: string,
  token: string
): Promise<bigint> {
  const decimals = await getRouterPriceDecimals(router)
  const unit = await getRouterPriceUnit(router)
  const tokenEth = await readNormalizedFeedPrice(
    feedRegistryAddress,
    token,
    contracts.CHAINLINK_ETH_QUOTE,
    decimals
  )
  const ethUsd = await readNormalizedFeedPrice(
    feedRegistryAddress,
    contracts.CHAINLINK_ETH_QUOTE,
    contracts.CHAINLINK_USD_QUOTE,
    decimals
  )
  return (tokenEth * ethUsd) / unit
}

/**
 * Calculates expected ETH price for a USD-quoted token (via bridge)
 */
export async function getExpectedEthBridgePrice(
  router: OracleRouter,
  feedRegistryAddress: string,
  token: string
): Promise<bigint> {
  const decimals = await getRouterPriceDecimals(router)
  const unit = await getRouterPriceUnit(router)
  const tokenUsd = await readNormalizedFeedPrice(
    feedRegistryAddress,
    token,
    contracts.CHAINLINK_USD_QUOTE,
    decimals
  )
  const ethUsd = await readNormalizedFeedPrice(
    feedRegistryAddress,
    contracts.CHAINLINK_ETH_QUOTE,
    contracts.CHAINLINK_USD_QUOTE,
    decimals
  )
  return (tokenUsd * unit) / ethUsd
}

/**
 * Gets expected price for a token in the requested quote denomination
 */
export async function getExpectedPriceForQuote(
  router: OracleRouter,
  feedRegistryAddress: string,
  token: string,
  requestedQuote: QuoteValue
): Promise<bigint> {
  const config = await router.tokenConfig(token)
  const primaryQuote = Number(config.primaryQuote)

  if (primaryQuote === requestedQuote) {
    const quoteAddress =
      requestedQuote === QuoteDenomination.USD
        ? contracts.CHAINLINK_USD_QUOTE
        : contracts.CHAINLINK_ETH_QUOTE
    const decimals = await getRouterPriceDecimals(router)
    return readNormalizedFeedPrice(feedRegistryAddress, token, quoteAddress, decimals)
  }

  if (primaryQuote === QuoteDenomination.ETH && requestedQuote === QuoteDenomination.USD) {
    return getExpectedUsdBridgePrice(router, feedRegistryAddress, token)
  }

  if (primaryQuote === QuoteDenomination.USD && requestedQuote === QuoteDenomination.ETH) {
    return getExpectedEthBridgePrice(router, feedRegistryAddress, token)
  }

  throw new Error('Unsupported quote transition')
}

/**
 * Gets expected prices for a token pair in the requested quote denomination
 */
export async function getExpectedPricesForPair(
  router: OracleRouter,
  feedRegistryAddress: string,
  base: string,
  quote: string,
  requestedQuote: QuoteValue
): Promise<[bigint, bigint]> {
  const baseExpected = await getExpectedPriceForQuote(
    router,
    feedRegistryAddress,
    base,
    requestedQuote
  )
  const quoteExpected = await getExpectedPriceForQuote(
    router,
    feedRegistryAddress,
    quote,
    requestedQuote
  )
  return [baseExpected, quoteExpected]
}

/**
 * Calculates price ratio: priceA / priceB
 */
export function calculatePriceRatio(priceA: bigint, priceB: bigint): bigint {
  if (priceB === 0n) {
    throw new Error('Cannot calculate ratio with zero denominator')
  }
  return priceA / priceB
}

/**
 * Verifies price ratio symmetry: (A/B) * (B/A) should equal 1 (within rounding)
 */
export function verifyPriceRatioSymmetry(
  ratioAB: bigint,
  ratioBA: bigint,
  priceUnit: bigint,
  tolerance: bigint = 1n
): boolean {
  // ratioAB * ratioBA should equal priceUnit^2 / (priceA * priceB) * (priceB * priceA) = priceUnit^2
  // For normalized prices: (priceA / priceUnit) / (priceB / priceUnit) * (priceB / priceUnit) / (priceA / priceUnit)
  // = (priceA / priceB) * (priceB / priceA) = 1
  // But we're working with normalized prices, so we need to account for that

  // If ratioAB = normalizedA / normalizedB and ratioBA = normalizedB / normalizedA
  // Then ratioAB * ratioBA should be close to priceUnit^2 / priceUnit^2 = 1
  // Actually, since prices are normalized, ratioAB * ratioBA should equal priceUnit^2 / priceUnit^2 = 1

  // More precisely: if we have actual prices priceA and priceB, and normalized prices:
  // normalizedA = priceA * priceUnit / feedPriceUnit
  // normalizedB = priceB * priceUnit / feedPriceUnit
  // ratioAB = normalizedA / normalizedB = priceA / priceB
  // ratioBA = normalizedB / normalizedA = priceB / priceA
  // ratioAB * ratioBA = (priceA / priceB) * (priceB / priceA) = 1

  // But we're working with bigint division which floors, so we need to check:
  // ratioAB * ratioBA should be close to priceUnit^2 (since both are normalized to priceUnit)
  const product = (ratioAB * ratioBA) / priceUnit
  const expected = priceUnit
  const diff = product > expected ? product - expected : expected - product
  return diff <= tolerance
}


