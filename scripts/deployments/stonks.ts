import { ethers } from 'hardhat'

import { deployStonksFactory } from './stonks-factory'
import {
  getStonksDeployment,
  getTokenConverterDeployment,
} from '../../utils/get-events'
import { ChainLinkTokenConverter, Stonks } from '../../typechain-types'

export type DeployStonksParams = {
  stonksParams: {
    tokenFrom: string
    tokenTo: string
    operator: string
    marginInBps: number
    priceToleranceInBps: number
    tokenConverterAddress?: string
  }
  tokenConverterParams?: {
    priceFeedRegistry: string
    allowedTokensToSell: string[]
    allowedStableTokensToBuy: string[]
  }
}
type ReturnType = {
  stonks: Stonks
  tokenConverter: ChainLinkTokenConverter
}

export async function deployStonks({
  stonksParams: {
    tokenFrom,
    tokenTo,
    tokenConverterAddress,
    operator,
    marginInBps,
    priceToleranceInBps,
  },
  tokenConverterParams,
}: DeployStonksParams): Promise<ReturnType> {
  const { stonksFactory } = await deployStonksFactory()

  let tokenConverter: ChainLinkTokenConverter | undefined
  if (tokenConverterParams) {
    const { priceFeedRegistry, allowedTokensToSell, allowedStableTokensToBuy } =
      tokenConverterParams
    const deployTokenConverterTX =
      await stonksFactory.deployChainLinkTokenConverter(
        priceFeedRegistry,
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
    tokenFrom,
    tokenTo,
    operator,
    await tokenConverter.getAddress(),
    marginInBps,
    priceToleranceInBps
  )
  const receipt = await deployStonksTx.wait()

  if (!receipt) throw new Error('No transaction receipt')

  const { address } = getStonksDeployment(receipt)
  const stonks = await ethers.getContractAt('Stonks', address)

  return { stonks, tokenConverter }
}
