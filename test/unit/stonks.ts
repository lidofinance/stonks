import { ethers, network } from "hardhat";
import { expect } from "chai"
import { deployStonks } from "../../scripts/stonks";
import { PriceChecker, Stonks, } from "../../typechain-types";
import { mainnet } from "../utils/contracts";

describe("Stonks", function () {
    let subject: Stonks;
    let subjectPriceChecker: PriceChecker
    let snapshotId: string

    this.beforeAll(async function () {
        snapshotId = await network.provider.send('evm_snapshot')

        const { stonks, priceChecker  } = await deployStonks({
            stonks: {
                tokenFrom: mainnet.STETH,
                tokenTo: mainnet.DAI
            },
            priceChecker: {
                tokenA: mainnet.STETH,
                tokenB: mainnet.DAI,
                priceFeed: mainnet.STETH_USD_PRICE_FEED,
                marginInBps: 100
            }
        })

        subject = stonks
        subjectPriceChecker = priceChecker
    });

    describe("initialization", function () {
        it('should set correct constructor params', async () => {
            expect(await subject.tokenFrom()).to.equal(mainnet.STETH)
            expect(await subject.tokenTo()).to.equal(mainnet.DAI)
            expect(await subject.priceChecker()).to.equal(await subjectPriceChecker.getAddress())
        })

        it("should not initialize with zero address", async function () {
            const ContractFactory = await ethers.getContractFactory("Stonks")

            expect(
                ContractFactory.deploy(ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress)
            ).to.be.revertedWith("Stonks: invalid tokenFrom_ address")
            expect(
                ContractFactory.deploy(mainnet.STETH, ethers.ZeroAddress, ethers.ZeroAddress)
            ).to.be.revertedWith("Stonks: invalid tokenTo_ address")
            expect(
                ContractFactory.deploy(mainnet.STETH, mainnet.DAI, ethers.ZeroAddress)
            ).to.be.revertedWith("Stonks: Stonks: invalid price checker address")
        })
    })

    this.afterAll(async function () {
        await network.provider.send("evm_revert", [snapshotId]);
    })
})