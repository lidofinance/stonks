import { ethers } from 'hardhat'

import { deployStonksFactory } from './stonks-factory'
import { deployAmountConverterFactory } from './amount-converter-factory'
import {
  getStonksDeployment,
  getTokenConverterDeployment,
} from '../../utils/get-events'
import { AmountConverter, Stonks } from '../../typechain-types'

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
    amountConverterAddress?: string
  }
  amountConverterParams: {
    conversionTarget: string
    allowedTokensToSell: string[]
    allowedStableTokensToBuy: string[]
  }
}
type ReturnType = {
  stonks: Stonks
  amountConverter: AmountConverter
}

export async function deployStonks({
  factoryParams: { agent, settlement, relayer, priceFeedRegistry },
  stonksParams: {
    manager,
    tokenFrom,
    tokenTo,
    amountConverterAddress,
    orderDuration,
    marginInBps,
    priceToleranceInBps,
  },
  amountConverterParams,
}: DeployStonksParams): Promise<ReturnType> {
  const { stonksFactory } = await deployStonksFactory(
    agent,
    settlement,
    relayer
  )

  let amountConverter: AmountConverter | undefined
  if (amountConverterParams) {
    const { amountConverterFactory } =
      await deployAmountConverterFactory(priceFeedRegistry)
    const { allowedTokensToSell, allowedStableTokensToBuy, conversionTarget } =
      amountConverterParams
    const deployTokenConverterTX =
      await amountConverterFactory.deployAmountConverter(
        conversionTarget,
        allowedTokensToSell,
        allowedStableTokensToBuy
      )
    const receipt = await deployTokenConverterTX.wait()

    if (!receipt) throw new Error('No transaction receipt')

    const { address } = getTokenConverterDeployment(receipt)
    amountConverter = await ethers.getContractAt('AmountConverter', address)
  } else if (amountConverterAddress) {
    amountConverter = await ethers.getContractAt(
      'AmountConverter',
      amountConverterAddress
    )
  } else {
    throw new Error()
  }

  const deployStonksTx = await stonksFactory.deployStonks(
    manager,
    tokenFrom,
    tokenTo,
    await amountConverter.getAddress(),
    orderDuration,
    marginInBps,
    priceToleranceInBps
  )
  const receipt = await deployStonksTx.wait()

  if (!receipt) throw new Error('No transaction receipt')

  const { address } = getStonksDeployment(receipt)
  const stonks = await ethers.getContractAt('Stonks', address)

  return { stonks, amountConverter }
}
