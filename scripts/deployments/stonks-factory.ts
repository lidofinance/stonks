import { ethers } from 'hardhat'
import { StonksFactory } from '../../typechain-types'

type ReturnType = { stonksFactory: StonksFactory }

export async function deployStonksFactory(
  agent: string,
  settlement: string,
  relayer: string,
  feedRegistry: string
): Promise<ReturnType> {
  const ContractFactory = await ethers.getContractFactory('StonksFactory')
  const stonksFactory = await ContractFactory.deploy(
    agent,
    settlement,
    relayer,
    feedRegistry
  )

  await stonksFactory.waitForDeployment()

  return { stonksFactory }
}
