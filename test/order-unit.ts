import {
    loadFixture
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { ethers } from "hardhat";

describe("Order", function () {
    async function deployOrderFixture() {
        const ContractFactory = await ethers.getContractFactory("Order");
        const subject = await ContractFactory.deploy();

        await subject.waitForDeployment();

        return { subject };
    }

    describe("Initialization", function () {
        it("Should set the right addresses", async function () {
            const { subject } = await loadFixture(deployOrderFixture);
            console.log(await subject.orderHash())
        });
    })
})