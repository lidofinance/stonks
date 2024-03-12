import { ethers, network } from 'hardhat'
import { setBalance } from '@nomicfoundation/hardhat-network-helpers'
import { getContracts } from '../utils/contracts'

type FillUpParams = {
  token?: string
  amount: string | bigint
  address: string
}

const contracts = getContracts()

export const fillUpERC20FromTreasury = async ({
  token,
  amount,
  address,
}: FillUpParams) => {
  if (!token) throw new Error('Token address is not provided')

  await setBalance(contracts.AGENT, ethers.parseEther('100'))
  await network.provider.request({
    method: 'hardhat_impersonateAccount',
    params: [contracts.AGENT],
  })

  const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
  const erc20Treasury = await ethers.getContractAt(
    'IERC20',
    token,
    treasurySigner
  )

  const transferTx = await erc20Treasury.transfer(address, amount)
  await transferTx.wait()
}
