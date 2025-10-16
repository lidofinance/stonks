import { assert } from 'chai'
import { ethers, network } from 'hardhat'

import fmt from '../utils/format'
import { AmountConverterFactory__factory } from '../typechain-types'
import { getDeployer, verify, waitForDeployment } from '../utils/deployment'
import { confirmOrAbort } from '../utils/prompt'

const CHAINLINK_PRICE_FEED_REGISTRY = ''
const ORACLE_ROUTER = ''

assert(
  ethers.isAddress(CHAINLINK_PRICE_FEED_REGISTRY),
  'CHAINLINK_PRICE_FEED_REGISTRY is not a valid address'
)
assert(ethers.isAddress(ORACLE_ROUTER), 'ORACLE_ROUTER is not a valid address')

async function main() {
  // prettier-ignore
  console.log(
    `Preparing for ${fmt.name('AmountConverterFactory')} deployment on "${fmt.network(network.name)}" network...\n`
  )

  const deployer = await getDeployer()

  console.log(`Deployment parameters:`)
  console.log(`  * Price feed registry address: ${fmt.value(CHAINLINK_PRICE_FEED_REGISTRY)}`)
  console.log(`  * Oracle router address: ${fmt.value(ORACLE_ROUTER)}\n`)

  await confirmOrAbort('Proceed?')

  const amountConverter = await new AmountConverterFactory__factory(deployer).deploy(
    CHAINLINK_PRICE_FEED_REGISTRY,
    ORACLE_ROUTER
  )

  const receipt = await waitForDeployment(amountConverter.deploymentTransaction()!)

  const address = await amountConverter.getAddress()
  console.log(
    `The ${fmt.name('AmountConverterFactory')} was deployed successfully: ${fmt.address(address)}`
  )

  if (!['localhost', 'hardhat'].includes(network.name)) {
    await verify(address, [CHAINLINK_PRICE_FEED_REGISTRY, ORACLE_ROUTER], receipt)
  } else {
    console.log(`Deployed on the local hardhat network, verification is skipped.`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
