import { ethers, network } from 'hardhat'
import { consola } from 'consola'
import { mainnet } from '../utils/contracts'

async function main() {
  const config = mainnet
  const stonksContractFactory = await ethers.getContractFactory('StonksFactory')
  const amountConverterContractFactory = await ethers.getContractFactory('AmountConverterFactory')

  consola.warn('Deploying StonksFactory contract...')

  consola.info(`Please verify the following addresses are correct:`)
  consola.info(`Agent address: ${config.AGENT}`)
  consola.info(`Settlement address: ${config.SETTLEMENT}`)
  consola.info(`VaultRelayer address: ${config.VAULT_RELAYER}`)

  await consola.prompt('Proceed?', {
    type: 'confirm',
  })

  const stonksFactory = await stonksContractFactory.deploy(config.AGENT, config.SETTLEMENT, config.VAULT_RELAYER)
  await stonksFactory.waitForDeployment()
  const stonksAddress = await stonksFactory.getAddress()
  
  consola.success(`StonksFactory contract deployed at ${stonksAddress}`)
  consola.info(`For verification, please run the following command:`)
  consola.info(
    `npx hardhat verify --network ${network.name} ${stonksAddress} "${config.AGENT}" "${config.SETTLEMENT}" "${config.VAULT_RELAYER}"`
  )

  consola.warn('Deploying AmountConverterFactory contract...')
  consola.info(`Please verify the following addresses are correct:`)
  consola.info(`Price feed registry address: ${config.CHAINLINK_PRICE_FEED_REGISTRY}`)

  await consola.prompt('Proceed?', {
    type: 'confirm',
  })

  const amountConverter = await amountConverterContractFactory.deploy(config.CHAINLINK_PRICE_FEED_REGISTRY)
  await amountConverter.waitForDeployment()
  const amountConverterAddress = await amountConverter.getAddress()

  consola.success(`AmountConverterFactory contract deployed at ${amountConverterAddress}`)
  consola.info(`For verification, please run the following command:`)
  consola.info(
    `npx hardhat verify --network ${network.name} ${amountConverterAddress} "${config.CHAINLINK_PRICE_FEED_REGISTRY}"`
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
