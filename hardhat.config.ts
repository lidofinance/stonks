import { HardhatUserConfig } from 'hardhat/config'
import '@nomicfoundation/hardhat-toolbox'
import * as dotenv from 'dotenv'
import './utils/assert'

dotenv.config()

const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY!
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY!

const config: HardhatUserConfig = {
  solidity: '0.8.23',
  networks: {
    mainnet: {
      url: process.env.RPC_URL,
      accounts: [WALLET_PRIVATE_KEY],
    },
    hardhat: {
      forking: {
        url: process.env.RPC_URL!,
      },
    },
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY,
  },
}

export default config
