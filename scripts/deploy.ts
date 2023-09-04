import { ethers } from "hardhat";

async function main() {
  const swapper = await ethers.deployContract("Swapper",
    [ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress]
  );

  await swapper.waitForDeployment();
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
