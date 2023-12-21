import fmt from './format'
import { ethers, run, network } from 'hardhat'

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

export async function verify(address: string, args: unknown[]) {
  console.log(`Verifying contract ${fmt.address(address)} ...`)
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
