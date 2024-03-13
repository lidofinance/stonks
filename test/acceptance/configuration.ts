import { network } from 'hardhat'
import { mainnet, holesky } from '../../utils/contracts'

export const getTokensToSell = async () => {
  if (['hardhat', 'mainnet', 'localhost'].includes(network.name)) {
    return [mainnet.STETH, mainnet.DAI, mainnet.USDT, mainnet.USDC]
  }
  if (network.name === 'holesky') {
    return [holesky.STETH, holesky.DAI, holesky.USDT, holesky.USDC]
  }

  throw new Error('Unknown Network')
}

export const getTokensToBuy = async () => {
  if (['hardhat', 'mainnet', 'localhost'].includes(network.name)) {
    return [mainnet.DAI, mainnet.USDT, mainnet.USDC]
  }
  if (network.name === 'holesky') {
    return [holesky.DAI, holesky.USDT, holesky.USDC]
  }

  throw new Error('Unknown Network')
}

// https://docs.chain.link/data-feeds/price-feeds/addresses?network=ethereum&page=1
export const getPriceFeedTimeouts = async () => {
  if (network.name === 'holesky') {
    const year = 60 * 60 * 24 * 365
    return [year, year, year, year] // 1 year for stub
  }

  if (['hardhat', 'mainnet', 'localhost'].includes(network.name)) {
    return [
      3600n + 15n * 60n, // 1 hour 15 minutes for the stETH/USD feed
      3600n + 15n * 60n, // 1 hour 15 minutes for the DAI/USD feed
      24n * 3600n + 30n * 60n, // 24 hours 30 minutes for the USDC/USD feed
      24n * 3600n + 30n * 60n, // 24 hours 30 minutes for the USDT/USD feed
    ]
  }

  throw new Error('Unknown Network')
}
