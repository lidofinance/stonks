import { ethers } from 'hardhat'
import { getContracts } from '../../utils/contracts'

const contracts = getContracts()

export async function getExpectedPrice(token: string, quote: string): Promise<bigint> {
  const registry = await ethers.getContractAt(
    'IFeedRegistry',
    contracts.CHAINLINK_PRICE_FEED_REGISTRY
  )
  const [, answer] = await registry.latestRoundData(token, quote)
  const decimals = await registry.decimals(token, quote)
  return (BigInt(answer) * 10n ** 18n) / 10n ** BigInt(decimals)
}

export async function getExpectedConversion(
  tokenFrom: string,
  tokenTo: string,
  amount: bigint
): Promise<bigint> {
  const registry = await ethers.getContractAt(
    'IFeedRegistry',
    contracts.CHAINLINK_PRICE_FEED_REGISTRY
  )
  const [, fromAnswer] = await registry.latestRoundData(tokenFrom, contracts.CHAINLINK_USD_QUOTE)
  const [, toAnswer] = await registry.latestRoundData(tokenTo, contracts.CHAINLINK_USD_QUOTE)
  const fromDecimals = await registry.decimals(tokenFrom, contracts.CHAINLINK_USD_QUOTE)
  const toDecimals = await registry.decimals(tokenTo, contracts.CHAINLINK_USD_QUOTE)

  const erc20Abi = ['function decimals() view returns (uint8)']
  const tokenFromContract = new ethers.Contract(tokenFrom, erc20Abi, ethers.provider)
  const tokenToContract = new ethers.Contract(tokenTo, erc20Abi, ethers.provider)
  const tokenFromDecimals = await tokenFromContract.decimals()
  const tokenToDecimals = await tokenToContract.decimals()

  return (
    (amount * BigInt(fromAnswer) * 10n ** BigInt(toDecimals) * 10n ** BigInt(tokenToDecimals)) /
    (BigInt(toAnswer) * 10n ** BigInt(fromDecimals) * 10n ** BigInt(tokenFromDecimals))
  )
}

export async function getFeedData(token: string, quote: string) {
  const registry = await ethers.getContractAt(
    'IFeedRegistry',
    contracts.CHAINLINK_PRICE_FEED_REGISTRY
  )
  const [roundId, answer, startedAt, updatedAt, answeredInRound] = await registry.latestRoundData(
    token,
    quote
  )
  const decimals = await registry.decimals(token, quote)
  const aggregator = await registry.getFeed(token, quote)

  return {
    aggregator,
    answer: BigInt(answer),
    decimals: Number(decimals),
    roundId: BigInt(roundId),
    answeredInRound: BigInt(answeredInRound),
    updatedAt: BigInt(updatedAt),
    startedAt: BigInt(startedAt),
  }
}

