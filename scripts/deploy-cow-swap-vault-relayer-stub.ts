import { assert } from 'chai'
import { ethers, network } from 'hardhat'

import fmt from '../utils/format'
import { confirmOrAbort } from '../utils/prompt'
import { getDeployer, verify, waitForDeployment } from '../utils/deployment'
import { CoWSwapVaultRelayerStub__factory } from '../typechain-types/factories/contracts/stubs/CoWSwapVaultRelayerStub.sol'

const OWNER: string = ''
const MANAGER: string = ethers.ZeroAddress

assert(ethers.isAddress(OWNER), 'OWNER address is invalid')
assert(ethers.isAddress(MANAGER), 'MANAGER address is invalid')

async function main() {
  // prettier-ignore
  console.log(
    `Preparing for ${fmt.name('CoWSwapVaultRelayerStub')} deployment on "${fmt.network(network.name)}" network...\n`
  )

  const deployer = await getDeployer()

  console.log(`Deployment parameters:`)
  console.log(`  * ${fmt.name('Owner')} address: ${fmt.value(OWNER)}`)
  console.log(`  * ${fmt.name('Manager')} address: ${fmt.value(MANAGER)}`)

  await confirmOrAbort()

  const relayer = await new CoWSwapVaultRelayerStub__factory(deployer).deploy(OWNER, MANAGER)

  const receipt = await waitForDeployment(relayer.deploymentTransaction()!)
  const relayerAddress = await relayer.getAddress()

  console.log(`${fmt.name('CoWSwapVaultRelayerStub')} deployed at ${fmt.address(relayerAddress)}`)

  if (!['localhost', 'hardhat'].includes(network.name)) {
    await verify(relayerAddress, [OWNER, MANAGER], receipt)
  } else {
    console.log(`Run on developer network, verification is skipped`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
