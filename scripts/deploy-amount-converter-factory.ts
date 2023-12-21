import { network } from 'hardhat'

import fmt from '../utils/format'
import { AmountConverterFactory__factory } from '../typechain-types'
import { getDeployer, verify } from '../utils/deployment'
import { confirmOrAbort } from '../utils/prompt'

const CHAINLINK_PRICE_FEED_REGISTRY = ''

async function main() {
  // prettier-ignore
  console.log(
    `Preparing for ${fmt.name('AmountConverterFactory')} deployment on "${fmt.network(network.name)}" network...\n`
  )

  const deployer = await getDeployer()

  console.log(`Deployment parameters:`)
  console.log(`  * Price feed registry address: ${fmt.value(CHAINLINK_PRICE_FEED_REGISTRY)}`)

  await confirmOrAbort('Proceed?')

  const amountConverter = await new AmountConverterFactory__factory(deployer).deploy(
    CHAINLINK_PRICE_FEED_REGISTRY
  )

  console.log(`The deployment tx hash: ${fmt.tx(amountConverter.deploymentTransaction()!.hash)}`)
  console.log('Waiting for confirmations...\n')

  await amountConverter.waitForDeployment()

  const address = await amountConverter.getAddress()
  console.log(
    `The ${fmt.name('AmountConverterFactory')} was deployed successfully: ${fmt.address(address)}`
  )

  if (network.name !== 'hardhat') {
    await verify(address, [CHAINLINK_PRICE_FEED_REGISTRY])
  } else {
    console.log(`Deploying on the test network, verification is skipped.`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
