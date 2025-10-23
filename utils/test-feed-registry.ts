import { ethers } from 'hardhat'
import { ChainlinkFeedRegistryStub } from '../typechain-types'
import { getContracts } from './contracts'

const contracts = getContracts()

let globalFeedRegistryStub: ChainlinkFeedRegistryStub | null = null

export type TestFeedRegistryConfig = {
  tokens: string[]
  useRealPrices?: boolean
}

async function getRealPriceData(
  base: string,
  quote: string
): Promise<{ answer: bigint; decimals: number } | null> {
  try {
    const registry = await ethers.getContractAt(
      'IFeedRegistry',
      contracts.CHAINLINK_PRICE_FEED_REGISTRY
    )
    const feed = await registry.getFeed(base, quote)
    if (feed === ethers.ZeroAddress) return null

    const decimals = await registry.decimals(base, quote)
    const [, answer] = await registry.latestRoundData(base, quote)

    return {
      answer: BigInt(answer),
      decimals: Number(decimals),
    }
  } catch {
    return null
  }
}

async function getTokenPriceData(token: string): Promise<{ answer: bigint; decimals: number }> {
  const usdData = await getRealPriceData(token, contracts.CHAINLINK_USD_QUOTE)
  if (usdData) {
    return usdData
  }

  const ethData = await getRealPriceData(token, contracts.CHAINLINK_ETH_QUOTE)
  if (ethData) {
    const ethUsdData = await getRealPriceData(
      contracts.CHAINLINK_ETH_QUOTE,
      contracts.CHAINLINK_USD_QUOTE
    )
    if (ethUsdData) {
      const ethUsdPrice = ethUsdData.answer
      const tokenEthPrice = ethData.answer
      const tokenUsdPrice = (tokenEthPrice * ethUsdPrice) / 10n ** BigInt(ethUsdData.decimals)
      return { answer: tokenUsdPrice, decimals: 8 }
    }
  }

  const tokenLower = token.toLowerCase()
  if (tokenLower.includes('usdc') || tokenLower.includes('usdt')) {
    return { answer: 1n * 10n ** 8n, decimals: 8 }
  }
  if (tokenLower.includes('dai')) {
    return { answer: 1n * 10n ** 8n, decimals: 8 }
  }
  if (tokenLower.includes('steth')) {
    return { answer: 2000n * 10n ** 8n, decimals: 8 }
  }
  if (tokenLower.includes('ldo')) {
    return { answer: 250n * 10n ** 8n, decimals: 8 }
  }

  return { answer: 1n * 10n ** 8n, decimals: 8 }
}

async function initializeGlobalFeedRegistryStub(config: TestFeedRegistryConfig): Promise<void> {
  if (globalFeedRegistryStub) {
    return
  }

  const { tokens, useRealPrices = true } = config
  const [deployer] = await ethers.getSigners()

  const stubFactory = await ethers.getContractFactory('ChainlinkFeedRegistryStub')
  const stub = await stubFactory.deploy(deployer, deployer)
  await stub.waitForDeployment()
  globalFeedRegistryStub = stub

  const latestBlock = await ethers.provider.getBlock('latest')
  const nowTs = BigInt(latestBlock!.timestamp)

  // Seed ETH/USD feed
  if (useRealPrices) {
    const ethUsdData = await getRealPriceData(
      contracts.CHAINLINK_ETH_QUOTE,
      contracts.CHAINLINK_USD_QUOTE
    )
    if (ethUsdData) {
      await stub.setFeed(contracts.CHAINLINK_ETH_QUOTE, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: await stub.getAddress(),
        answer: ethUsdData.answer,
        updatedAt: nowTs,
        startedAt: nowTs,
        answeredInRound: 1n,
        roundId: 1n,
        decimals: ethUsdData.decimals,
      })
    }
  }

  // Seed token feeds with real mainnet data
  for (const token of tokens) {
    await seedTokenFeeds(stub, token, useRealPrices, nowTs)
  }
}

