import { ethers } from 'hardhat'

async function main() {
  const stonksFactory = await (
    await ethers.getContractFactory('StonksFactory')
  ).deploy()

  await stonksFactory.waitForDeployment()

  return { stonksFactory }
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
