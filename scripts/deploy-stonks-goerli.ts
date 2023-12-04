import { ethers, network } from 'hardhat'
import { goerli } from '../utils/contracts'

const AMOUNT_CONVERTER_ADDRESS = '0x26eef32497909Bb27E9B40091246c0aA39d1A7dB'
const MANAGER = '0xc4094c015666CBC093FffDC9BB3CF077a864ddB3'

async function main() {
  const orderFactory = await ethers.getContractFactory('Order')
  const stonksFactory = await ethers.getContractFactory('Stonks')

  const order = await orderFactory.deploy(
    goerli.AGENT,
    goerli.SETTLEMENT,
    goerli.VAULT_RELAYER
  )
  await order.waitForDeployment()
  const orderAddress = await order.getAddress()

  console.log(`Order deployed at ${orderAddress}`)
  console.log(`For verification, please run the following command:`)
  console.log(
    `npx hardhat verify --network ${
      network.name
    } ${orderAddress} "${goerli.AGENT}" "${goerli.SETTLEMENT}" "${
      goerli.VAULT_RELAYER
    }"`
  )

  const stonks = await stonksFactory.deploy(
    goerli.AGENT,
    MANAGER,
    goerli.WETH,
    goerli.UNI,
    AMOUNT_CONVERTER_ADDRESS,
    orderAddress,
    3600,
    500,
    999
  )
  await stonks.waitForDeployment()

  console.log(`Stonks deployed at ${await stonks.getAddress()}`)
  console.log(`For verification, please run the following command:`)
  console.log(
    `npx hardhat verify --network ${
      network.name
    } ${await stonks.getAddress()} "${goerli.AGENT}" "${MANAGER}" "${
      goerli.WETH
    }" "${
      goerli.UNI
    }" "${AMOUNT_CONVERTER_ADDRESS}" "${order}" 3600 500 999`
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
