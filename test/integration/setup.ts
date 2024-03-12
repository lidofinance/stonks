import { ethers, network } from 'hardhat'
import { Signer } from 'ethers'
import { impersonateAccount } from '@nomicfoundation/hardhat-network-helpers'
import { getContracts } from '../../utils/contracts'
import { deployStonks } from '../../scripts/deployments/stonks'
import { AmountConverter, AmountConverterTest, Stonks } from '../../typechain-types'

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
      conversionTarget: contracts.CHAINLINK_USD_QUOTE,
      allowedTokensToSell: [pair.tokenFrom],
      allowedStableTokensToBuy: [pair.tokenTo],
      priceFeedsHeartbeatTimeouts: [86400],
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
