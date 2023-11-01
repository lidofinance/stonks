import { ethers, network } from "hardhat";
import { expect } from "chai"
import { deployStonks } from "../../scripts/deployments/stonks";
import { PriceChecker, Stonks, } from "../../typechain-types";
import { mainnet } from "../../utils/contracts";

describe("Stonks", function () {
    let subject: Stonks;
    let subjectPriceChecker: PriceChecker
    let snapshotId: string

    this.beforeAll(async function () {
        snapshotId = await network.provider.send('evm_snapshot')

        const { stonks, priceChecker  } = await deployStonks({
            stonksParams: {
                tokenFrom: mainnet.STETH,
                tokenTo: mainnet.DAI
            },
            priceCheckerParams: {
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

    describe("order placement", function (){
        it("should not place order when balance is zero", async function () {
            expect(subject.placeOrder()).to.be.rejectedWith("Stonks: insufficient balance")
        })
        
        it("should place order")
    })

    this.afterEach(async function () {
        await network.provider.send("evm_revert", [snapshotId]);
    })
})