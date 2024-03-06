import { assert } from 'chai'
import { ethers, network } from 'hardhat'

import fmt from '../utils/format'
import { confirmOrAbort } from '../utils/prompt'
import { getDeployer, verify, waitForDeployment } from '../utils/deployment'
import { StonksFactory__factory } from '../typechain-types'
import { StonksDeployedEvent } from '../typechain-types/contracts/factories/StonksFactory'

interface StonksConfig {
  tokenFrom: string
  tokenTo: string
  orderDurationInSeconds: bigint
  marginBasisPoints: bigint
  priceToleranceInBasisPoints: bigint
}

const AGENT = ''
const STONKS_FACTORY = ''
const AMOUNT_CONVERTER = ''
const MANAGER_ADDRESS = ''
const STONKS_CONFIGS: Record<string, StonksConfig> = {}

assert(ethers.isAddress(AGENT), 'AGENT is not a valid address')
assert(ethers.isAddress(STONKS_FACTORY), 'STONKS_FACTORY is not a valid address')
assert(ethers.isAddress(AMOUNT_CONVERTER), 'AMOUNT_CONVERTER is not a valid address')
assert(Object.values(STONKS_CONFIGS).length > 0, 'STONKS_CONFIGS is empty')

async function main() {
  // prettier-ignore
  console.log(
    `Preparing for ${fmt.name('Stonks')} contracts deployment on "${fmt.network(network.name)}" network,`,
    `using the ${fmt.name("StonksFactory")} on address ${fmt.address(STONKS_FACTORY)} ...\n`
  )

  const deployer = await getDeployer()

  const entries = Object.entries(STONKS_CONFIGS)
  for (let i = 0; i < entries.length; ++i) {
    const [pair, config] = entries[i]
    console.log(`${i + 1}. Deploy config for pair ${fmt.name(pair)}:`)
    console.log(`  * token from: ${fmt.value(config.tokenFrom)}`)
    console.log(`  * token to: ${fmt.value(config.tokenTo)}`)
    console.log(`  * order duration (sec): ${fmt.value(config.orderDurationInSeconds)}`)
    console.log(`  * margin (bps): ${fmt.value(config.marginBasisPoints)}`)
    console.log(`  * price tolerance (bps): ${fmt.value(config.priceToleranceInBasisPoints)}`)
    console.log()
  }

  await confirmOrAbort()

  const factory = StonksFactory__factory.connect(STONKS_FACTORY, deployer)
  const orderSample = await factory.ORDER_SAMPLE()

  for (let i = 0; i < entries.length; ++i) {
    const [pair, config] = entries[i]
    console.log(`${i + 1}/${entries.length}. Deploying pair ${fmt.name(pair)}...`)
    const tx = await factory.deployStonks(
      MANAGER_ADDRESS,
      config.tokenFrom,
      config.tokenTo,
      AMOUNT_CONVERTER,
      config.orderDurationInSeconds,
      config.marginBasisPoints,
      config.priceToleranceInBasisPoints
    )
    const receipt = await waitForDeployment(tx)

    const stonksDeployedLog = receipt!.logs.find(
      (log) => log.topics[0] === factory.getEvent('StonksDeployed').fragment.topicHash
    ) as StonksDeployedEvent.Log | undefined

    if (!stonksDeployedLog) {
      throw new Error(`StonksDeployed event is not found in the deploy tx`)
    }

    const {
      stonksAddress,
      agent,
      manager,
      tokenFrom,
      tokenTo,
      amountConverter,
      order,
      orderDurationInSeconds,
      marginInBasisPoints,
      priceToleranceInBasisPoints,
    } = stonksDeployedLog.args

    console.log(
      [
        `The ${fmt.name('Stonks')} instance for the pair ${fmt.name(pair)}`,
        `was deployed successfully: ${fmt.address(stonksAddress)}\n`,
      ].join(' ')
    )
    if (!['localhost', 'hardhat'].includes(network.name)) {
      await verify(
        stonksAddress,
        [
          agent,
          manager,
          tokenFrom,
          tokenTo,
          amountConverter,
          orderSample,
          orderDurationInSeconds,
          marginInBasisPoints,
          priceToleranceInBasisPoints,
        ],
        receipt
      )
    } else {
      console.log(`Deployed on the local hardhat network, verification is skipped.`)
    }

    assert.equal(agent.toLowerCase(), AGENT.toLowerCase())
    assert.equal(manager.toLowerCase(), MANAGER_ADDRESS.toLowerCase())
    assert.equal(tokenFrom.toLowerCase(), config.tokenFrom.toLowerCase())
    assert.equal(tokenTo.toLowerCase(), config.tokenTo.toLowerCase())
    assert.equal(amountConverter.toLowerCase(), AMOUNT_CONVERTER.toLowerCase())
    assert.equal(order.toLowerCase(), orderSample.toLowerCase())
    assert.equal(orderDurationInSeconds, config.orderDurationInSeconds)
    assert.equal(marginInBasisPoints, config.marginBasisPoints)
    assert.equal(priceToleranceInBasisPoints, config.priceToleranceInBasisPoints)

    console.log()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
