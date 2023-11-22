import { ethers } from 'hardhat'
import { GPv2Order } from '../typechain-types/contracts/Order'

export const MAGIC_VALUE = "0x1626ba7e"
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

export const encodeCowOrderForIsValidSignature = (
  args: GPv2Order.DataStruct
) => {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    [
      'address',
      'address',
      'address',
      'uint256',
      'uint256',
      'uint32',
      'bytes32',
      'uint256',
      'bytes32',
      'bool',
      'bytes32',
      'bytes32',
    ],
    [
      args.sellToken,
      args.buyToken,
      args.receiver,
      args.sellAmount,
      args.buyAmount,
      args.validTo,
      ethers.keccak256('LIDO_DOES_STONKS'),
      args.feeAmount,
      '0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775',
      false, // partiallyFillable
      '0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9',
      '0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9',
    ]
  )
}
