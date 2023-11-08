import { deployStonks, DeployStonksParams } from "./deployments/stonks"
import { ethers } from 'hardhat'
import { goerli } from "../utils/contracts";

export const goerliDeploy = async () => {
    const deployer = (await ethers.getSigners())[0];
    const params: DeployStonksParams = {
        stonksParams: {
            tokenFrom: goerli.WETH, // WETH
            tokenTo: goerli.UNI, // UNI
            operator: await deployer.getAddress(),
            tokenConverterAddress: "0x26eef32497909Bb27E9B40091246c0aA39d1A7dB", // 
        }
    }

    const { stonks } = await deployStonks(params)
    const stonksAddress = await stonks.getAddress()
    console.log("Deployed contract:", stonksAddress)

    const weth = await ethers.getContractAt("IERC20", params.stonksParams.tokenFrom, deployer)
    const transferTx = await weth.transfer(stonksAddress, ethers.parseEther("0.01"))

    await transferTx.wait()
    console.log(`Transferred 0.01 WETH to contract: ${transferTx.hash}`)

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