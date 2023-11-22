import { ethers } from 'hardhat'
import { TransactionReceipt } from 'ethers'
import { getPlaceOrderData } from './get-events'
import { mainnet } from './contracts'
import { GPv2Order } from '../typechain-types/contracts/Order'
import { HashHelper, Stonks } from '../typechain-types'

export const MAX_BASIS_POINTS = BigInt(10000)
export const MAGIC_VALUE = '0x1626ba7e'
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
  const validTo = blockTimestamp + 3600 // 1 hour
  const { address: orderInstanceAddress } = getPlaceOrderData(receipt)
  const [tokenFrom, tokenTo, tokenConverterAddress, marginInBasisPoints] =
    await stonks.getOrderParameters()
  const tokenConverter = await ethers.getContractAt(
    'ChainLinkTokenConverter',
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

  return await hashHelper.hash(orderData)
}

const hashHelper: {
  domainSeparator: string
  hashHelperContract?: HashHelper
  hash: (orderData: GPv2Order.DataStruct) => Promise<string>
} = {
  domainSeparator:
    '0xc078f884a2676e1345748b1feace7b0abee5d00ecadb6e574dcdd109a63e8943',
  hashHelperContract: undefined,
  hash: async function (orderData) {
    if (!this.hashHelperContract) {
      const HashHelperFactory = await ethers.getContractFactory('HashHelper')

      this.hashHelperContract = await HashHelperFactory.deploy()
      await this.hashHelperContract.waitForDeployment()
    }

    return this.hashHelperContract.hash(orderData, this.domainSeparator)
  },
}
