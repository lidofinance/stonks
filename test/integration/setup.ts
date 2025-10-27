import { ethers } from 'hardhat'
import { Signer } from 'ethers'
import { impersonateAccount, setCode } from '@nomicfoundation/hardhat-network-helpers'
import { getContracts } from '../../utils/contracts'
import { deployStonks } from '../../scripts/deployments/stonks'
import { AmountConverter, Stonks } from '../../typechain-types'

export type TokenPair = {
  tokenFrom: string
  tokenTo: string
  name?: string
  priceFeedHeartbeatTimeout: number
  useEthBridge?: boolean // If true, use ETH/USD bridge instead of direct USD feed
}
export type Setup = {
  manager: Signer
  stonks: Stonks
  amountConverter: AmountConverter
  value: bigint
}
export type SetupParams = {
  pair?: TokenPair
  deployedContract?: string
}

const contracts = getContracts()

export const setupOverDeployedContracts = async (deployedContract: string): Promise<Setup> => {
  const stonks = await ethers.getContractAt('Stonks', deployedContract)
  const amountConverter = await ethers.getContractAt(
    'AmountConverter',
    await stonks.AMOUNT_CONVERTER()
  )
  const managerAddress = await stonks.manager()
  const manager = await ethers.getSigner(managerAddress)
  const tokenFrom = await ethers.getContractAt('IERC20Metadata', await stonks.TOKEN_FROM())

  await impersonateAccount(managerAddress)

  return {
    manager,
    stonks: stonks.connect(manager),
    amountConverter,
    value: BigInt(10) ** (await tokenFrom.decimals()),
  }
}

export const setup = async (pair: TokenPair): Promise<Setup> => {
  const manager = (await ethers.getSigners())[0]
  pair = pair || {
    tokenFrom: contracts.STETH,
    tokenTo: contracts.USDT,
    priceFeedHeartbeatTimeout: 3600,
  }

  const oracleRouterFactory = await ethers.getContractFactory('OracleRouter')
  const oracleRouter = await oracleRouterFactory.deploy(
    await manager.getAddress(),
    8,
    contracts.CHAINLINK_PRICE_FEED_REGISTRY
  )
  await oracleRouter.waitForDeployment()

  const erc20Interface = new ethers.Interface(['function decimals() view returns (uint8)'])
  const getErc20Contract = (addr: string) => new ethers.Contract(addr, erc20Interface, manager)

  const feedRegistry = await ethers.getContractAt(
    'IFeedRegistry',
    contracts.CHAINLINK_PRICE_FEED_REGISTRY
  )

  const getFeedInfo = async (
    base: string,
    quote: string
  ): Promise<{
    exists: boolean
    age: number | null
    aggregator: string
    answer: bigint
    isValid: boolean
  }> => {
    try {
      const [roundId, answer, , updatedAt, answeredInRound] = await feedRegistry.latestRoundData(
        base,
        quote
      )
      const exists = true
      const isValid = answeredInRound >= roundId && answer > 0n
      const latestBlock = await ethers.provider.getBlock('latest')
      const age = isValid ? latestBlock!.timestamp - Number(updatedAt) : null
      const aggregator = await feedRegistry.getFeed(base, quote)

      return { exists, age, aggregator, answer, isValid }
    } catch {
      return {
        exists: false,
        age: null,
        aggregator: ethers.ZeroAddress,
        answer: 0n,
        isValid: false,
      }
    }
  }

  const configureToken = async (tokenAddr: string, useEthBridge: boolean = false) => {
    const tokenDecimals: number = await getErc20Contract(tokenAddr)
      .getFunction('decimals')
      .staticCall()

    if (useEthBridge) {
      // Use ETH as bridge when direct USD feed isn't available or stale
      const [ethInfo, bridgeInfo] = await Promise.all([
        getFeedInfo(tokenAddr, contracts.CHAINLINK_ETH_QUOTE),
        getFeedInfo(contracts.CHAINLINK_ETH_QUOTE, contracts.CHAINLINK_USD_QUOTE),
      ])

      if (
        ethInfo.isValid &&
        bridgeInfo.isValid &&
        ethInfo.age !== null &&
        bridgeInfo.age !== null &&
        ethInfo.age <= pair.priceFeedHeartbeatTimeout &&
        bridgeInfo.age <= pair.priceFeedHeartbeatTimeout
      ) {
        await oracleRouter.setEthUsdBridge(pair.priceFeedHeartbeatTimeout)
        await oracleRouter.setTokenEthFeed(
          tokenAddr,
          pair.priceFeedHeartbeatTimeout,
          tokenDecimals,
          true
        )
        return
      }

      throw new Error(
        `ETH bridge too stale for token ${tokenAddr}: ethAge=${ethInfo.age}s, bridgeAge=${bridgeInfo.age}s, timeout=${pair.priceFeedHeartbeatTimeout}s`
      )
    } else {
      const [usdInfo] = await Promise.all([getFeedInfo(tokenAddr, contracts.CHAINLINK_USD_QUOTE)])

      if (
        usdInfo.isValid &&
        usdInfo.age !== null &&
        usdInfo.age <= pair.priceFeedHeartbeatTimeout
      ) {
        await oracleRouter.setTokenUsdFeed(
          tokenAddr,
          pair.priceFeedHeartbeatTimeout,
          tokenDecimals,
          true
        )
        return
      }

      throw new Error(
        `USD feed too stale for token ${tokenAddr}: age=${usdInfo.age}s, timeout=${pair.priceFeedHeartbeatTimeout}s`
      )
    }
  }

  await configureToken(pair.tokenFrom, pair.useEthBridge ?? false)
  await configureToken(pair.tokenTo, pair.useEthBridge ?? false)

  // Fail fast if router can't read prices before deploying stonks
  await oracleRouter.getUsdPrices(pair.tokenFrom, pair.tokenTo)

  const result = await deployStonks({
    factoryParams: {
      agent: contracts.AGENT,
      relayer: contracts.VAULT_RELAYER,
      settlement: contracts.SETTLEMENT,
      priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
      oracleRouterAddress: await oracleRouter.getAddress(),
    },
    stonksParams: {
      tokenFrom: pair.tokenFrom,
      tokenTo: pair.tokenTo,
      manager: await manager.getAddress(),
      marginInBps: 100,
      orderDuration: 300,
      priceToleranceInBps: 100,
    },
    amountConverterParams: {
      oracleRouter: await oracleRouter.getAddress(),
      allowedTokensToSell: [pair.tokenFrom],
      allowedStableTokensToBuy: [pair.tokenTo],
    },
    skipRouterConfiguration: true,
  })

  const tokenFrom = await ethers.getContractAt('IERC20Metadata', pair.tokenFrom)

  return {
    manager,
    stonks: result.stonks,
    amountConverter: result.amountConverter,
    value: BigInt(10) ** (await tokenFrom.decimals()),
  }
}

