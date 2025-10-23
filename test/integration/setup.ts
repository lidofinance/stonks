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

  const erc20Iface = new ethers.Interface(['function decimals() view returns (uint8)'])
  const erc20 = (addr: string) => new ethers.Contract(addr, erc20Iface, manager)

  const feedRegistry = await ethers.getContractAt(
    'IFeedRegistry',
    contracts.CHAINLINK_PRICE_FEED_REGISTRY
  )

  const configureToken = async (tokenAddr: string) => {
    const dec: number = await erc20(tokenAddr).getFunction('decimals').staticCall()

    const hasUsdFeed = async () => {
      try {
        const feed = await feedRegistry.getFeed(tokenAddr, contracts.CHAINLINK_USD_QUOTE)
        return feed !== ethers.ZeroAddress
      } catch {
        return false
      }
    }

    const hasEthFeed = async () => {
      try {
        const feed = await feedRegistry.getFeed(tokenAddr, contracts.CHAINLINK_ETH_QUOTE)
        return feed !== ethers.ZeroAddress
      } catch {
        return false
      }
    }

    const hasEthUsdBridge = async () => {
      try {
        const feed = await feedRegistry.getFeed(
          contracts.CHAINLINK_ETH_QUOTE,
          contracts.CHAINLINK_USD_QUOTE
        )
        return feed !== ethers.ZeroAddress
      } catch {
        return false
      }
    }

    if (await hasUsdFeed()) {
      await oracleRouter.setTokenUsdFeed(tokenAddr, 86_400, dec, true)
      return
    }

    if ((await hasEthFeed()) && (await hasEthUsdBridge())) {
      await oracleRouter.setEthUsdBridge(86_400)
      await oracleRouter.setTokenEthFeed(tokenAddr, 86_400, dec, true)
      return
    }

    throw new Error(`No valid price feed found for token ${tokenAddr}`)
  }

  await configureToken(pair.tokenFrom)
  await configureToken(pair.tokenTo)

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

  const tokenFrom = await stonks.TOKEN_FROM()
  const tokenTo = await stonks.TOKEN_TO()

  const getTokenFeedData = async (token: string) => {
    try {
      const usdFeed = await feedRegistry.getFeed(token, contracts.CHAINLINK_USD_QUOTE)
      if (usdFeed !== ethers.ZeroAddress) {
        const decimals = await feedRegistry.decimals(token, contracts.CHAINLINK_USD_QUOTE)
        const latest = await feedRegistry.latestRoundData(token, contracts.CHAINLINK_USD_QUOTE)
        return {
          quote: contracts.CHAINLINK_USD_QUOTE,
          aggregator: usdFeed,
          decimals,
          latest,
        }
      }
    } catch {}

    const ethFeed = await feedRegistry.getFeed(token, contracts.CHAINLINK_ETH_QUOTE)
    const decimals = await feedRegistry.decimals(token, contracts.CHAINLINK_ETH_QUOTE)
    const latest = await feedRegistry.latestRoundData(token, contracts.CHAINLINK_ETH_QUOTE)
    return {
      quote: contracts.CHAINLINK_ETH_QUOTE,
      aggregator: ethFeed,
      decimals,
      latest,
    }
  }

  const fromFeed = await getTokenFeedData(tokenFrom)
  const toFeed = await getTokenFeedData(tokenTo)

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

  const ethLatestAns = BigInt(ethLatest.answer)
  const ethDefault = 2000n * 10n ** BigInt(ethDecimals)
  const ethSafe = ethLatestAns > 0n ? ethLatestAns : ethDefault
  await stubAtRegistry.setFeed(contracts.CHAINLINK_ETH_QUOTE, contracts.CHAINLINK_USD_QUOTE, {
    aggregator: ethAggregator,
    answer: ethSafe,
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
    priceFeedHeartbeatTimeout: 3600,
  },
  {
    tokenFrom: contracts.STETH,
    tokenTo: contracts.USDC,
    name: 'STETH->USDC',
    priceFeedHeartbeatTimeout: 3600,
  },
  {
    tokenFrom: contracts.STETH,
    tokenTo: contracts.USDT,
    name: 'STETH->USDT',
    priceFeedHeartbeatTimeout: 3600,
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
    priceFeedHeartbeatTimeout: 3600,
  },
  {
    tokenFrom: contracts.DAI,
    tokenTo: contracts.USDC,
    name: 'DAI->USDC',
    priceFeedHeartbeatTimeout: 3600,
  },
]
