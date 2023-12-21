import { assert } from 'chai'
import { network } from 'hardhat'

import fmt from '../utils/format'
import { confirmOrAbort } from '../utils/prompt'
import { getDeployer, verify } from '../utils/deployment'
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

async function main() {
  // prettier-ignore
  console.log(
    `Preparing for ${fmt.name('Stonks')} contracts deployment on "${fmt.network(network.name)}" network,`,
    `using the ${fmt.name("StonksFactory")} on address ${fmt.address(STONKS_FACTORY)} ...\n`
  )

  const deployer = await getDeployer()

  for (const [pair, config] of Object.entries(STONKS_CONFIGS)) {
    console.log(`Deploy config for pair ${fmt.name(pair)}:`)
    console.log(`  * token from: ${fmt.value(config.tokenFrom)}`)
    console.log(`  * token to: ${fmt.value(config.tokenTo)}`)
    console.log(`  * order duration (sec): ${fmt.value(config.orderDurationInSeconds)}`)
    console.log(`  * margin (bps): ${fmt.value(config.marginBasisPoints)}`)
    console.log(`  * price tolerance (bps): ${fmt.value(config.priceToleranceInBasisPoints)}`)
    console.log()
  }

  await confirmOrAbort()

  const factory = StonksFactory__factory.connect(STONKS_FACTORY, deployer)
  const orderSample = await factory.orderSample()

  const entries = Object.entries(STONKS_CONFIGS)
  for (let i = 0; i < entries.length; ++i) {
    const [pair, config] = entries[i]
    console.log(`${i + 1}/${entries.length}. Deploying pair ${fmt.name(pair)}...`)
    const deployArgs = [
      MANAGER_ADDRESS,
      config.tokenFrom,
      config.tokenTo,
      AMOUNT_CONVERTER,
      config.orderDurationInSeconds,
      config.marginBasisPoints,
      config.priceToleranceInBasisPoints,
    ] as const
    const tx = await factory.deployStonks(...deployArgs)
    console.log(`The deployment tx hash: ${fmt.tx(tx.hash)}`)
    console.log('Waiting for confirmations...\n')

    const receipt = await tx.wait()
    const stonksDeployedLog = receipt!.logs.find(
      (log) => log.topics[0] === factory.getEvent('StonksDeployed').fragment.topicHash
    ) as StonksDeployedEvent.Log | undefined

    if (!stonksDeployedLog) {
      throw new Error(`StonksDeployed event is not found in the deploy tx`)
    }

    const {
      stonksAddress,
      agent,
      operator,
      tokenFrom,
      tokenTo,
      amountConverter,
      order,
      orderDurationInSeconds,
      marginBasisPoints,
      priceToleranceInBasisPoints,
    } = stonksDeployedLog.args

    console.log(
      [
        `The ${fmt.name('Stonks')} instance for the pair ${fmt.name(pair)}`,
        `was deployed successfully: ${fmt.address(stonksAddress)}\n`,
      ].join(' ')
    )
    if (network.name !== 'hardhat') {
      await verify(stonksAddress, deployArgs as unknown as unknown[])
    } else {
      console.log(`Deploying on the test network, verification is skipped.`)
    }

    assert.equal(agent.toLowerCase(), AGENT.toLowerCase())
    assert.equal(operator.toLowerCase(), MANAGER_ADDRESS.toLowerCase())
    assert.equal(tokenFrom.toLowerCase(), config.tokenFrom.toLowerCase())
    assert.equal(tokenTo.toLowerCase(), config.tokenTo.toLowerCase())
    assert.equal(amountConverter.toLowerCase(), AMOUNT_CONVERTER.toLowerCase())
    assert.equal(order.toLowerCase(), orderSample.toLowerCase())
    assert.equal(orderDurationInSeconds, config.orderDurationInSeconds)
    assert.equal(marginBasisPoints, config.marginBasisPoints)
    assert.equal(priceToleranceInBasisPoints, config.priceToleranceInBasisPoints)

    console.log()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
