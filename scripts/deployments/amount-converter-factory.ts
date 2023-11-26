import { ethers } from 'hardhat'
import { AmountConverterFactory } from '../../typechain-types'

type ReturnType = { amountConverterFactory: AmountConverterFactory }

export async function deployAmountConverterFactory(
  feedRegistry: string
): Promise<ReturnType> {
  const ContractFactory = await ethers.getContractFactory(
    'AmountConverterFactory'
  )
  const amountConverterFactory = await ContractFactory.deploy(feedRegistry)

  await amountConverterFactory.waitForDeployment()
  return { amountConverterFactory }
}
