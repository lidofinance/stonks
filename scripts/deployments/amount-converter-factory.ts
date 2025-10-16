import { ethers } from 'hardhat'
import { AmountConverterFactory } from '../../typechain-types'

type ReturnType = { amountConverterFactory: AmountConverterFactory }

export async function deployAmountConverterFactory(
  feedRegistry: string,
  oracleRouter: string
): Promise<ReturnType> {
  const ContractFactory = await ethers.getContractFactory('AmountConverterFactory')
  const amountConverterFactory = await ContractFactory.deploy(feedRegistry, oracleRouter)

  await amountConverterFactory.waitForDeployment()
  return { amountConverterFactory }
}
