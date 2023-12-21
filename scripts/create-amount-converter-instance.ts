import { assert } from 'chai'
import { ethers, network } from 'hardhat'

import fmt from '../utils/format'
import { confirmOrAbort } from '../utils/prompt'
import { getDeployer, verify } from '../utils/deployment'
import { AmountConverterFactory__factory } from '../typechain-types'
import { AmountConverterDeployedEvent } from '../typechain-types/contracts/factories/AmountConverterFactory'

const AMOUNT_CONVERTER_FACTORY = ''

const CONVERSION_TARGET = ''
const ALLOWED_TOKENS_TO_SELL: string[] = []
const ALLOWED_TOKENS_TO_BUY: string[] = []

const PRICE_FEEDS_HEARTBEAT_TIMEOUTS: bigint[] = []

assert(ethers.isAddress(AMOUNT_CONVERTER_FACTORY), "AMOUNT_CONVERTER_FACTORY isn't set")
assert(ethers.isAddress(CONVERSION_TARGET), `Invalid conversion target value`)
assert(ALLOWED_TOKENS_TO_SELL.length > 0, 'Allowed tokens to sell is empty')
assert(ALLOWED_TOKENS_TO_BUY.length > 0, 'Allowed tokens to buy is empty')
assert(
  ALLOWED_TOKENS_TO_SELL.length === PRICE_FEEDS_HEARTBEAT_TIMEOUTS.length,
  'Allowed tokens to sell and heartbeat timeouts length mismatch'
)

async function main() {
  // prettier-ignore
  console.log(
      `Preparing for ${fmt.name('AmountConverter')} deployment on "${fmt.network(network.name)}" network,`,
      `using the ${fmt.name("AmountConverterFactory")} on address ${fmt.address(AMOUNT_CONVERTER_FACTORY)} ...\n`
  )

  const deployer = await getDeployer()

  console.log(`Deployment parameters:`)
  console.log(`  * Conversion target: ${fmt.value(CONVERSION_TARGET)}`)
  console.log(
    `  * Allowed tokens to sell: ${fmt.value('[' + ALLOWED_TOKENS_TO_SELL.join(', ') + ']')}`
  )
  console.log(
    `  * Allowed tokens to buy: ${fmt.value('[' + ALLOWED_TOKENS_TO_BUY.join(', ') + ']')}`
  )
  console.log(
    `  * Price feeds heartbeat timeouts: ${fmt.value(
      '[' + PRICE_FEEDS_HEARTBEAT_TIMEOUTS.join(', ') + ']'
    )}`
  )

  await confirmOrAbort('Proceed?')

  const factory = AmountConverterFactory__factory.connect(AMOUNT_CONVERTER_FACTORY, deployer)

  const tx = await factory.deployAmountConverter(
    CONVERSION_TARGET,
    ALLOWED_TOKENS_TO_SELL,
    ALLOWED_TOKENS_TO_BUY,
    PRICE_FEEDS_HEARTBEAT_TIMEOUTS
  )

  console.log(`The deployment tx hash: ${fmt.tx(tx.hash)}`)
  console.log('Waiting for confirmations...\n')
  const receipt = await tx.wait()

  const amountConverterDeployedLog = receipt!.logs.find(
    (log) => log.topics[0] === factory.getEvent('AmountConverterDeployed').fragment.topicHash
  ) as AmountConverterDeployedEvent.Log | undefined

  if (!amountConverterDeployedLog) {
    throw new Error(`AmountConverterDeployed event is not found in the deploy tx`)
  }

  const {
    amountConverterAddress,
    conversionTarget,
    allowedTokensToSell,
    allowedStableTokensToBuy,
    priceFeedsHeartbeatTimeouts,
  } = amountConverterDeployedLog.args

  // prettier-ignore
  console.log(
    `The ${fmt.name('AmountConverter')} instance was deployed successfully: ${fmt.address(amountConverterAddress)}\n`
  )

  if (network.name !== 'hardhat') {
    await verify(amountConverterAddress, [
      CONVERSION_TARGET,
      ALLOWED_TOKENS_TO_SELL,
      ALLOWED_TOKENS_TO_BUY,
      PRICE_FEEDS_HEARTBEAT_TIMEOUTS,
    ])
  } else {
    console.log(`Deploying on the test network, verification is skipped.`)
  }

  assert.equal(conversionTarget.toLowerCase(), CONVERSION_TARGET.toLowerCase())
  assert.deepEqual(
    allowedTokensToSell.map((a) => a.toLowerCase()),
    ALLOWED_TOKENS_TO_SELL.map((a) => a.toLowerCase())
  )
  assert.deepEqual(
    allowedStableTokensToBuy.map((a) => a.toLowerCase()),
    ALLOWED_TOKENS_TO_BUY.map((a) => a.toLowerCase())
  )
  assert.deepEqual(priceFeedsHeartbeatTimeouts, PRICE_FEEDS_HEARTBEAT_TIMEOUTS)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
