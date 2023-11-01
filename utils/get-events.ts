import { TransactionReceipt } from "ethers"
import { Stonks__factory } from "../typechain-types";

type OrderData = {
    address: string,
    hash: string,
}

export const getPlaceOrderData = async (receipt: TransactionReceipt) => {
    const stonksInterface = Stonks__factory.createInterface()
    const orderEvent = stonksInterface.parseLog((receipt as any).logs[receipt.logs.length - 1])

    return orderEvent
}