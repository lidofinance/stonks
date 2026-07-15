import { assert } from 'chai'
import { ethers, network } from 'hardhat'

import fmt from '../utils/format'
import { confirmOrAbort } from '../utils/prompt'
import { getDeployer, saveDeployment, verify, waitForDeployment } from '../utils/deployment'
import { StakingRevenueSource__factory } from '../typechain-types'

// OracleRouter from Stonks v2 deploy
const ORACLE_ROUTER = '0x79ef3a538200Fe4981D67E7e886bfb36D4Cb5a31'

const LIDO_LOCATOR = '0xC1d0b3DE6792Bf6b4b37EccdcC24e45978Cfd2Eb'

assert(ethers.isAddress(ORACLE_ROUTER), 'ORACLE_ROUTER is not a valid address')
assert(ethers.isAddress(LIDO_LOCATOR), 'LIDO_LOCATOR is not a valid address')

async function main() {
  // prettier-ignore
  console.log(
    `Preparing for ${fmt.name('StakingRevenueSource')} deployment on "${fmt.network(network.name)}" network...\n`
  )

  const deployer = await getDeployer()

  console.log(`Deployment parameters:`)
  console.log(`  * ${fmt.name('OracleRouter')} address: ${fmt.value(ORACLE_ROUTER)}`)
  console.log(`  * ${fmt.name('LidoLocator')} address: ${fmt.value(LIDO_LOCATOR)}`)
  console.log()

  await confirmOrAbort('Proceed?')

  const stakingRevenueSource = await new StakingRevenueSource__factory(deployer).deploy(
    ORACLE_ROUTER,
    LIDO_LOCATOR
  )

  const receipt = await waitForDeployment(stakingRevenueSource.deploymentTransaction()!)
  const stakingRevenueSourceAddress = await stakingRevenueSource.getAddress()

  // prettier-ignore
  console.log(
    `The ${fmt.name('StakingRevenueSource')} contract was deployed successfully: ${fmt.address(stakingRevenueSourceAddress)}\n`
  )

  saveDeployment('stakingRevenueSource', {
    contract: 'contracts/automated-buybacks/revenue/StakingRevenueSource.sol',
    address: stakingRevenueSourceAddress,
    deployTx: receipt.hash,
    constructorArgs: [ORACLE_ROUTER, LIDO_LOCATOR],
  })

  if (!['localhost', 'hardhat'].includes(network.name)) {
    await verify(stakingRevenueSourceAddress, [ORACLE_ROUTER, LIDO_LOCATOR], receipt)
  } else {
    console.log(`Deployed on the local hardhat network, verification is skipped.`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
