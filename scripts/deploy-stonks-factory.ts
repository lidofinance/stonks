import { assert } from 'chai'
import { network, ethers } from 'hardhat'

import fmt from '../utils/format'
import { confirmOrAbort } from '../utils/prompt'
import { StonksFactory__factory } from '../typechain-types'
import { getDeployer, verify, waitForDeployment } from '../utils/deployment'
import { OrderSampleDeployedEvent } from '../typechain-types/contracts/factories/StonksFactory'

const AGENT = ''
const COWSWAP_SETTLEMENT = ''
const COWSWAP_VAULT_RELAYER = ''

assert(ethers.isAddress(AGENT), 'AGENT is not a valid address')
assert(ethers.isAddress(COWSWAP_SETTLEMENT), 'COWSWAP_SETTLEMENT is not a valid address')
assert(ethers.isAddress(COWSWAP_VAULT_RELAYER), 'COWSWAP_VAULT_RELAYER is not a valid address')

async function main() {
  // prettier-ignore
  console.log(
    `Preparing for ${fmt.name('StonksFactory')} deployment on "${fmt.network(network.name)}" network...\n`
  )

  const deployer = await getDeployer()

  console.log(`Deployment parameters:`)
  console.log(`  * ${fmt.name('Agent')} address: ${fmt.value(AGENT)}`)
  console.log(`  * ${fmt.name('CoWSwapSettlement')} address: ${fmt.value(COWSWAP_SETTLEMENT)}`)
  console.log(
    `  * ${fmt.name('CoWSwapVaultRelayer')} address: ${fmt.value(COWSWAP_VAULT_RELAYER)}\n`
  )

  await confirmOrAbort('Proceed?')

  const stonksFactory = await new StonksFactory__factory(deployer).deploy(
    AGENT,
    COWSWAP_SETTLEMENT,
    COWSWAP_VAULT_RELAYER
  )

  const receipt = await waitForDeployment(stonksFactory.deploymentTransaction()!)

  const orderSampleDeployedLog = receipt.logs.find(
    (log) => log.topics[0] === stonksFactory.interface.getEvent('OrderSampleDeployed').topicHash
  )

  if (!orderSampleDeployedLog) {
    throw new Error('OrderSample event not found in the deploy tx')
  }

  const orderSampleDeployedLogDescription = stonksFactory.interface.parseLog(
    orderSampleDeployedLog as any
  ) as OrderSampleDeployedEvent.LogDescription | null

  if (!orderSampleDeployedLogDescription) {
    throw new Error('Failed to parse OrderSampleDeployed event')
  }

  const { orderAddress } = orderSampleDeployedLogDescription.args

  const stonksFactoryAddress = await stonksFactory.getAddress()
  // prettier-ignore
  console.log(
    `The ${fmt.name('StonksFactory')} contract was deployed successfully: ${fmt.address(stonksFactoryAddress)}\n`
  )
  console.log(
    `Sample of the ${fmt.name('Order')} contract was deployed at ${fmt.address(orderAddress)}\n`
  )
  if (!['localhost', 'hardhat'].includes(network.name)) {
    await verify(stonksFactoryAddress, [AGENT, COWSWAP_SETTLEMENT, COWSWAP_VAULT_RELAYER], receipt)
  } else {
    console.log(`Deployed on the local hardhat network, verification is skipped.`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
