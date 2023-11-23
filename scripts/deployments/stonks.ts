import { ethers } from 'hardhat'

import { deployStonksFactory } from './stonks-factory'
import {
  getStonksDeployment,
  getTokenConverterDeployment,
} from '../../utils/get-events'
import { ChainLinkTokenConverter, Stonks } from '../../typechain-types'

export type DeployStonksParams = {
  factoryParams: {
    agent: string
    relayer: string
    settlement: string
    priceFeedRegistry: string
  }
  stonksParams: {
    manager: string
    tokenFrom: string
    tokenTo: string
    orderDuration: number
    marginInBps: number
    priceToleranceInBps: number
    tokenConverterAddress?: string
  }
  tokenConverterParams: {
    allowedTokensToSell: string[]
    allowedStableTokensToBuy: string[]
  }
}
type ReturnType = {
  stonks: Stonks
  tokenConverter: ChainLinkTokenConverter
}

export async function deployStonks({
  factoryParams: { agent, settlement, relayer, priceFeedRegistry },
  stonksParams: {
    manager,
    tokenFrom,
    tokenTo,
    tokenConverterAddress,
    orderDuration,
    marginInBps,
    priceToleranceInBps,
  },
  tokenConverterParams,
}: DeployStonksParams): Promise<ReturnType> {
  const { stonksFactory } = await deployStonksFactory(
    agent,
    settlement,
    relayer,
    priceFeedRegistry
  )

  let tokenConverter: ChainLinkTokenConverter | undefined
  if (tokenConverterParams) {
    const { allowedTokensToSell, allowedStableTokensToBuy } =
      tokenConverterParams
    const deployTokenConverterTX =
      await stonksFactory.deployChainLinkTokenConverter(
        allowedTokensToSell,
        allowedStableTokensToBuy
      )
    const receipt = await deployTokenConverterTX.wait()

    if (!receipt) throw new Error('No transaction receipt')

    const { address } = getTokenConverterDeployment(receipt)
    tokenConverter = await ethers.getContractAt(
      'ChainLinkTokenConverter',
      address
    )
  } else if (tokenConverterAddress) {
    tokenConverter = await ethers.getContractAt(
      'ChainLinkTokenConverter',
      tokenConverterAddress
    )
  } else {
    throw new Error()
  }

  const deployStonksTx = await stonksFactory.deployStonks(
    manager,
    tokenFrom,
    tokenTo,
    await tokenConverter.getAddress(),
    orderDuration,
    marginInBps,
    priceToleranceInBps
  )
  const receipt = await deployStonksTx.wait()

  if (!receipt) throw new Error('No transaction receipt')

  const { address } = getStonksDeployment(receipt)
  const stonks = await ethers.getContractAt('Stonks', address)

  return { stonks, tokenConverter }
}
