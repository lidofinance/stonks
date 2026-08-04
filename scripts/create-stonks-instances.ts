import { assert } from 'chai'
import { ethers, network } from 'hardhat'

import fmt from '../utils/format'
import { confirmOrAbort } from '../utils/prompt'
import { getDeployer, saveDeployment, verify, waitForDeployment } from '../utils/deployment'
import { StonksFactory__factory } from '../typechain-types'
import { StonksDeployedEvent } from '../typechain-types/contracts/factories/StonksFactory'
import { setTimeout } from 'timers/promises'
import { AMOUNT_CONVERTER_ADDRESS, STONKS_PARAMS } from './nest-parameters'

interface StonksConfig {
  tokenFrom: string
  tokenTo: string
  orderDurationInSeconds: bigint
  marginBasisPoints: bigint
  priceToleranceInBasisPoints: bigint
  maxImprovementInBasisPoints: bigint
  allowPartialFill: boolean
  receiver: string
}

const ADMIN = '0x2e59A20f205bB85a89C53f1936454680651E618e' // Aragon Voting
const AGENT = '0x3e40D73EB977Dc6a537aF587D48316feE66E9C8c' // Aragon Agent
const STONKS_FACTORY = '' // TODO: deployed StonksFactory
const AMOUNT_CONVERTER = AMOUNT_CONVERTER_ADDRESS
const MANAGER_ADDRESS = '' // TODO: deployed BuybackExecutor

const STETH = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84'
const LDO = '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32'

// Trade parameters sourced from the shared deploy plan in nest-parameters.ts.
const TRADE_PARAMS = {
  tokenFrom: STETH,
  tokenTo: LDO,
  orderDurationInSeconds: STONKS_PARAMS.orderDurationInSeconds,
  marginBasisPoints: STONKS_PARAMS.marginInBasisPoints,
  priceToleranceInBasisPoints: STONKS_PARAMS.priceToleranceInBasisPoints,
  maxImprovementInBasisPoints: STONKS_PARAMS.maxImprovementInBasisPoints,
  allowPartialFill: STONKS_PARAMS.allowPartialFill,
}

const STONKS_CONFIGS: Record<string, StonksConfig> = {
  // receiver == manager (the executor) => LP mode
  buybackStonksLp: {
    ...TRADE_PARAMS,
    receiver: MANAGER_ADDRESS,
  },
  // receiver == Aragon Agent => treasury mode, the launch instance
  buybackStonksTreasury: {
    ...TRADE_PARAMS,
    receiver: AGENT,
  },
}

assert(ethers.isAddress(ADMIN), 'ADMIN is not a valid address')
assert(ethers.isAddress(AGENT), 'AGENT is not a valid address')
assert(ethers.isAddress(STONKS_FACTORY), 'STONKS_FACTORY is not a valid address')
assert(ethers.isAddress(AMOUNT_CONVERTER), 'AMOUNT_CONVERTER is not a valid address')
assert(ethers.isAddress(MANAGER_ADDRESS), 'MANAGER_ADDRESS is not a valid address')
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
    console.log(`  * max improvement (bps): ${fmt.value(config.maxImprovementInBasisPoints)}`)
    console.log(`  * allow partial fill: ${fmt.value(config.allowPartialFill)}`)
    console.log(`  * receiver: ${fmt.value(config.receiver)}`)
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
      config.priceToleranceInBasisPoints,
      config.maxImprovementInBasisPoints,
      config.allowPartialFill,
      config.receiver
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
      admin,
      manager,
      tokenFrom,
      tokenTo,
      amountConverter,
      order,
      orderDurationInSeconds,
      marginInBasisPoints,
      priceToleranceInBasisPoints,
      maxImprovementInBasisPoints,
      allowPartialFill,
      receiver,
    } = stonksDeployedLog.args

    console.log(
      [
        `The ${fmt.name('Stonks')} instance for the pair ${fmt.name(pair)}`,
        `was deployed successfully: ${fmt.address(stonksAddress)}\n`,
      ].join(' ')
    )

    saveDeployment(pair, {
      contract: 'contracts/Stonks.sol',
      address: stonksAddress,
      deployTx: receipt.hash,
      constructorArgs: [
        {
          admin,
          agent,
          manager,
          tokenFrom,
          tokenTo,
          amountConverter,
          orderSample,
          orderDurationInSeconds,
          marginInBasisPoints,
          priceToleranceInBasisPoints,
          maxImprovementInBasisPoints,
          allowPartialFill,
          receiver,
        },
      ],
    })

    console.log('Waiting for 15 seconds to let Etherscan index the new contract...')

    await setTimeout(15000)

    if (!['localhost', 'hardhat'].includes(network.name)) {
      await verify(
        stonksAddress,
        [
          {
            admin,
            agent,
            manager,
            tokenFrom,
            tokenTo,
            amountConverter,
            orderSample,
            orderDurationInSeconds,
            marginInBasisPoints,
            priceToleranceInBasisPoints,
            maxImprovementInBasisPoints,
            allowPartialFill,
            receiver,
          },
        ],
        receipt
      )
    } else {
      console.log(`Deployed on the local hardhat network, verification is skipped.`)
    }

    assert.equal(agent.toLowerCase(), AGENT.toLowerCase())
    assert.equal(admin.toLowerCase(), ADMIN.toLowerCase())
    assert.equal(manager.toLowerCase(), MANAGER_ADDRESS.toLowerCase())
    assert.equal(tokenFrom.toLowerCase(), config.tokenFrom.toLowerCase())
    assert.equal(tokenTo.toLowerCase(), config.tokenTo.toLowerCase())
    assert.equal(amountConverter.toLowerCase(), AMOUNT_CONVERTER.toLowerCase())
    assert.equal(order.toLowerCase(), orderSample.toLowerCase())
    assert.equal(orderDurationInSeconds.toString(), config.orderDurationInSeconds.toString())
    assert.equal(marginInBasisPoints.toString(), config.marginBasisPoints.toString())
    assert.equal(
      priceToleranceInBasisPoints.toString(),
      config.priceToleranceInBasisPoints.toString()
    )
    assert.equal(allowPartialFill, config.allowPartialFill)

    console.log()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
