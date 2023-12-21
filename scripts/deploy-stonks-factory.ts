import { ethers, network } from 'hardhat'

import fmt from '../utils/format'
import { confirmOrAbort } from '../utils/prompt'
import { StonksFactory__factory } from '../typechain-types'
import { getDeployer, verify } from '../utils/deployment'
import { OrderSampleDeployedEvent } from '../typechain-types/contracts/factories/StonksFactory'

const AGENT = ''
const SETTLEMENT = ''
const VAULT_RELAYER = ''

async function main() {
  // prettier-ignore
  console.log(
    `Preparing for ${fmt.name('StonksFactory')} deployment on "${fmt.network(network.name)}" network...\n`
  )

  const deployer = await getDeployer()

  console.log(`Deployment parameters:`)
  console.log(`  * ${fmt.name('Agent')} address: ${fmt.value(AGENT)}`)
  console.log(`  * ${fmt.name('Settlement')} address: ${fmt.value(SETTLEMENT)}`)
  console.log(`  * ${fmt.name('VaultRelayer')} address: ${fmt.value(VAULT_RELAYER)}\n`)

  await confirmOrAbort('Proceed?')

  const stonksFactory = await new StonksFactory__factory(deployer).deploy(
    AGENT,
    SETTLEMENT,
    VAULT_RELAYER
  )

  const deployTxHash = stonksFactory.deploymentTransaction()!.hash
  console.log(`The deployment tx hash: ${fmt.tx(deployTxHash)}`)
  console.log('Waiting for confirmations...\n')

  await stonksFactory.waitForDeployment()
  const deployReceipt = await ethers.provider.getTransactionReceipt(deployTxHash)
  const orderSampleDeployedLog = deployReceipt!.logs.find(
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

  const stonksAddress = await stonksFactory.getAddress()
  // prettier-ignore
  console.log(
    `The ${fmt.name('StonksFactory')} contract was deployed successfully: ${fmt.address(stonksAddress)}\n`
  )
  console.log(
    `Sample of the ${fmt.name('Order')} contract was deployed at ${fmt.address(orderAddress)}\n`
  )
  if (network.name !== 'hardhat') {
    await verify(stonksAddress, [AGENT, SETTLEMENT, VAULT_RELAYER])
    await verify(orderAddress, [AGENT, SETTLEMENT, VAULT_RELAYER])
  } else {
    console.log(`Deploying on the test network, verification is skipped.`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
