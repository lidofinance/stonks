import { ethers } from 'hardhat'
import { getContracts } from './contracts'
import { getTestFeedRegistryStub } from './test-feed-registry'

const contracts = getContracts()

export const getExpectedOut = async (
  tokenFrom: string,
  tokenTo: string,
  amount: bigint
): Promise<bigint> => {
  const feedRegistryAddress = await (
    await getTestFeedRegistryStub({
      tokens: [tokenFrom, tokenTo],
      useRealPrices: true,
    })
  ).getAddress()
  const feedRegistry = await ethers.getContractAt('IFeedRegistry', feedRegistryAddress)

  const PRICE_DECIMALS = 8n

  const readPriceNormalized = async (base: string, quote: string): Promise<bigint> => {
    const decimals = await feedRegistry.decimals(base, quote)
    const [, raw] = await feedRegistry.latestRoundData(base, quote)
    const d = BigInt(decimals)
    if (d === PRICE_DECIMALS) return raw
    if (d < PRICE_DECIMALS) return raw * 10n ** (PRICE_DECIMALS - d)
    return raw / 10n ** (d - PRICE_DECIMALS)
  }

  const priceFromUSD = await readPriceNormalized(tokenFrom, contracts.CHAINLINK_USD_QUOTE)
  const priceToUSD = await readPriceNormalized(tokenTo, contracts.CHAINLINK_USD_QUOTE)

  const decimalsOfSellToken = await (
    await ethers.getContractAt('IERC20Metadata', tokenFrom)
  ).decimals()
  const decimalsOfBuyToken = await (
    await ethers.getContractAt('IERC20Metadata', tokenTo)
  ).decimals()

  const diff = BigInt(decimalsOfSellToken) - BigInt(decimalsOfBuyToken)
  const sellHasMoreOrEqualDecimals = diff >= 0n

  if (sellHasMoreOrEqualDecimals) {
    // Use mulDiv equivalent: (amount * priceFromUSD) / priceToUSD
    const grossOutput = (amount * priceFromUSD) / priceToUSD
    return diff === 0n ? grossOutput : grossOutput / 10n ** diff
  } else {
    // Scale the input first to avoid overflow
    const pow10 = 10n ** -diff
    const scaledAmount = amount * pow10
    return (scaledAmount * priceFromUSD) / priceToUSD
  }
}
