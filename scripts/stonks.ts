import { ethers } from "hardhat";
import { PriceChecker, Stonks } from "../typechain-types";

type DeployStonksParams = {
    stonks: {
        tokenFrom: string
        tokenTo: string
    }
    priceChecker: {
        tokenA: string
        tokenB: string
        priceFeed: string
        marginInBps: number
    }
}
type ReturnType = {
    stonks: Stonks
    priceChecker: PriceChecker
}


export async function deployStonks({
    stonks: { tokenFrom, tokenTo },
    priceChecker: { tokenA, tokenB, priceFeed, marginInBps = 0 }
}: DeployStonksParams): Promise<ReturnType> {
    const ContractFactory = await ethers.getContractFactory("Stonks");
    const PriceCheckerFactory = await ethers.getContractFactory("PriceChecker");

    const priceChecker = await PriceCheckerFactory.deploy(priceFeed, tokenA, tokenB, marginInBps);
    await priceChecker.waitForDeployment();

    const stonks = await ContractFactory.deploy(tokenFrom, tokenTo, await priceChecker.getAddress());
    await stonks.waitForDeployment();

    return { stonks, priceChecker };
}