import { HardhatUserConfig } from 'hardhat/config'
import '@nomicfoundation/hardhat-toolbox'
import * as dotenv from 'dotenv'
import './utils/assert'

dotenv.config()

const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY!
const RPC_URL = process.env.RPC_URL!
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY!

const config: HardhatUserConfig = {
  solidity: '0.8.19',
  networks: {
    mainnet: {
      url: RPC_URL,
      accounts: [WALLET_PRIVATE_KEY],
    },
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY,
  },
}

export default config
