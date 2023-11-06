import { ethers, network } from "hardhat"
import { mainnet } from "../utils/contracts"

type FillUpParams = {
    token?: string
    amount: string | bigint
    address: string
}

export const fillUpERC20FromTreasury = async ({ token, amount, address }: FillUpParams) => {
    if (!token) throw new Error("Token address is not provided")

    await fillUpBalance(mainnet.TREASURY, ethers.parseEther("1"))
    await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [mainnet.TREASURY],
    });

    const treasurySigner = await ethers.provider.getSigner(mainnet.TREASURY)
    const erc20Treasury = await ethers.getContractAt("IERC20", token, treasurySigner)

    const transferTx = await erc20Treasury.transfer(address, amount)
    await transferTx.wait()
}

const fillUpBalance = async (to: string, value: string | bigint) => {
    const [signer] = await ethers.getSigners()
    signer.sendTransaction({ to, value })
}