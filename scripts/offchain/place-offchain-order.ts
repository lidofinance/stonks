import { ethers } from 'hardhat'
import { postCowOrder } from './cowswap'
import { getPlaceOrderData } from '../../utils/get-events'

const txHash: string =
  '0xe591d1249eb4d231155dce7eda2e419d302717ace28c44c707cbd9379a79962f'

async function main() {
  const txReceipt = await ethers.provider.getTransactionReceipt(txHash)

  if (!txReceipt) throw Error('No tx receipt found')

  const orderData = await getPlaceOrderData(txReceipt)
  const orderUid = await postCowOrder(orderData.order, orderData.address)

  console.log(orderUid)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
