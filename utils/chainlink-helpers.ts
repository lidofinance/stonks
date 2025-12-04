import { ethers } from 'hardhat'
import { getContracts } from './contracts'
import { getTestFeedRegistryStub } from './test-feed-registry'
import { ChainlinkFeedRegistryStub } from '../typechain-types'

const contracts = getContracts()

export type FeedData = {
  aggregator: string
  answer: bigint
  updatedAt: bigint
  startedAt: bigint
  roundId: bigint
  answeredInRound: bigint
  decimals: number
  exists: boolean
}

export const getExpectedOut = async (
  tokenFrom: string,
  tokenTo: string,
  amount: bigint
): Promise<bigint> => {
  const feedRegistryAddress = await (
    await getTestFeedRegistryStub({
      tokens: [tokenFrom, tokenTo],
      useRealPrices: true,
    })
  ).getAddress()
  const feedRegistry = await ethers.getContractAt('IFeedRegistry', feedRegistryAddress)

  const PRICE_DECIMALS = 18n

  const readPriceNormalized = async (base: string, quote: string): Promise<bigint> => {
    const decimals = await feedRegistry.decimals(base, quote)
    const [, raw] = await feedRegistry.latestRoundData(base, quote)
    const d = BigInt(decimals)
    if (d === PRICE_DECIMALS) return raw
    if (d < PRICE_DECIMALS) return raw * 10n ** (PRICE_DECIMALS - d)
    return raw / 10n ** (d - PRICE_DECIMALS)
  }

  const priceFromUSD = await readPriceNormalized(tokenFrom, contracts.CHAINLINK_USD_QUOTE)
  const priceToUSD = await readPriceNormalized(tokenTo, contracts.CHAINLINK_USD_QUOTE)

  const decimalsOfSellToken = await (
    await ethers.getContractAt('IERC20Metadata', tokenFrom)
  ).decimals()
  const decimalsOfBuyToken = await (
    await ethers.getContractAt('IERC20Metadata', tokenTo)
  ).decimals()

  const diff = BigInt(decimalsOfSellToken) - BigInt(decimalsOfBuyToken)
  const sellHasMoreOrEqualDecimals = diff >= 0n

  if (sellHasMoreOrEqualDecimals) {
    const grossOutput = (amount * priceFromUSD) / priceToUSD
    return diff === 0n ? grossOutput : grossOutput / 10n ** diff
  } else {
    const pow10 = 10n ** -diff
    const scaledAmount = amount * pow10
    return (scaledAmount * priceFromUSD) / priceToUSD
  }
}

export async function fetchFeedData(token: string, quote: string): Promise<FeedData> {
  try {
    const registry = await ethers.getContractAt(
      'IFeedRegistry',
      contracts.CHAINLINK_PRICE_FEED_REGISTRY
    )

    const aggregator = await registry.getFeed(token, quote)
    if (aggregator === ethers.ZeroAddress) {
      return {
        aggregator: ethers.ZeroAddress,
        answer: 0n,
        updatedAt: 0n,
        startedAt: 0n,
        roundId: 0n,
        answeredInRound: 0n,
        decimals: 0,
        exists: false,
      }
    }

    const [roundId, answer, startedAt, updatedAt, answeredInRound] =
      await registry.latestRoundData(token, quote)
    const decimals = await registry.decimals(token, quote)

    return {
      aggregator,
      answer: BigInt(answer),
      updatedAt: BigInt(updatedAt),
      startedAt: BigInt(startedAt),
      roundId: BigInt(roundId),
      answeredInRound: BigInt(answeredInRound),
      decimals: Number(decimals),
      exists: true,
    }
  } catch (error) {
    return {
      aggregator: ethers.ZeroAddress,
      answer: 0n,
      updatedAt: 0n,
      startedAt: 0n,
      roundId: 0n,
      answeredInRound: 0n,
      decimals: 0,
      exists: false,
    }
  }
}

export async function fetchMultipleFeedData(
  pairs: Array<{ token: string; quote: string }>
): Promise<Map<string, FeedData>> {
  const results = new Map<string, FeedData>()

  for (const { token, quote } of pairs) {
    const key = `${token.toLowerCase()}-${quote.toLowerCase()}`
    const data = await fetchFeedData(token, quote)
    results.set(key, data)
  }

  return results
}

export async function createStubWithFeedData(
  tokens: string[],
  quotes: string[] = [contracts.CHAINLINK_USD_QUOTE, contracts.CHAINLINK_ETH_QUOTE],
  includeEthUsdBridge: boolean = true
): Promise<ChainlinkFeedRegistryStub> {
  const [deployer] = await ethers.getSigners()

  const stubFactory = await ethers.getContractFactory('ChainlinkFeedRegistryStub')
  const stub = await stubFactory.deploy(deployer, deployer)
  await stub.waitForDeployment()

  if (includeEthUsdBridge) {
    const ethUsdData = await fetchFeedData(
      contracts.CHAINLINK_ETH_QUOTE,
      contracts.CHAINLINK_USD_QUOTE
    )
    if (ethUsdData.exists) {
      await stub.setFeed(contracts.CHAINLINK_ETH_QUOTE, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: ethUsdData.aggregator,
        answer: ethUsdData.answer,
        updatedAt: ethUsdData.updatedAt,
        startedAt: ethUsdData.startedAt,
        roundId: ethUsdData.roundId,
        answeredInRound: ethUsdData.answeredInRound,
        decimals: ethUsdData.decimals,
      })
    }
  }

  for (const token of tokens) {
    for (const quote of quotes) {
      const feedData = await fetchFeedData(token, quote)
      if (feedData.exists) {
        await stub.setFeed(token, quote, {
          aggregator: feedData.aggregator,
          answer: feedData.answer,
          updatedAt: feedData.updatedAt,
          startedAt: feedData.startedAt,
          roundId: feedData.roundId,
          answeredInRound: feedData.answeredInRound,
          decimals: feedData.decimals,
        })
      }
    }
  }

  return stub
}

export async function getCurrentTimestamp(): Promise<bigint> {
  const block = await ethers.provider.getBlock('latest')
  if (!block) throw new Error('Failed to get latest block')
  return BigInt(block.timestamp)
}

export async function isFeedFresh(
  token: string,
  quote: string,
  maxAgeSeconds: number = 86400
): Promise<boolean> {
  const feedData = await fetchFeedData(token, quote)
  if (!feedData.exists) return false

  const now = await getCurrentTimestamp()
  const age = now - feedData.updatedAt
  return age <= BigInt(maxAgeSeconds)
}

export function formatFeedData(data: FeedData, tokenSymbol?: string, quoteSymbol?: string): string {
  if (!data.exists) {
    return `Feed ${tokenSymbol || 'unknown'}/${quoteSymbol || 'unknown'}: NOT FOUND`
  }

  const price = Number(data.answer) / 10 ** data.decimals
  const ageSeconds = Date.now() / 1000 - Number(data.updatedAt)
  const ageHours = (ageSeconds / 3600).toFixed(1)

  return `Feed ${tokenSymbol || 'unknown'}/${quoteSymbol || 'unknown'}: $${price.toFixed(2)} (${data.decimals} decimals, ${ageHours}h old, aggregator: ${data.aggregator.slice(0, 10)}...)`
}
