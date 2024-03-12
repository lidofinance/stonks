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

  const feedDecimals = await feedRegistry.decimals(
    tokenFrom,
    contracts.CHAINLINK_USD_QUOTE
  )
  const [_, price] = await feedRegistry.latestRoundData(
    tokenFrom,
    contracts.CHAINLINK_USD_QUOTE
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
