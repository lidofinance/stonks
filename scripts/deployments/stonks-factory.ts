import { ethers } from "hardhat";
import { StonksFactory } from "../../typechain-types";

type ReturnType = { stonksFactory: StonksFactory }

export async function deployStonksFactory(): Promise<ReturnType> {
    const ContractFactory = await ethers.getContractFactory("StonksFactory");
    const stonksFactory = await ContractFactory.deploy();
    
    await stonksFactory.waitForDeployment();

    return { stonksFactory }
}