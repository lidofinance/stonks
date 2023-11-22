import { HardhatUserConfig } from 'hardhat/config'
import '@nomicfoundation/hardhat-toolbox'
// import "@foundry-rs/hardhat-anvil";
import * as dotenv from 'dotenv'
import './utils/assert'

dotenv.config()

const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY!
const GOERLI_RPC_URL = process.env.GOERLI_RPC_URL!
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY!

const config: HardhatUserConfig = {
  solidity: '0.8.19',
  networks: {
    goerli: {
      url: GOERLI_RPC_URL,
      accounts: [WALLET_PRIVATE_KEY],
    },
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY,
  },
}

export default config
