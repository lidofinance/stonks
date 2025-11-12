import { assert } from 'chai'
import { ethers, network } from 'hardhat'

import fmt from '../utils/format'
import { confirmOrAbort } from '../utils/prompt'
import { getDeployer, verify, waitForDeployment } from '../utils/deployment'
import { AmountConverterFactory__factory } from '../typechain-types'
import { AmountConverterDeployedEvent } from '../typechain-types/contracts/factories/AmountConverterFactory'

const AMOUNT_CONVERTER_FACTORY = ''

const ORACLE_ROUTER = ''
const ALLOWED_TOKENS_TO_SELL: string[] = []
const ALLOWED_TOKENS_TO_BUY: string[] = []
const USE_ETH_ANCHOR = false

assert(
  ethers.isAddress(AMOUNT_CONVERTER_FACTORY),
  'AMOUNT_CONVERTER_FACTORY is not a valid address'
)
assert(ethers.isAddress(ORACLE_ROUTER), `ORACLE_ROUTER is not a valid address`)
assert(ALLOWED_TOKENS_TO_SELL.length > 0, 'Allowed tokens to sell is empty')
assert(ALLOWED_TOKENS_TO_BUY.length > 0, 'Allowed tokens to buy is empty')

async function main() {
  // prettier-ignore
  console.log(
      `Preparing for ${fmt.name('AmountConverter')} deployment on "${fmt.network(network.name)}" network,`,
      `using the ${fmt.name("AmountConverterFactory")} on address ${fmt.address(AMOUNT_CONVERTER_FACTORY)} ...\n`
  )

  const deployer = await getDeployer()

  console.log(`Deployment parameters:`)
  console.log(`  * Oracle router: ${fmt.value(ORACLE_ROUTER)}`)
  console.log(
    `  * Allowed tokens to sell: ${fmt.value('[' + ALLOWED_TOKENS_TO_SELL.join(', ') + ']')}`
  )
  console.log(
    `  * Allowed tokens to buy: ${fmt.value('[' + ALLOWED_TOKENS_TO_BUY.join(', ') + ']')}`
  )
  console.log(`  * Use ETH anchor: ${fmt.value(USE_ETH_ANCHOR)}`)

  await confirmOrAbort('Proceed?')

  const factory = AmountConverterFactory__factory.connect(AMOUNT_CONVERTER_FACTORY, deployer)

  const tx = await factory.deployAmountConverter(ALLOWED_TOKENS_TO_SELL, ALLOWED_TOKENS_TO_BUY, USE_ETH_ANCHOR)

  const receipt = await waitForDeployment(tx)

  const amountConverterDeployedLog = receipt.logs.find(
    (log) => log.topics[0] === factory.getEvent('AmountConverterDeployed').fragment.topicHash
  ) as AmountConverterDeployedEvent.Log | undefined

  if (!amountConverterDeployedLog) {
    throw new Error(`AmountConverterDeployed event is not found in the deploy tx`)
  }

  const { amountConverterAddress, oracleRouter, allowedTokensToSell, allowedStableTokensToBuy } =
    amountConverterDeployedLog.args

  // prettier-ignore
  console.log(
    `The ${fmt.name('AmountConverter')} instance was deployed successfully: ${fmt.address(amountConverterAddress)}\n`
  )

  if (!['localhost', 'hardhat'].includes(network.name)) {
    await verify(
      amountConverterAddress,
      [ORACLE_ROUTER, ALLOWED_TOKENS_TO_SELL, ALLOWED_TOKENS_TO_BUY],
      receipt
    )
  } else {
    console.log(`Deployed on the local hardhat network, verification is skipped.`)
  }
  assert.equal(oracleRouter.toLowerCase(), ORACLE_ROUTER.toLowerCase())
  assert.deepEqual(
    allowedTokensToSell.map((a) => a.toLowerCase()),
    ALLOWED_TOKENS_TO_SELL.map((a) => a.toLowerCase())
  )
  assert.deepEqual(
    allowedStableTokensToBuy.map((a) => a.toLowerCase()),
    ALLOWED_TOKENS_TO_BUY.map((a) => a.toLowerCase())
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
