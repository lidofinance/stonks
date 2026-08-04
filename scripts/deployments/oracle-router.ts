import { ethers } from 'hardhat'
import { OracleRouter } from '../../typechain-types'

type ReturnType = { oracleRouter: OracleRouter }

export async function deployOracleRouter(
  admin: string,
  chainlinkPriceFeedRegistry: string
): Promise<ReturnType> {
  const ContractFactory = await ethers.getContractFactory('OracleRouter')
  const oracleRouter = await ContractFactory.deploy(admin, chainlinkPriceFeedRegistry)

  await oracleRouter.waitForDeployment()
  return { oracleRouter }
}
