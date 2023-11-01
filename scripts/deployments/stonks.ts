import { ethers } from "hardhat";
import { PriceChecker, Stonks } from "../../typechain-types";

export type DeployStonksParams = {
    stonksParams: {
        tokenFrom: string
        tokenTo: string,
        priceCheckerAddress?: string
    }
    priceCheckerParams?: {
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
    stonksParams: { tokenFrom, tokenTo, priceCheckerAddress },
    priceCheckerParams
}: DeployStonksParams): Promise<ReturnType> {
    const ContractFactory = await ethers.getContractFactory("Stonks");
    const PriceCheckerFactory = await ethers.getContractFactory("PriceChecker");

    let priceChecker: PriceChecker | undefined;

    if (priceCheckerParams) {
        const { tokenA, tokenB, priceFeed, marginInBps } = priceCheckerParams;
        priceChecker = await PriceCheckerFactory.deploy(priceFeed, tokenA, tokenB, marginInBps);
        await priceChecker.waitForDeployment();

        priceCheckerAddress = await priceChecker.getAddress()
    } else if (priceCheckerAddress) {
        priceChecker = await ethers.getContractAt("PriceChecker", priceCheckerAddress)
    } else {
        throw new Error()
    }

    const stonks = await ContractFactory.deploy(tokenFrom, tokenTo, await priceChecker.getAddress());

    await stonks.waitForDeployment();

    return { stonks, priceChecker };
}