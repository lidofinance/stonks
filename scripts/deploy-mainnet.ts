import { ethers } from 'hardhat'
import { mainnet } from '../utils/contracts'

async function main() {
  const stonksFactory = await (
    await ethers.getContractFactory('StonksFactory')
  ).deploy(mainnet.TREASURY, mainnet.SETTLEMENT, mainnet.VAULT_RELAYER)

  await stonksFactory.waitForDeployment()

  return { stonksFactory }
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
