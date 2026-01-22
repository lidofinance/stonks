import { HardhatUserConfig } from 'hardhat/config'
import '@nomicfoundation/hardhat-toolbox'
import '@nomicfoundation/hardhat-chai-matchers'
import * as dotenv from 'dotenv'

dotenv.config()

const MAINNET_RPC_URL = process.env.RPC_URL
const HOODI_RPC_URL = process.env.HOODI_RPC_URL

if (!MAINNET_RPC_URL && !HOODI_RPC_URL) {
  throw new Error(`RPC url was not provided. Please, ensure the .env file is filled correctly.`)
}

const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.23',
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    mainnet: {
      url: process.env.RPC_URL,
      accounts: WALLET_PRIVATE_KEY ? [WALLET_PRIVATE_KEY] : [],
    },
    hardhat: {
      forking: {
        url: process.env.RPC_URL!,
      },
    },
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY,
    customChains: [
      {
        network: 'hoodi',
        chainId: 17000,
        urls: {
          apiURL: 'https://api-hoodi.etherscan.io/v2/api',
          browserURL: 'https://hoodi.etherscan.io',
        },
      },
    ],
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

if (HOODI_RPC_URL) {
  config.networks!.holesky = {
    url: HOODI_RPC_URL,
    accounts: WALLET_PRIVATE_KEY ? [WALLET_PRIVATE_KEY] : undefined,
  }
}

export default config
