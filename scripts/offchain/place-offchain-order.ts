import { ethers } from 'hardhat'
import { postCowOrder } from "./cowswap"
import { getPlaceOrderData } from "../../utils/get-events"

const txHash: string = "0x99b885c990f41b7b699bcb8497fb33d802e21d571f97f7024a6812b1068149ea"

async function main() {
    const txReceipt = await ethers.provider.getTransactionReceipt(txHash)

    if (!txReceipt) throw Error("No tx receipt found")

    const orderData = getPlaceOrderData(txReceipt)
    const orderUid = await postCowOrder(orderData.order, orderData.address)

    console.log(orderUid)
}

main().then(() => process.exit(0))
    .catch(error => {
        console.error(error)
        process.exit(1)
    })