import { ethers } from "hardhat";

import { deployStonksFactory } from "./stonks-factory";
import { getStonksDeployment, getPriceCheckerDeployment } from "../../utils/get-events"
import { PriceChecker, Stonks } from "../../typechain-types";

export type DeployStonksParams = {
    stonksParams: {
        tokenFrom: string
        tokenTo: string
        operator: string
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
    stonksParams: { tokenFrom, tokenTo, priceCheckerAddress, operator },
    priceCheckerParams
}: DeployStonksParams): Promise<ReturnType> {
    const { stonksFactory } = await deployStonksFactory();

    let priceChecker: PriceChecker | undefined;

    if (priceCheckerParams) {
        const { tokenA, tokenB, priceFeed, marginInBps } = priceCheckerParams;
        const deployPriceCheckerTX = await stonksFactory.deployPriceChecker(priceFeed, tokenA, tokenB, marginInBps);
        const receipt = await deployPriceCheckerTX.wait();

        if (!receipt) throw new Error("No transaction receipt");

        const { address } = getPriceCheckerDeployment(receipt)
        priceChecker = await ethers.getContractAt("PriceChecker", address)
    } else if (priceCheckerAddress) {
        priceChecker = await ethers.getContractAt("PriceChecker", priceCheckerAddress)
    } else {
        throw new Error()
    }

    const deployStonksTx = await stonksFactory.deployStonks(tokenFrom, tokenTo, operator, await priceChecker.getAddress());
    const receipt = await deployStonksTx.wait();

    if (!receipt) throw new Error("No transaction receipt");

    const { address } = getStonksDeployment(receipt)
    const stonks = await ethers.getContractAt("Stonks", address)

    return { stonks, priceChecker };
}