async function seedTokenFeeds(
  stub: ChainlinkFeedRegistryStub,
  token: string,
  useRealPrices: boolean,
  timestamp: bigint
): Promise<void> {
  if (!useRealPrices) {
    // Fallback to hardcoded values
    const tokenData = await getTokenPriceData(token)
    await stub.setFeed(token, contracts.CHAINLINK_USD_QUOTE, {
      aggregator: await stub.getAddress(),
      answer: tokenData.answer,
      updatedAt: timestamp,
      startedAt: timestamp,
      answeredInRound: 1n,
      roundId: 1n,
      decimals: tokenData.decimals,
    })
    return
  }

  // Try USD feed first
  const usdData = await getRealPriceData(token, contracts.CHAINLINK_USD_QUOTE)
  if (usdData) {
    await stub.setFeed(token, contracts.CHAINLINK_USD_QUOTE, {
      aggregator: await stub.getAddress(),
      answer: usdData.answer,
      updatedAt: timestamp,
      startedAt: timestamp,
      answeredInRound: 1n,
      roundId: 1n,
      decimals: usdData.decimals,
    })
  }

  // Try ETH feed (for tokens like stETH, LDO)
  const ethData = await getRealPriceData(token, contracts.CHAINLINK_ETH_QUOTE)
  if (ethData) {
    await stub.setFeed(token, contracts.CHAINLINK_ETH_QUOTE, {
      aggregator: await stub.getAddress(),
      answer: ethData.answer,
      updatedAt: timestamp,
      startedAt: timestamp,
      answeredInRound: 1n,
      roundId: 1n,
      decimals: ethData.decimals,
    })
  }

  // If neither feed exists, use fallback
  if (!usdData && !ethData) {
    const fallbackData = await getTokenPriceData(token)
    await stub.setFeed(token, contracts.CHAINLINK_USD_QUOTE, {
      aggregator: await stub.getAddress(),
      answer: fallbackData.answer,
      updatedAt: timestamp,
      startedAt: timestamp,
      answeredInRound: 1n,
      roundId: 1n,
      decimals: fallbackData.decimals,
    })
  }
}

export async function getTestFeedRegistryStub(
  config: TestFeedRegistryConfig
): Promise<ChainlinkFeedRegistryStub> {
  await initializeGlobalFeedRegistryStub(config)
  if (!globalFeedRegistryStub) {
    throw new Error('Failed to initialize FeedRegistryStub')
  }
  return globalFeedRegistryStub
}

export function resetTestFeedRegistryStub(): void {
  globalFeedRegistryStub = null
}

export async function refreshFeedData(
  config: TestFeedRegistryConfig,
  tokens?: string[]
): Promise<void> {
  const stub = await getTestFeedRegistryStub(config)
  const latestBlock = await ethers.provider.getBlock('latest')
  const nowTs = BigInt(latestBlock!.timestamp)

  const tokensToRefresh = tokens || config.tokens
  const { useRealPrices = true } = config

  // Refresh ETH/USD
  if (useRealPrices) {
    const ethUsdData = await getRealPriceData(
      contracts.CHAINLINK_ETH_QUOTE,
      contracts.CHAINLINK_USD_QUOTE
    )
    if (ethUsdData) {
      await stub.setFeed(contracts.CHAINLINK_ETH_QUOTE, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: await stub.getAddress(),
        answer: ethUsdData.answer,
        updatedAt: nowTs,
        startedAt: nowTs,
        answeredInRound: 1n,
        roundId: 1n,
        decimals: ethUsdData.decimals,
      })
    }
  }

  // Refresh token feeds
  for (const token of tokensToRefresh) {
    await seedTokenFeeds(stub, token, useRealPrices, nowTs)
  }
}

export async function hasFeed(base: string, quote: string): Promise<boolean> {
  try {
    const registry = await ethers.getContractAt(
      'IFeedRegistry',
      contracts.CHAINLINK_PRICE_FEED_REGISTRY
    )
    const addr: string = await registry.getFunction('getFeed').staticCall(base, quote)
    return addr !== ethers.ZeroAddress
  } catch {
    return false
  }
}

export async function readDecimalsOr(
  base: string,
  quote: string,
  fallback: bigint
): Promise<bigint> {
  try {
    const registry = await ethers.getContractAt(
      'IFeedRegistry',
      contracts.CHAINLINK_PRICE_FEED_REGISTRY
    )
    return BigInt(await registry.getFunction('decimals').staticCall(base, quote))
  } catch {
    return fallback
  }
}

export async function readOrDefault(
  base: string,
  quote: string,
  decimals: bigint
): Promise<{
  answer: bigint
  answeredInRound: bigint
  roundId: bigint
}> {
  try {
    const registry = await ethers.getContractAt(
      'IFeedRegistry',
      contracts.CHAINLINK_PRICE_FEED_REGISTRY
    )
    const data = await registry.getFunction('latestRoundData').staticCall(base, quote)
    const ans = BigInt(data[1])
    if (ans > 0n) {
      const roundId = BigInt(data[0]) > 0n ? BigInt(data[0]) : 1n
      const answeredInRound = BigInt(data[4]) > 0n ? BigInt(data[4]) : roundId
      return { answer: ans, answeredInRound, roundId }
    }
  } catch {}
  const one = 10n ** decimals
  return { answer: one, answeredInRound: 1n, roundId: 1n }
}

