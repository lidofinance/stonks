export type Order = {
  sellToken: string
  buyToken: string
  receiver: string
  sellAmount: string
  buyAmount: string
  validTo: number
  appData: string
  feeAmount: number
  kind: string
  partiallyFillable: boolean
  sellTokenBalance: string
  buyTokenBalance: string
}

export type PlaceOrderDataEvent = {
  address: string
  hash: string
  timestamp: number
  order: Order
}
