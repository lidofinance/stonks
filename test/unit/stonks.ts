import {
  loadFixture
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { ethers } from "hardhat";

describe("Swapper", function () {
  async function deploySwapperFixture() {
    const ContractFactory = await ethers.getContractFactory("Stonks");
    const subject = await ContractFactory.deploy(ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, 0);

    await subject.waitForDeployment();

    return { subject };
  }

  describe("Initialization", function () {
    it("Should set the right addresses", async function () {
      const { subject } = await loadFixture(deploySwapperFixture);
    });
  })
})