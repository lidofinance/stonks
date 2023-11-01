import { ethers, network } from "hardhat";
import { PriceChecker, StonksFactory } from "../../typechain-types";

import { mainnet } from "../../utils/contracts";

describe("Stonks factory", function () {
    let subject: StonksFactory;
    let snapshotId: string;

    this.beforeAll(async function () {
        const ContractFactory = await ethers.getContractFactory("StonksFactory");

        subject = await ContractFactory.deploy();
        await subject.waitForDeployment();

        snapshotId = await network.provider.send('evm_snapshot');
    })

    describe("Deploing price checker", async function () {
        let priceChecker: PriceChecker

        it("Should deploy price checker with correct params", async () => {
            const deployTx = await subject.deployPriceChecker(mainnet.STETH_USD_PRICE_FEED, mainnet.STETH, mainnet.DAI, 100);
        })

    })
    describe("Deploing stonks", async function () { })

    this.afterAll(async function () {
        await network.provider.send("evm_revert", [snapshotId]);
    })
})