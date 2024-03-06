import { network } from 'hardhat'
import { mainnet, holesky } from '../../utils/contracts'

export const getTokensToSell = async () => {
  if (network.name === 'holesky') {
    return [holesky.STETH]
  }

  return [
    mainnet.STETH,
    mainnet.DAI,
    mainnet.USDT,
    mainnet.USDC,
  ]
}

export const getTokensToBuy = async () => {
  if (network.name === 'holesky') {
    return [holesky.LDO]
  }

  return [
    mainnet.DAI,
    mainnet.USDT,
    mainnet.USDC,
  ]
}

// https://docs.chain.link/data-feeds/price-feeds/addresses?network=ethereum&page=1
export const getPriceFeedTimeouts = async () => {
  if (network.name === 'holesky') {
    return [60 * 60 * 24 * 365] // 1 year for stub
  }

  return [
    3600, // STETH
    3600, // DAI
    86400, // USDT
    86400, // USDC
  ]
}