import { ethers } from 'hardhat'
import { Signer } from 'ethers'
import { impersonateAccount } from '@nomicfoundation/hardhat-network-helpers'
import { getContracts } from '../../utils/contracts'
import { Stonks, Order, IERC20 } from '../../typechain-types'
import { getPlaceOrderData } from '../../utils/get-events'

export async function placeOrderFromAgent(
  stonks: Stonks,
  manager: Signer,
  tokenFrom: IERC20,
  fundAmount: bigint
): Promise<Order> {
  const contracts = getContracts()
  const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
  await impersonateAccount(contracts.AGENT)
  await tokenFrom.connect(treasurySigner).transfer(await stonks.getAddress(), fundAmount)

  const estimatedBuyAmount = await stonks.estimateTradeOutputFromCurrentBalance()
  const tx = await stonks.connect(manager).placeOrder(estimatedBuyAmount)
  const receipt = await tx.wait()
  if (!receipt) throw new Error('No receipt')

  const orderData = await getPlaceOrderData(receipt)
  return ethers.getContractAt('Order', orderData.address)
}
