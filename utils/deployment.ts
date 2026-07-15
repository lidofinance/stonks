import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

import fmt from './format'
import { ContractTransactionResponse, ContractTransactionReceipt, TransactionReceipt } from 'ethers'
import { ethers, run, network } from 'hardhat'

type DeploymentEntry = {
  contract: string
  address: string
  deployTx?: string
  constructorArgs?: unknown[]
}

// Records a deployment in deployed-<network>.json
export function saveDeployment(name: string, entry: DeploymentEntry) {
  const file = join(__dirname, '..', `deployed-${network.name}.json`)
  const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}

  current[name] = {
    implementation: {
      contract: entry.contract,
      address: entry.address,
      ...(entry.deployTx ? { deployTx: entry.deployTx } : {}),
      constructorArgs: entry.constructorArgs ?? [],
    },
  }
  // store bigint as a decimal string since it's not JSON-serializable
  const replacer = (_: string, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value

  writeFileSync(file, JSON.stringify(current, replacer, 2) + '\n')
  console.log(`Recorded ${fmt.name(name)} in ${fmt.value(`deployed-${network.name}.json`)}`)
}

export async function getDeployer() {
  // the first address is the deployer account. See the hardhat.config.ts
  const [deployer] = await ethers.getSigners()

  if (!deployer) {
    throw new Error("Can't retrieve deployer. Accounts list is empty")
  }

  const [nonce, balance] = await Promise.all([
    deployer.getNonce(),
    ethers.provider.getBalance(deployer),
  ])

  console.log(`Deployer ${fmt.address(deployer.address)}:`)
  console.log(`  * nonce: ${fmt.value(nonce)}`)
  console.log(`  * balance: ${fmt.value(ethers.formatEther(balance) + ' ETH')}\n`)

  return deployer
}

export async function waitForDeployment(tx: ContractTransactionResponse) {
  console.log(`The deployment tx hash: ${fmt.tx(tx.hash)}`)
  console.log('Waiting for the inclusion...\n')
  const receipt = await tx.wait(1)
  return receipt!
}

export async function verify(
  address: string,
  args: unknown[],
  deployTx?: ContractTransactionReceipt
) {
  console.log(`Verifying contract ${fmt.address(address)} ...`)
  if (deployTx) {
    await waitForConfirmations(deployTx, 5)
  }
  try {
    await run('verify:verify', { address: address, constructorArguments: args })
  } catch (e: any) {
    if (e.message.toLowerCase().includes('already verified')) {
      console.log('Already verified!')
    } else {
      console.error('Verification failed:')
      console.error(e)
      console.log(`You can try to run verification manually:`)
      console.log(
        `npx hardhat verify --network ${network.name} ${address} ${args
          .map(formatArgument)
          .join(' ')}`
      )
    }
  }
}

function formatArgument(arg: unknown): string {
  return Array.isArray(arg) ? `[${arg.map((arg) => formatArgument(arg))}]` : `"${arg}"`
}

async function waitForConfirmations(
  receipt: ContractTransactionReceipt | TransactionReceipt,
  confirmations: number = 0
) {
  const currentBlockNumber = await receipt.provider.getBlockNumber()
  const targetBlockNumber = receipt.blockNumber + confirmations

  if (currentBlockNumber >= targetBlockNumber) return

  console.log(`Waiting for ${targetBlockNumber - currentBlockNumber} confirmations...`)
  await new Promise<void>((resolve) => {
    const blockMinedHandler = (blockNumber: number) => {
      if (blockNumber === targetBlockNumber) {
        receipt.provider.off('block', blockMinedHandler)
        return resolve()
      }
      console.log(`  ${targetBlockNumber - blockNumber} confirmations left`)
    }
    receipt.provider.on('block', blockMinedHandler)
  })
}
