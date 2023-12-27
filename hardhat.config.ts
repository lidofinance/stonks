import { HardhatUserConfig } from 'hardhat/config'
import '@nomicfoundation/hardhat-toolbox'
import * as dotenv from 'dotenv'
import './utils/assert'

dotenv.config()

const MAINNET_RPC_URL = process.env.RPC_URL
const GOERLI_RPC_URL = process.env.GOERLI_RPC_URL
const HOLESKY_RPC_URL = process.env.HOLESKY_RPC_URL

if (!MAINNET_RPC_URL && !GOERLI_RPC_URL) {
  throw new Error(`RPC url was not provided. Please, ensure the .env file is filled correctly.`)
}

const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.19',
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {},
  etherscan: {
    apiKey: ETHERSCAN_API_KEY,
  },
}

if (MAINNET_RPC_URL) {
  config.networks!.mainnet = {
    url: MAINNET_RPC_URL,
    accounts: WALLET_PRIVATE_KEY ? [WALLET_PRIVATE_KEY] : undefined,
  }
  config.networks!.hardhat = {
    forking: {
      url: MAINNET_RPC_URL,
      blockNumber: 18720000,
    },
  }
}

if (GOERLI_RPC_URL) {
  config.networks!.goerli = {
    url: GOERLI_RPC_URL,
    accounts: WALLET_PRIVATE_KEY ? [WALLET_PRIVATE_KEY] : undefined,
  }
}

if (HOLESKY_RPC_URL) {
  config.networks!.holesky = {
    url: HOLESKY_RPC_URL,
    accounts: WALLET_PRIVATE_KEY ? [WALLET_PRIVATE_KEY] : undefined,
  }
}

export default config