export const setupPriceSpikeStub = async (
  stonks: Stonks,
  manager: Signer,
  spikeDownFactor: bigint = 5n
): Promise<void> => {
  const feedRegistryStubFactory = await ethers.getContractFactory('ChainlinkFeedRegistryStub')
  const feedRegistryStub = await feedRegistryStubFactory.deploy(manager, manager)

  const feedRegistry = await ethers.getContractAt(
    'IFeedRegistry',
    contracts.CHAINLINK_PRICE_FEED_REGISTRY
  )

  const oracleRouterAddress = await stonks.ORACLE_ROUTER()
  const oracleRouter = await ethers.getContractAt('OracleRouter', oracleRouterAddress)

  const tokenFrom = await stonks.TOKEN_FROM()
  const tokenTo = await stonks.TOKEN_TO()

  const fromConfig = await oracleRouter.tokenConfig(tokenFrom)
  const toConfig = await oracleRouter.tokenConfig(tokenTo)

  const getTokenFeedData = async (
    token: string,
    config: any
  ): Promise<{ quote: string; aggregator: string; decimals: number; latest: any }> => {
    // Match the quote denomination that router is configured to use
    const useEthBridge = config.primaryQuote === 1n
    const quote = useEthBridge ? contracts.CHAINLINK_ETH_QUOTE : contracts.CHAINLINK_USD_QUOTE

    const decimalsResult = await feedRegistry.decimals(token, quote)
    const decimals = Number(decimalsResult)
    const latest = await feedRegistry.latestRoundData(token, quote)
    const aggregator = await feedRegistry.getFeed(token, quote)

    return {
      quote,
      aggregator,
      decimals,
      latest,
    }
  }

  const fromFeed = await getTokenFeedData(tokenFrom, fromConfig)
  const toFeed = await getTokenFeedData(tokenTo, toConfig)

  const ethDecimals = await feedRegistry.decimals(
    contracts.CHAINLINK_ETH_QUOTE,
    contracts.CHAINLINK_USD_QUOTE
  )
  const ethLatest = await feedRegistry.latestRoundData(
    contracts.CHAINLINK_ETH_QUOTE,
    contracts.CHAINLINK_USD_QUOTE
  )
  const ethAggregator = await feedRegistry.getFeed(
    contracts.CHAINLINK_ETH_QUOTE,
    contracts.CHAINLINK_USD_QUOTE
  )

  await setCode(
    contracts.CHAINLINK_PRICE_FEED_REGISTRY,
    await ethers.provider.getCode(feedRegistryStub)
  )

  const stubAtRegistry = await ethers.getContractAt(
    'ChainlinkFeedRegistryStub',
    contracts.CHAINLINK_PRICE_FEED_REGISTRY
  )

  // Spike price down to trigger PriceConditionChanged
  const baseLatest = BigInt(fromFeed.latest.answer)
  const baseOne = 10n ** BigInt(fromFeed.decimals)
  const baseSafe = baseLatest > 0n ? baseLatest : baseOne
  const tolBps = BigInt(await stonks.PRICE_TOLERANCE_IN_BASIS_POINTS())
  const downFactor = 10000n - tolBps * spikeDownFactor > 0n ? 10000n - tolBps * spikeDownFactor : 1n
  const baseSpiked = (baseSafe * downFactor) / 10000n

  const latestBlock = await ethers.provider.getBlock('latest')
  const nowTs = BigInt(latestBlock!.timestamp)

  await stubAtRegistry.setFeed(tokenFrom, fromFeed.quote, {
    aggregator: fromFeed.aggregator,
    answer: baseSpiked,
    updatedAt: nowTs,
    startedAt: nowTs,
    answeredInRound: fromFeed.latest.answeredInRound > 0n ? fromFeed.latest.answeredInRound : 1n,
    roundId: fromFeed.latest.roundId > 0n ? fromFeed.latest.roundId : 1n,
    decimals: fromFeed.decimals,
  })

  // Keep quote token at same price to isolate the spike effect
  const quoteLatest = BigInt(toFeed.latest.answer)
  const quoteOne = 10n ** BigInt(toFeed.decimals)
  const quoteSafe = quoteLatest > 0n ? quoteLatest : quoteOne
  await stubAtRegistry.setFeed(tokenTo, toFeed.quote, {
    aggregator: toFeed.aggregator,
    answer: quoteSafe,
    updatedAt: nowTs,
    startedAt: nowTs,
    answeredInRound: toFeed.latest.answeredInRound > 0n ? toFeed.latest.answeredInRound : 1n,
    roundId: toFeed.latest.roundId > 0n ? toFeed.latest.roundId : 1n,
    decimals: toFeed.decimals,
  })

  // Keep bridge fresh to avoid staleness errors during price spike test
  await stubAtRegistry.setFeed(contracts.CHAINLINK_ETH_QUOTE, contracts.CHAINLINK_USD_QUOTE, {
    aggregator: ethAggregator,
    answer: ethLatest.answer,
    updatedAt: nowTs,
    startedAt: nowTs,
    answeredInRound: ethLatest.answeredInRound > 0n ? ethLatest.answeredInRound : 1n,
    roundId: ethLatest.roundId > 0n ? ethLatest.roundId : 1n,
    decimals: ethDecimals,
  })
}

