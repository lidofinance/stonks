import { ethers } from 'hardhat'
import { TransactionReceipt } from 'ethers'
import { getPlaceOrderData } from './get-events'
import { mainnet } from './contracts'
import { Stonks } from '../typechain-types'

export const MAX_BASIS_POINTS = BigInt(10000)
export const MAGIC_VALUE = '0x1626ba7e'
export const domainSeparator =
  '0xc078f884a2676e1345748b1feace7b0abee5d00ecadb6e574dcdd109a63e8943'
export const orderPartials = {
  appData: ethers.keccak256(ethers.toUtf8Bytes('LIDO_DOES_STONKS')),
  kind: '0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775',
  sellTokenBalance:
    '0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9',
  buyTokenBalance:
    '0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9',
  partiallyFillable: false,
}

export const formOrderHashFromTxReceipt = async (
  receipt: TransactionReceipt,
  stonks: Stonks
) => {
  const blockNumber = receipt.blockNumber
  const blockTimestamp = (await ethers.provider.getBlock(blockNumber))
    ?.timestamp

  if (!blockTimestamp) throw Error('blockTimestamp is null')
  const { address: orderInstanceAddress, order } = getPlaceOrderData(receipt)
  const [tokenFrom, tokenTo, tokenConverterAddress, orderDuration, marginInBasisPoints] =
    await stonks.getOrderParameters()
  const validTo = blockTimestamp + Number(orderDuration) // 1 hour
  const tokenConverter = await ethers.getContractAt(
    'TokenAmountConverter',
    tokenConverterAddress
  )
  const token = await ethers.getContractAt('IERC20', tokenFrom)
  const sellAmount = await token.balanceOf(orderInstanceAddress)
  const buyAmountWithoutMargin = await tokenConverter.getExpectedOut(
    sellAmount,
    tokenFrom,
    tokenTo
  )
  const buyAmount =
    (buyAmountWithoutMargin * (MAX_BASIS_POINTS - marginInBasisPoints)) /
    MAX_BASIS_POINTS

  const orderData = {
    sellToken: tokenFrom,
    buyToken: tokenTo,
    receiver: mainnet.TREASURY,
    sellAmount: sellAmount,
    buyAmount: buyAmount,
    validTo: validTo,
    appData: orderPartials.appData,
    feeAmount: 0,
    kind: orderPartials.kind,
    partiallyFillable: orderPartials.partiallyFillable,
    sellTokenBalance: orderPartials.sellTokenBalance,
    buyTokenBalance: orderPartials.buyTokenBalance,
  }

  const HashHelperFactory = await ethers.getContractFactory('HashHelper')
  const hashHelper = await HashHelperFactory.deploy()

  await hashHelper.waitForDeployment()
  return await hashHelper.hash(orderData, domainSeparator)
}
