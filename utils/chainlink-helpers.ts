import { ethers } from 'hardhat'
import { mainnet } from './contracts'

export const getExpectedOut = async (
  tokenFrom: string,
  tokenTo: string,
  amount: bigint
): Promise<bigint> => {
  const feedRegistry = await ethers.getContractAt(
    'IFeedRegistry',
    mainnet.CHAINLINK_PRICE_FEED_REGISTRY
  )

  const feedDecimals = await feedRegistry.decimals(
    tokenFrom,
    mainnet.CHAINLINK_USD_QUOTE
  )
  const [_, price] = await feedRegistry.latestRoundData(
    tokenFrom,
    mainnet.CHAINLINK_USD_QUOTE
  )

  const decimalsOfSellToken = await (
    await ethers.getContractAt('IERC20Metadata', tokenFrom)
  ).decimals()
  const decimalsOfBuyToken = await (
    await ethers.getContractAt('IERC20Metadata', tokenTo)
  ).decimals()

  const effectiveDecimalDifference =
    decimalsOfSellToken + feedDecimals - decimalsOfBuyToken

  let expectedOutputAmount
  if (effectiveDecimalDifference >= 0) {
    expectedOutputAmount =
      (amount * price) / BigInt(10) ** effectiveDecimalDifference
  } else {
    expectedOutputAmount =
      amount * price * BigInt(10) ** -effectiveDecimalDifference
  }

  return expectedOutputAmount
}
