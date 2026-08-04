import { assert } from 'chai'
import { network, ethers } from 'hardhat'

import fmt from '../utils/format'
import { confirmOrAbort } from '../utils/prompt'
import { StonksFactory__factory } from '../typechain-types'
import { getDeployer, saveDeployment, verify, waitForDeployment } from '../utils/deployment'
import { OrderSampleDeployedEvent } from '../typechain-types/contracts/factories/StonksFactory'

const ADMIN = '0x2e59A20f205bB85a89C53f1936454680651E618e' // Aragon Voting
const AGENT = '0x3e40D73EB977Dc6a537aF587D48316feE66E9C8c' // Aragon Agent
const COWSWAP_SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41'
const COWSWAP_VAULT_RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110'
assert(ethers.isAddress(ADMIN), 'ADMIN is not a valid address')
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
  console.log(`  * ${fmt.name('Admin')} address: ${fmt.value(ADMIN)}`)
  console.log(`  * ${fmt.name('Agent')} address: ${fmt.value(AGENT)}`)
  console.log(`  * ${fmt.name('CoWSwapSettlement')} address: ${fmt.value(COWSWAP_SETTLEMENT)}`)
  console.log(`  * ${fmt.name('CoWSwapVaultRelayer')} address: ${fmt.value(COWSWAP_VAULT_RELAYER)}`)
  console.log()

  await confirmOrAbort('Proceed?')

  const stonksFactory = await new StonksFactory__factory(deployer).deploy(
    ADMIN,
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

  const { order } = orderSampleDeployedLogDescription.args

  const stonksFactoryAddress = await stonksFactory.getAddress()
  // prettier-ignore
  console.log(
    `The ${fmt.name('StonksFactory')} contract was deployed successfully: ${fmt.address(stonksFactoryAddress)}\n`
  )
  console.log(`Sample of the ${fmt.name('Order')} contract was deployed at ${fmt.address(order)}\n`)

  // Get domainSeparator from the CoWSwapSettlement contract, which is needed for the Order constructor
  const settlement = new ethers.Contract(
    COWSWAP_SETTLEMENT,
    ['function domainSeparator() view returns (bytes32)'],
    deployer
  )
  const domainSeparator = await settlement.domainSeparator()

  saveDeployment('stonksFactory', {
    contract: 'contracts/factories/StonksFactory.sol',
    address: stonksFactoryAddress,
    deployTx: receipt.hash,
    constructorArgs: [ADMIN, AGENT, COWSWAP_SETTLEMENT, COWSWAP_VAULT_RELAYER],
  })
  saveDeployment('orderSample', {
    contract: 'contracts/Order.sol',
    address: order,
    deployTx: receipt.hash,
    constructorArgs: [ADMIN, AGENT, COWSWAP_VAULT_RELAYER, domainSeparator],
  })

  if (!['localhost', 'hardhat'].includes(network.name)) {
    await verify(
      stonksFactoryAddress,
      [ADMIN, AGENT, COWSWAP_SETTLEMENT, COWSWAP_VAULT_RELAYER],
      receipt
    )
  } else {
    console.log(`Deployed on the local hardhat network, verification is skipped.`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