export const pairs = [
  {
    tokenFrom: contracts.STETH,
    tokenTo: contracts.DAI,
    name: 'STETH->DAI',
    priceFeedHeartbeatTimeout: 86400,
  },
  {
    tokenFrom: contracts.STETH,
    tokenTo: contracts.USDC,
    name: 'STETH->USDC',
    priceFeedHeartbeatTimeout: 86400,
  },
  {
    tokenFrom: contracts.STETH,
    tokenTo: contracts.USDT,
    name: 'STETH->USDT',
    priceFeedHeartbeatTimeout: 86400,
  },
  {
    tokenFrom: contracts.USDC,
    tokenTo: contracts.STETH,
    name: 'USDC->STETH',
    priceFeedHeartbeatTimeout: 86400,
  },
  {
    tokenFrom: contracts.USDC,
    tokenTo: contracts.DAI,
    name: 'USDC->DAI',
    priceFeedHeartbeatTimeout: 86400,
  },
  {
    tokenFrom: contracts.USDC,
    tokenTo: contracts.USDT,
    name: 'USDC->USDT',
    priceFeedHeartbeatTimeout: 86400,
  },
  {
    tokenFrom: contracts.USDT,
    tokenTo: contracts.DAI,
    name: 'USDT->DAI',
    priceFeedHeartbeatTimeout: 86400,
  },
  {
    tokenFrom: contracts.USDT,
    tokenTo: contracts.USDC,
    name: 'USDT->USDC',
    priceFeedHeartbeatTimeout: 86400,
  },
  {
    tokenFrom: contracts.DAI,
    tokenTo: contracts.USDT,
    name: 'DAI->USDT',
    priceFeedHeartbeatTimeout: 86400,
  },
  {
    tokenFrom: contracts.DAI,
    tokenTo: contracts.USDC,
    name: 'DAI->USDC',
    priceFeedHeartbeatTimeout: 86400,
  },
  {
    tokenFrom: contracts.STETH,
    tokenTo: contracts.DAI,
    name: 'STETH->DAI (ETH Bridge)',
    priceFeedHeartbeatTimeout: 86400,
    useEthBridge: true,
  },
  {
    tokenFrom: contracts.STETH,
    tokenTo: contracts.USDC,
    name: 'STETH->USDC (ETH Bridge)',
    priceFeedHeartbeatTimeout: 86400,
    useEthBridge: true,
  },
]
