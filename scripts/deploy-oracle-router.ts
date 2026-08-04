import { assert } from 'chai'
import { ethers, network } from 'hardhat'

import fmt from '../utils/format'
import { confirmOrAbort } from '../utils/prompt'
import { getDeployer, verify, waitForDeployment } from '../utils/deployment'
import { OracleRouter__factory } from '../typechain-types'

// https://docs.lido.fi/deployed-contracts/#dao-contracts
const ADMIN = ''

// https://docs.chain.link/data-feeds/feed-registry#contract-addresses
const CHAINLINK_PRICE_FEED_REGISTRY = ''

assert(ethers.isAddress(ADMIN), 'ADMIN is not a valid address')
assert(
  ethers.isAddress(CHAINLINK_PRICE_FEED_REGISTRY),
  'CHAINLINK_PRICE_FEED_REGISTRY is not a valid address'
)

async function main() {
  // prettier-ignore
  console.log(
    `Preparing for ${fmt.name('OracleRouter')} deployment on "${fmt.network(network.name)}" network...\n`
  )

  const deployer = await getDeployer()

  console.log(`Deployment parameters:`)
  console.log(`  * ${fmt.name('Admin')} address: ${fmt.value(ADMIN)}`)
  console.log(
    `  * ${fmt.name('ChainlinkPriceFeedRegistry')} address: ${fmt.value(
      CHAINLINK_PRICE_FEED_REGISTRY
    )}`
  )
  console.log()

  await confirmOrAbort('Proceed?')

  const oracleRouter = await new OracleRouter__factory(deployer).deploy(
    ADMIN,
    CHAINLINK_PRICE_FEED_REGISTRY
  )

  const receipt = await waitForDeployment(oracleRouter.deploymentTransaction()!)
  const oracleRouterAddress = await oracleRouter.getAddress()

  console.log(
    `The ${fmt.name('OracleRouter')} contract was deployed successfully: ${fmt.address(
      oracleRouterAddress
    )}\n`
  )

  if (!['localhost', 'hardhat'].includes(network.name)) {
    await verify(oracleRouterAddress, [ADMIN, CHAINLINK_PRICE_FEED_REGISTRY], receipt)
  } else {
    console.log(`Deployed on the local hardhat network, verification is skipped.`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
