import { ethers } from 'hardhat'
import { Order } from '../../utils/types'

export const postCowOrder = async (orderPayload: Order, contract: string) => {
  let timesToRetry = 3
  let orderUid: string | undefined

  const payload = {
    ...orderPayload,
    from: contract,
    kind: 'sell',
    signingScheme: 'eip1271',
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
    signature: '0x',
  }

  while (timesToRetry > 0) {
    try {
      const orderRequest = await fetch(
        'https://api.cow.fi/mainnet/api/v1/orders',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        }
      )
      orderUid = await orderRequest.json()
      break
    } catch (error) {
      console.log(error)
      timesToRetry -= 1
    }
  }
  return orderUid
}

export const encodeCowOrderForIsValidSignature = (args: Order) => {
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
      args.appData,
      args.feeAmount,
      args.kind,
      false,
      args.sellTokenBalance,
      args.buyTokenBalance,
    ]
  )
}
