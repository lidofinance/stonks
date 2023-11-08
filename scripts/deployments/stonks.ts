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
        marginInBps: number
    }
    priceCheckerParams?: {
        priceFeedRegistry: string
        allowedTokensToSell: string[]
        allowedStableTokensToBuy: string[]
    }
}
type ReturnType = {
    stonks: Stonks
    priceChecker: PriceChecker
}


export async function deployStonks({
    stonksParams: { tokenFrom, tokenTo, priceCheckerAddress, operator, marginInBps },
    priceCheckerParams
}: DeployStonksParams): Promise<ReturnType> {

    const { stonksFactory } = await deployStonksFactory();

    let priceChecker: PriceChecker | undefined;
    if (priceCheckerParams) {
        const { priceFeedRegistry, allowedTokensToSell, allowedStableTokensToBuy } = priceCheckerParams;
        const deployPriceCheckerTX = await stonksFactory.deployChainLinkUsdTokensConverter(priceFeedRegistry, allowedTokensToSell, allowedStableTokensToBuy);
        const receipt = await deployPriceCheckerTX.wait();

        if (!receipt) throw new Error("No transaction receipt");

        const { address } = getPriceCheckerDeployment(receipt)
        priceChecker = await ethers.getContractAt("ChainLinkUsdTokensConverter", address)
    } else if (priceCheckerAddress) {
        priceChecker = await ethers.getContractAt("ChainLinkUsdTokensConverter", priceCheckerAddress)
    } else {
        throw new Error()
    }

    const deployStonksTx = await stonksFactory.deployStonks(tokenFrom, tokenTo, operator, await priceChecker.getAddress(), marginInBps);
    const receipt = await deployStonksTx.wait();

    if (!receipt) throw new Error("No transaction receipt");

    const { address } = getStonksDeployment(receipt)
    const stonks = await ethers.getContractAt("Stonks", address)

    return { stonks, priceChecker };
}