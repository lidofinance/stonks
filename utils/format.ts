import chalk from 'chalk'
import { ethers } from 'hardhat'

function address(address: string) {
  return chalk.cyan.underline(address)
}

function tx(hash: string) {
  return chalk.green.underline(hash)
}

function name(name: string) {
  return chalk.green.bold(name)
}

function network(network: string) {
  return chalk.bold.whiteBright(network)
}

function value(value: any) {
  return ethers.isAddress(value) ? chalk.blue.underline(value) : chalk.blue(value)
}

export default {
  tx,
  name,
  value,
  address,
  network,
}
