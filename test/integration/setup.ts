import { ethers } from 'hardhat'
import { Signer } from 'ethers'
import { impersonateAccount } from '@nomicfoundation/hardhat-network-helpers'
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

  // Ensure registry has fresh, non-stale data for this pair by replacing with stub
  // Use compiled IFeedRegistry ABI instead of ad-hoc Interface
  const registry = await ethers.getContractAt(
    'IFeedRegistry',
    contracts.CHAINLINK_PRICE_FEED_REGISTRY,
    manager
  )

  const hasFeed = async (base: string, quote: string) => {
    try {
      const addr: string = await registry.getFunction('getFeed').staticCall(base, quote)
      return addr !== ethers.ZeroAddress
    } catch {
      return false
    }
  }

  const readDecimalsOr = async (base: string, quote: string, fallback: bigint) => {
    try {
      return BigInt(await registry.getFunction('decimals').staticCall(base, quote))
    } catch {
      return fallback
    }
  }

  const readOrDefault = async (base: string, quote: string, decimals: bigint) => {
    try {
      const data = await registry.getFunction('latestRoundData').staticCall(base, quote)
      const ans = BigInt(data[1])
      if (ans > 0n)
        return { answer: ans, answeredInRound: BigInt(data[4]), roundId: BigInt(data[0]) }
    } catch {}
    const one = 10n ** decimals
    return { answer: one, answeredInRound: 0n, roundId: 0n }
  }

  // Deploy stub and replace registry code
  const stubFactory = await ethers.getContractFactory('ChainlinkFeedRegistryStub')
  const stub = await stubFactory.deploy(manager, manager)
  await stub.waitForDeployment()
  await (
    await import('@nomicfoundation/hardhat-network-helpers')
  ).setCode(contracts.CHAINLINK_PRICE_FEED_REGISTRY, await ethers.provider.getCode(stub))
  const stubAtRegistry = await ethers.getContractAt(
    'ChainlinkFeedRegistryStub',
    contracts.CHAINLINK_PRICE_FEED_REGISTRY
  )
  // Helper to seed a single pair on the stubbed registry address
  const seedPair = async (base: string, quote: string) => {
    const dec = await readDecimalsOr(base, quote, 8n)
    const data = await readOrDefault(base, quote, dec)
    await stubAtRegistry.setFeed(base, quote, {
      answer: data.answer,
      updatedAt: 0n,
      startedAt: 0n,
      answeredInRound: data.answeredInRound,
      roundId: data.roundId,
      decimals: Number(dec),
    })
  }

  // Seed ETH/USD always
  await seedPair(contracts.CHAINLINK_ETH_QUOTE, contracts.CHAINLINK_USD_QUOTE)

  // Prefer USD for tokens; fallback to ETH
  const seedToken = async (token: string) => {
    if (await hasFeed(token, contracts.CHAINLINK_USD_QUOTE)) {
      await seedPair(token, contracts.CHAINLINK_USD_QUOTE)
      return
    }
    if (await hasFeed(token, contracts.CHAINLINK_ETH_QUOTE)) {
      await seedPair(token, contracts.CHAINLINK_ETH_QUOTE)
    }
  }

  await seedToken(pair.tokenFrom)
  await seedToken(pair.tokenTo)

  const result = await deployStonks({
    factoryParams: {
      agent: contracts.AGENT,
      relayer: contracts.VAULT_RELAYER,
      settlement: contracts.SETTLEMENT,
      priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
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
      allowedTokensToSell: [pair.tokenFrom],
      allowedStableTokensToBuy: [pair.tokenTo],
    },
  })

  const tokenFrom = await ethers.getContractAt('IERC20Metadata', pair.tokenFrom)

  return {
    manager,
    stonks: result.stonks,
    amountConverter: result.amountConverter,
    value: BigInt(10) ** (await tokenFrom.decimals()),
  }
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
  // Stable -> Volatile
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
  // Volatile -> Volatile
  {
    tokenFrom: contracts.LDO,
    tokenTo: contracts.STETH,
    name: 'LDO->STETH',
    priceFeedHeartbeatTimeout: 3600,
  },
]
