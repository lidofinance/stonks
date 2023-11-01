import { PriceChecker } from "../../typechain-types";
import { ethers } from "hardhat";

import { mainnet } from "../../utils/contracts";

describe("Price checker", function () {
    let subject: PriceChecker;

    this.beforeAll(async function () {
        const ContractFactory = await ethers.getContractFactory("PriceChecker");
        subject = await ContractFactory.deploy(mainnet.STETH_USD_PRICE_FEED, mainnet.STETH, mainnet.DAI, 100);

        await subject.waitForDeployment();
    });

    describe("Price check", async function () {
        it("Should have the right price in the straigt direction", async function () {
            const stethToSell = ethers.parseEther("1")
            const price = await subject.getExpectedOut(stethToSell, mainnet.STETH, mainnet.DAI)
            console.log(price.toString())
        })

        it("Should have the right price in the back direction", async function () {
            const stethToSell = ethers.parseEther("1630")
            const price = await subject.getExpectedOut(stethToSell, mainnet.DAI, mainnet.STETH)
            console.log(price.toString())
        })
    })
})