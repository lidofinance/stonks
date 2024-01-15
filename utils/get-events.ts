import { ethers } from 'hardhat'
import type { TransactionReceipt, Log } from 'ethers'
import {
  StonksFactory__factory,
  AmountConverterFactory__factory,
  Order__factory,
} from '../typechain-types'
import { PlaceOrderDataEvent } from './types'

export const getPlaceOrderData = async (
  receipt: TransactionReceipt
): Promise<PlaceOrderDataEvent> => {
  const orderInterface = Order__factory.createInterface()
  const orderEvent = (receipt as TransactionReceipt).logs
    .map((log: Log) => orderInterface.parseLog(log as any))
    .find((log) => log?.name === 'OrderCreated')
  const blockNumber = receipt.blockNumber
  const blockTimestamp = (await ethers.provider.getBlock(blockNumber))
    ?.timestamp
  if (!blockTimestamp) throw Error('blockTimestamp is undefined')
  const data: any = orderEvent?.args

  return {
    address: data[0],
    hash: data[1],
    timestamp: blockTimestamp,
    order: {
      sellToken: data[2][0],
      buyToken: data[2][1],
      receiver: data[2][2],
      sellAmount: data[2][3].toString(),
      buyAmount: data[2][4].toString(),
      validTo: Number(data[2][5]),
      appData: data[2][6],
      feeAmount: data[2][7].toString(),
      kind: data[2][8],
      partiallyFillable: data[2][9],
      sellTokenBalance: data[2][10],
      buyTokenBalance: data[2][11],
    },
  }
}

export const getStonksDeployment = (
  receipt: TransactionReceipt
): {
  address: string
  tokenFrom: string
  tokenTo: string
  tokenConverter: string
  operator: string
  order: string
} => {
  const stonksFactoryInterface = StonksFactory__factory.createInterface()
  const deployEvent = stonksFactoryInterface.parseLog(
    (receipt as any).logs[receipt.logs.length - 1]
  )
  const data: any = deployEvent?.args

  return {
    address: data[0],
    tokenFrom: data[1],
    tokenTo: data[2],
    tokenConverter: data[3],
    operator: data[4],
    order: data[5],
  }
}

export const getTokenConverterDeployment = (
  receipt: TransactionReceipt
): {
  address: string
  feedRegistryAddress: string
  allowedTokensToSell: string[]
  allowedStableTokensToBuy: string[]
} => {
  const stonksFactoryInterface =
    AmountConverterFactory__factory.createInterface()
  const deployEvent = stonksFactoryInterface.parseLog(
    (receipt as any).logs[receipt.logs.length - 1]
  )
  const data: any = deployEvent?.args

  return {
    address: data[0],
    feedRegistryAddress: data[1],
    allowedTokensToSell: data[2],
    allowedStableTokensToBuy: data[3],
  }
}
