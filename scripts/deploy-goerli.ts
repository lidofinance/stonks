import { deployStonks, DeployStonksParams } from "./deployments/stonks"
import { ethers } from 'hardhat'

export const goerliDeploy = async () => {
    const deployer = (await ethers.getSigners())[0];
    const params: DeployStonksParams = {
        stonksParams: {
            tokenFrom: "0xB4FBF271143F4FBf7B91A5ded31805e42b2208d6", // WETH
            tokenTo: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", // UNI
            priceCheckerAddress: "0x26eef32497909Bb27E9B40091246c0aA39d1A7dB" // 
        }
    }

    const {stonks} = await deployStonks(params)
    const stonksAddress = await stonks.getAddress()
    console.log("Deployed contract:", stonksAddress)

    const weth = await ethers.getContractAt("IERC20", params.stonksParams.tokenFrom, deployer)
    const transferTx = await weth.transfer(stonksAddress, ethers.parseEther("0.01"))

    await transferTx.wait()
    console.log("Transferred 0.01 WETH to contract")

    const arsString = Object.values(params.stonksParams).map((v) => `"${v}"`).join(" ");

    console.log("To verify the contract on Etherscan, use command:");
    console.log(`npx hardhat verify --network goerli ${stonksAddress} ${arsString}`)
}


goerliDeploy()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error)
        process.exit(1)
    })