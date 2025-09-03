import { ethers } from 'hardhat'

import { deployStonksFactory } from './stonks-factory'
import { deployAmountConverterFactory } from './amount-converter-factory'
import { getStonksDeployment, getTokenConverterDeployment } from '../../utils/get-events'
import { AmountConverter, Stonks, OracleRouter, OracleRouter__factory } from '../../typechain-types'

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
    oracleRouterAddress?: string
  }
  amountConverterParams: {
    oracleRouter: string
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
    oracleRouterAddress,
    orderDuration,
    marginInBps,
    priceToleranceInBps,
  },
  amountConverterParams,
}: DeployStonksParams): Promise<ReturnType> {
  const { stonksFactory } = await deployStonksFactory(agent, settlement, relayer)

  let amountConverter: AmountConverter | undefined
  let oracleRouter: OracleRouter | undefined

  if (amountConverterAddress && oracleRouterAddress) {
    amountConverter = await ethers.getContractAt('AmountConverter', amountConverterAddress)
    // If amountConverter is provided, we still need to get the oracleRouter from it
    oracleRouter = await ethers.getContractAt('OracleRouter', oracleRouterAddress)
  } else if (amountConverterParams) {
    const { amountConverterFactory } = await deployAmountConverterFactory(priceFeedRegistry)
    const { oracleRouter, allowedTokensToSell, allowedStableTokensToBuy } = amountConverterParams
    const deployTokenConverterTX = await amountConverterFactory.deployAmountConverter(
      oracleRouter,
      allowedTokensToSell,
      allowedStableTokensToBuy
    )
    const receipt = await deployTokenConverterTX.wait()

    if (!receipt) throw new Error('No transaction receipt')

    const { address } = getTokenConverterDeployment(receipt)
    amountConverter = await ethers.getContractAt('AmountConverter', address)
  } else {
    throw new Error()
  }
  console.log('Oracle Router Address: ', amountConverterParams.oracleRouter)

  const deployStonksTx = await stonksFactory.deployStonks(
    manager,
    tokenFrom,
    tokenTo,
    await amountConverter.getAddress(),
    amountConverterParams.oracleRouter,
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
