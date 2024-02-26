import { ethers, network } from 'hardhat'
import { Signer } from 'ethers'
import { impersonateAccount } from '@nomicfoundation/hardhat-network-helpers'
import { mainnet } from '../../utils/contracts'
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

const defaultPair = {
  tokenFrom: mainnet.STETH,
  tokenTo: mainnet.USDT,
  priceFeedHeartbeatTimeout: 3600,
}

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
  pair = pair || defaultPair

  const result = await deployStonks({
    factoryParams: {
      agent: mainnet.AGENT,
      relayer: mainnet.VAULT_RELAYER,
      settlement: mainnet.SETTLEMENT,
      priceFeedRegistry: mainnet.CHAINLINK_PRICE_FEED_REGISTRY,
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
      conversionTarget: mainnet.CHAINLINK_USD_QUOTE,
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
    tokenFrom: mainnet.STETH,
    tokenTo: mainnet.DAI,
    name: 'STETH->DAI',
    priceFeedHeartbeatTimeout: 3600,
  },
  {
    tokenFrom: mainnet.STETH,
    tokenTo: mainnet.USDC,
    name: 'STETH->USDC',
    priceFeedHeartbeatTimeout: 3600,
  },
  {
    tokenFrom: mainnet.STETH,
    tokenTo: mainnet.USDT,
    name: 'STETH->USDT',
    priceFeedHeartbeatTimeout: 3600,
  },
  {
    tokenFrom: mainnet.USDC,
    tokenTo: mainnet.DAI,
    name: 'USDC->DAI',
    priceFeedHeartbeatTimeout: 86400,
  },
  {
    tokenFrom: mainnet.USDC,
    tokenTo: mainnet.USDT,
    name: 'USDC->USDT',
    priceFeedHeartbeatTimeout: 86400,
  },
  {
    tokenFrom: mainnet.USDT,
    tokenTo: mainnet.DAI,
    name: 'USDT->DAI',
    priceFeedHeartbeatTimeout: 86400,
  },
  {
    tokenFrom: mainnet.USDT,
    tokenTo: mainnet.USDC,
    name: 'USDT->USDC',
    priceFeedHeartbeatTimeout: 86400,
  },
  {
    tokenFrom: mainnet.DAI,
    tokenTo: mainnet.USDT,
    name: 'DAI->USDT',
    priceFeedHeartbeatTimeout: 3600,
  },
  {
    tokenFrom: mainnet.DAI,
    tokenTo: mainnet.USDC,
    name: 'DAI->USDC',
    priceFeedHeartbeatTimeout: 3600,
  },
]
