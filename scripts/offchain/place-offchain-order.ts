import { ethers } from 'hardhat'
import { getPlaceOrderEvent } from "../../utils/get-events"

const txHash: string = "0xad2b6563d8f0b0ef5a7eac47da838d79665544855ff6a81443a350c284d67abb"

async function main() {
    const [signer] = await ethers.getSigners();
    const tx = await ethers.provider.getTransactionReceipt(txHash)

    if (!tx) throw Error("No tx found")

    const orderEvent = await getPlaceOrderEvent(tx)

    console.log(orderEvent)
}

main().then(() => process.exit(0))
    .catch(error => {
        console.error(error)
        process.exit(1)
    })