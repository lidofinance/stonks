import { ethers } from 'hardhat'
import { parseEther } from 'ethers'
import { setBalance, impersonateAccount } from '@nomicfoundation/hardhat-network-helpers'
import { IERC20 } from '../../typechain-types'
import { getContracts } from '../../utils/contracts'

const contracts = getContracts()

export const REBASE_TOLERANCE = parseEther('0.1')
export const MULTI_REBASE_TOLERANCE = parseEther('5')
export const EXTREME_REBASE_TOLERANCE = parseEther('10')

export async function simulatePositiveRebase(
  token: IERC20,
  targetAddress: string,
  rebaseAmount: bigint
): Promise<{ balanceBefore: bigint; balanceAfter: bigint }> {
  const balanceBefore = await token.balanceOf(targetAddress)

  const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
  await impersonateAccount(contracts.AGENT)
  await setBalance(contracts.AGENT, parseEther('1'))
  await token.connect(treasurySigner).transfer(targetAddress, rebaseAmount)

  const balanceAfter = await token.balanceOf(targetAddress)
  return { balanceBefore, balanceAfter }
}

export async function simulateNegativeRebase(
  token: IERC20,
  targetAddress: string,
  rebaseAmount: bigint
): Promise<{ balanceBefore: bigint; balanceAfter: bigint }> {
  const balanceBefore = await token.balanceOf(targetAddress)

  await impersonateAccount(targetAddress)
  await setBalance(targetAddress, parseEther('1'))
  const targetSigner = await ethers.getSigner(targetAddress)
  const [, recipient] = await ethers.getSigners()
  await token.connect(targetSigner).transfer(await recipient.getAddress(), rebaseAmount)

  const balanceAfter = await token.balanceOf(targetAddress)
  return { balanceBefore, balanceAfter }
}

export async function simulateRebase(
  token: IERC20,
  targetAddress: string,
  rebaseAmount: bigint,
  isPositive: boolean
): Promise<{ balanceBefore: bigint; balanceAfter: bigint }> {
  return isPositive
    ? simulatePositiveRebase(token, targetAddress, rebaseAmount)
    : simulateNegativeRebase(token, targetAddress, rebaseAmount)
}

export async function simulatePartialFill(
  tokenFrom: IERC20,
  orderAddress: string,
  fillPercentage: number
): Promise<{ soldAmount: bigint; remainingBalance: bigint }> {
  const initialBalance = await tokenFrom.balanceOf(orderAddress)
  const soldAmount = (initialBalance * BigInt(fillPercentage)) / 100n

  await impersonateAccount(orderAddress)
  await setBalance(orderAddress, parseEther('1'))
  const orderSigner = await ethers.getSigner(orderAddress)
  const [, recipient] = await ethers.getSigners()
  await tokenFrom.connect(orderSigner).transfer(await recipient.getAddress(), soldAmount)

  const remainingBalance = await tokenFrom.balanceOf(orderAddress)
  return { soldAmount, remainingBalance }
}

export async function verifyOrderValidity(
  order: any,
  expectedHash: string,
  expectedMagicValue: string
) {
  const actualSignature = await order.isValidSignature(expectedHash, '0x')
  if (actualSignature !== expectedMagicValue) {
    throw new Error(
      `Order signature validation failed. Expected ${expectedMagicValue}, got ${actualSignature}`
    )
  }
}

