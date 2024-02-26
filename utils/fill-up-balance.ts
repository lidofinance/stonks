import { ethers, network } from 'hardhat'
import { setBalance } from '@nomicfoundation/hardhat-network-helpers'
import { mainnet } from '../utils/contracts'

type FillUpParams = {
  token?: string
  amount: string | bigint
  address: string
}

export const fillUpERC20FromTreasury = async ({
  token,
  amount,
  address,
}: FillUpParams) => {
  if (!token) throw new Error('Token address is not provided')

  await setBalance(mainnet.AGENT, ethers.parseEther('100'))
  await network.provider.request({
    method: 'hardhat_impersonateAccount',
    params: [mainnet.AGENT],
  })

  const treasurySigner = await ethers.provider.getSigner(mainnet.AGENT)
  const erc20Treasury = await ethers.getContractAt(
    'IERC20',
    token,
    treasurySigner
  )

  const transferTx = await erc20Treasury.transfer(address, amount)
  await transferTx.wait()
}