export async function ensureTokenFeed(
  config: TestFeedRegistryConfig,
  token: string
): Promise<void> {
  const stubAtRegistry = await getTestFeedRegistryStub(config)

  try {
    if (await hasFeed(token, contracts.CHAINLINK_USD_QUOTE)) {
      const dec = await readDecimalsOr(token, contracts.CHAINLINK_USD_QUOTE, 8n)
      const data = await readOrDefault(token, contracts.CHAINLINK_USD_QUOTE, dec)
      const roundId = data.roundId > 0n ? data.roundId : 1n
      const answeredInRound = data.answeredInRound > 0n ? data.answeredInRound : roundId
      await stubAtRegistry.setFeed(token, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: await stubAtRegistry.getAddress(),
        answer: data.answer,
        updatedAt: BigInt(2 ** 40),
        startedAt: BigInt(2 ** 40),
        answeredInRound,
        roundId,
        decimals: Number(dec),
      })
      return
    }
  } catch {}

  try {
    if (await hasFeed(token, contracts.CHAINLINK_ETH_QUOTE)) {
      const dec = await readDecimalsOr(token, contracts.CHAINLINK_ETH_QUOTE, 18n)
      const data = await readOrDefault(token, contracts.CHAINLINK_ETH_QUOTE, dec)
      const roundId = data.roundId > 0n ? data.roundId : 1n
      const answeredInRound = data.answeredInRound > 0n ? data.answeredInRound : roundId
      await stubAtRegistry.setFeed(token, contracts.CHAINLINK_ETH_QUOTE, {
        aggregator: await stubAtRegistry.getAddress(),
        answer: data.answer,
        updatedAt: BigInt(2 ** 40),
        startedAt: BigInt(2 ** 40),
        answeredInRound,
        roundId,
        decimals: Number(dec),
      })
      return
    }
  } catch {}

  await stubAtRegistry.setFeed(token, contracts.CHAINLINK_USD_QUOTE, {
    aggregator: await stubAtRegistry.getAddress(),
    answer: 10n ** 8n,
    updatedAt: BigInt(2 ** 40),
    startedAt: BigInt(2 ** 40),
    answeredInRound: 1n,
    roundId: 1n,
    decimals: 8,
  })
}

export async function ensureTokenFeeds(
  config: TestFeedRegistryConfig,
  tokens: string[]
): Promise<void> {
  for (const token of tokens) {
    await ensureTokenFeed(config, token)
  }
}

export type FeedUpdateConfig = {
  answer?: bigint
  updatedAt?: bigint
  startedAt?: bigint
  answeredInRound?: bigint
  roundId?: bigint
  decimals?: number
  aggregator?: string
}

export async function updateTokenFeed(
  config: TestFeedRegistryConfig,
  token: string,
  quote: string,
  updateConfig: FeedUpdateConfig
): Promise<void> {
  const stubAtRegistry = await getTestFeedRegistryStub(config)

  const currentFeed = await stubAtRegistry.feeds(token, quote)

  await stubAtRegistry.setFeed(token, quote, {
    aggregator: updateConfig.aggregator || currentFeed.aggregator,
    answer: updateConfig.answer !== undefined ? updateConfig.answer : currentFeed.answer,
    updatedAt:
      updateConfig.updatedAt !== undefined ? updateConfig.updatedAt : currentFeed.updatedAt,
    startedAt:
      updateConfig.startedAt !== undefined ? updateConfig.startedAt : currentFeed.startedAt,
    answeredInRound:
      updateConfig.answeredInRound !== undefined
        ? updateConfig.answeredInRound
        : currentFeed.answeredInRound,
    roundId: updateConfig.roundId !== undefined ? updateConfig.roundId : currentFeed.roundId,
    decimals: updateConfig.decimals !== undefined ? updateConfig.decimals : currentFeed.decimals,
  })
}

export function getAllTestTokens(): string[] {
  return [contracts.STETH, contracts.DAI, contracts.USDC, contracts.USDT, contracts.LDO]
}

export async function refreshTestFeedData(tokens?: string[]): Promise<void> {
  const tokensToRefresh = tokens || getAllTestTokens()
  await refreshFeedData(
    {
      tokens: tokensToRefresh,
      useRealPrices: true,
    },
    tokensToRefresh
  )
}
