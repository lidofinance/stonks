import { assert } from 'chai'
import { ethers, network } from 'hardhat'

import fmt from '../utils/format'
import { confirmOrAbort } from '../utils/prompt'
import { getDeployer, verify, waitForDeployment } from '../utils/deployment'
import { ChainlinkFeedRegistryStub__factory } from '../typechain-types/factories/contracts/stubs'

const OWNER: string = ''
const MANAGER: string = ethers.ZeroAddress

assert(ethers.isAddress(OWNER), 'OWNER address is invalid')
assert(ethers.isAddress(MANAGER), 'MANAGER address is invalid')

async function main() {
  // prettier-ignore
  console.log(
    `Preparing for ${fmt.name('ChainlinkFeedRegistryStub')} deployment on "${fmt.network(network.name)}" network...\n`
  )
  const deployer = await getDeployer()

  console.log(`Deployment parameters:`)
  console.log(`  * ${fmt.name('Owner')} address: ${fmt.value(OWNER)}`)
  console.log(`  * ${fmt.name('Manager')} address: ${fmt.value(MANAGER)}`)

  await confirmOrAbort()

  const registry = await new ChainlinkFeedRegistryStub__factory(deployer).deploy(OWNER, MANAGER)
  const receipt = await waitForDeployment(registry.deploymentTransaction()!)

  const registryAddress = await registry.getAddress()

  console.log(
    `${fmt.name('ChainlinkFeedRegistryStub')} deployed at ${fmt.address(registryAddress)}`
  )

  if (!['localhost', 'hardhat'].includes(network.name)) {
    await verify(registryAddress, [OWNER, MANAGER], receipt)
  } else {
    console.log(`Run on developer network, verification is skipped`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
