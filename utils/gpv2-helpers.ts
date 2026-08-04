import { ethers } from 'hardhat'
import { TransactionReceipt } from 'ethers'
import { getPlaceOrderData } from './get-events'

export const MAX_BASIS_POINTS = BigInt(10000)
export const MAGIC_VALUE = '0x1626ba7e'
export const orderPartials = {
  appData: ethers.keccak256(ethers.toUtf8Bytes('LIDO_DOES_STONKS')),
  kind: '0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775',
  sellTokenBalance: '0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9',
  buyTokenBalance: '0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9',
  partiallyFillable: false,
}

export const formOrderHashFromTxReceipt = async (receipt: TransactionReceipt) => {
  const { address: orderInstanceAddress } = await getPlaceOrderData(receipt)
  const order = await ethers.getContractAt('Order', orderInstanceAddress)
  const [orderHash] = await order.getOrderDetails()
  return orderHash
}
