import { TransactionReceipt } from "ethers"
import { Stonks__factory } from "../typechain-types";
import { Order } from "./types"

type OrderData = {
    address: string
    hash: string
    order: Order
}

export const getPlaceOrderData = (receipt: TransactionReceipt): OrderData => {
    const stonksInterface = Stonks__factory.createInterface()
    const orderEvent = stonksInterface.parseLog((receipt as any).logs[receipt.logs.length - 1])
    const data: any = orderEvent?.args

    return {
        address: data[0],
        hash: data[1],
        order: {
            sellToken: data[2][0],
            buyToken: data[2][1],
            receiver: data[2][2],
            sellAmount: data[2][3].toString(),
            buyAmount: data[2][4].toString(),
            validTo: Number(data[2][5]),
            appData: data[2][6],
            feeAmount: data[2][7].toString(),
            kind: data[2][8],
            partiallyFillable: data[2][9],
            sellTokenBalance: data[2][10],
            buyTokenBalance: data[2][11],
        }
    }
}