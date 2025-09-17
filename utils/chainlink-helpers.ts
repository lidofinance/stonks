import { ethers } from 'hardhat'
import { getContracts } from './contracts'

const contracts = getContracts()

export const getExpectedOut = async (
  tokenFrom: string,
  tokenTo: string,
  amount: bigint
): Promise<bigint> => {
  const feedRegistry = await ethers.getContractAt(
    'IFeedRegistry',
    contracts.CHAINLINK_PRICE_FEED_REGISTRY
  )

  // Router UNIT_DECIMALS = 18
  const UNIT_DECIMALS = 18n

  const readPriceNormalized = async (base: string, quote: string): Promise<bigint> => {
    const decimals = await feedRegistry.decimals(base, quote)
    const [, raw] = await feedRegistry.latestRoundData(base, quote)
    const d = BigInt(decimals)
    if (d === UNIT_DECIMALS) return raw
    if (d < UNIT_DECIMALS) return raw * 10n ** (UNIT_DECIMALS - d)
    return raw / 10n ** (d - UNIT_DECIMALS)
  }

  // USD prices for both tokens
  const priceFromUSD = await readPriceNormalized(tokenFrom, contracts.CHAINLINK_USD_QUOTE)
  const priceToUSD = await readPriceNormalized(tokenTo, contracts.CHAINLINK_USD_QUOTE)

  // Token decimals
  const decimalsOfSellToken = await (
    await ethers.getContractAt('IERC20Metadata', tokenFrom)
  ).decimals()
  const decimalsOfBuyToken = await (
    await ethers.getContractAt('IERC20Metadata', tokenTo)
  ).decimals()

  const raw = (amount * priceFromUSD) / priceToUSD

  const diff = BigInt(decimalsOfSellToken) - BigInt(decimalsOfBuyToken)
  if (diff >= 0) {
    return raw / 10n ** diff
  } else {
    return raw * 10n ** -diff
  }
}
