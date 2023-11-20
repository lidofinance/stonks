import { ethers } from "hardhat";

import { deployStonksFactory } from "./stonks-factory";
import { getStonksDeployment, getTokenConverterDeployment } from "../../utils/get-events"
import { ChainLinkUsdTokensConverter, Stonks } from "../../typechain-types";

export type DeployStonksParams = {
    stonksParams: {
        tokenFrom: string
        tokenTo: string
        operator: string
        marginInBps: number
        priceToleranceInBps: number
        tokenConverterAddress?: string
    }
    tokenConverterParams?: {
        priceFeedRegistry: string
        allowedTokensToSell: string[]
        allowedStableTokensToBuy: string[]
    }
}
type ReturnType = {
    stonks: Stonks
    tokenConverter: ChainLinkUsdTokensConverter
}


export async function deployStonks({
    stonksParams: { tokenFrom, tokenTo, tokenConverterAddress, operator, marginInBps, priceToleranceInBps },
    tokenConverterParams
}: DeployStonksParams): Promise<ReturnType> {

    const { stonksFactory } = await deployStonksFactory();

    let tokenConverter: ChainLinkUsdTokensConverter | undefined;
    if (tokenConverterParams) {
        const { priceFeedRegistry, allowedTokensToSell, allowedStableTokensToBuy } = tokenConverterParams;
        const deployTokenConverterTX = await stonksFactory.deployChainLinkUsdTokensConverter(priceFeedRegistry, allowedTokensToSell, allowedStableTokensToBuy);
        const receipt = await deployTokenConverterTX.wait();

        if (!receipt) throw new Error("No transaction receipt");

        const { address } = getTokenConverterDeployment(receipt)
        tokenConverter = await ethers.getContractAt("ChainLinkUsdTokensConverter", address)
    } else if (tokenConverterAddress) {
        tokenConverter = await ethers.getContractAt("ChainLinkUsdTokensConverter", tokenConverterAddress)
    } else {
        throw new Error()
    }

    const deployStonksTx = await stonksFactory.deployStonks(tokenFrom, tokenTo, operator, await tokenConverter.getAddress(), marginInBps, priceToleranceInBps);
    const receipt = await deployStonksTx.wait();

    if (!receipt) throw new Error("No transaction receipt");

    const { address } = getStonksDeployment(receipt)
    const stonks = await ethers.getContractAt("Stonks", address)

    return { stonks, tokenConverter };
}