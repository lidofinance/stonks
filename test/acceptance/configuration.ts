import { network } from 'hardhat'
import { mainnet, holesky } from '../../utils/contracts'

export const getTokensToSell = async () => {
  const chain = network.name === 'holesky' ? holesky : mainnet
  return [chain.STETH, chain.DAI, chain.USDT, chain.USDC]
}

export const getTokensToBuy = async () => {
  const chain = network.name === 'holesky' ? holesky : mainnet
  return [chain.DAI, chain.USDT, chain.USDC]
}

// https://docs.chain.link/data-feeds/price-feeds/addresses?network=ethereum&page=1
export const getPriceFeedTimeouts = async () => {
  if (network.name === 'holesky') {
    const year = 60 * 60 * 24 * 365
    return [year, year, year, year] // 1 year for stub
  }

  return [
    3600, // STETH
    3600, // DAI
    86400, // USDT
    86400, // USDC
  ]
}
