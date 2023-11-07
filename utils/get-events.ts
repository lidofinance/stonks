import { TransactionReceipt } from "ethers"
import { StonksFactory__factory, Order__factory } from "../typechain-types";
import { Order } from "./types"

export const getPlaceOrderData = (receipt: TransactionReceipt): {
    address: string
    hash: string
    order: Order
} => {
    const orderInterface = Order__factory.createInterface()
    const orderEvent = orderInterface.parseLog((receipt as any).logs[receipt.logs.length - 1])
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

export const getStonksDeployment = (receipt: TransactionReceipt): {
    address: string
    tokenFrom: string
    tokenTo: string
    priceChecker: string
    operator: string
    order: string
} => {
    const stonksFactoryInterface = StonksFactory__factory.createInterface()
    const deployEvent = stonksFactoryInterface.parseLog((receipt as any).logs[receipt.logs.length - 1])
    const data: any = deployEvent?.args

    return {
        address: data[0],
        tokenFrom: data[1],
        tokenTo: data[2],
        priceChecker: data[3],
        operator: data[4],
        order: data[5],
    }
}

export const getPriceCheckerDeployment = (receipt: TransactionReceipt): {
    address: string
    priceFeed: string
    tokenA: string
    tokenB: string
    marginInBps: number 
} => {
    const stonksFactoryInterface = StonksFactory__factory.createInterface()
    const deployEvent = stonksFactoryInterface.parseLog((receipt as any).logs[receipt.logs.length - 1])
    const data: any = deployEvent?.args

    return {
        address: data[0],
        priceFeed: data[1],
        tokenA: data[2],
        tokenB: data[3],
        marginInBps: Number(data[4]),
    }
}