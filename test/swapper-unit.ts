import {
  loadFixture
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { ethers } from "hardhat";

describe("Swapper", function () {
  async function deploySwapperFixture() {
    const Swapper = await ethers.getContractFactory("Swapper");
    const swapper = await Swapper.deploy(ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress);

    await swapper.waitForDeployment();

    return { swapper };
  }

  describe("Initialization", function () {
    it("Should set the right addresses", async function () {
      const { swapper } = await loadFixture(deploySwapperFixture);
      console.log(swapper)
    });
  })
})