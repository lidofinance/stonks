import { ethers, network } from "hardhat";
import { expect } from "chai"
import { deployStonks } from "../../scripts/stonks";
import { PriceChecker, Stonks, Order, Stonks__factory } from "../../typechain-types";
import { mainnet } from "../utils/contracts";

const STETH_INACCURACY = BigInt(5)

describe("Happy path", function () {
    let subject: Stonks;
    let subjectPriceChecker: PriceChecker
    let snapshotId: string

    this.beforeAll(async function () {
        snapshotId = await network.provider.send('evm_snapshot')

        const { stonks, priceChecker } = await deployStonks({
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

    describe("order creation", async function () {
        const value = ethers.parseEther("1")
        let order: Order

        this.beforeAll(async () => {
            const [signer] = await ethers.getSigners()
            signer.sendTransaction({ to: mainnet.TREASURY, value })
        })

        it("should fill up stonks contract", async () => {
            await network.provider.request({
                method: "hardhat_impersonateAccount",
                params: [mainnet.TREASURY],
            });
            const treasurySigner = await ethers.provider.getSigner(mainnet.TREASURY)
            const stethTreasury = await ethers.getContractAt("IERC20", mainnet.STETH, treasurySigner)
            const subjectAddress = await subject.getAddress()

            const transferTx = await stethTreasury.transfer(subjectAddress, value)
            await transferTx.wait()

            expect(await stethTreasury.balanceOf(await subject.getAddress())).to.greaterThanOrEqual(value - STETH_INACCURACY)
        })

        it("should create order", async () => {
            const orderTx = await subject.placeOrder()
            const orderReceipt = await orderTx.wait()

            if (!orderReceipt) throw new Error("No order receipt")

            const stonksInterface = Stonks__factory.createInterface()
            const orderEvent = stonksInterface.parseLog((orderReceipt as any).logs[orderReceipt.logs.length - 1])

            if (!orderEvent) throw new Error("No order")

            const steth = await ethers.getContractAt("IERC20", mainnet.STETH)
            order = await ethers.getContractAt("Order", orderEvent.args[0])

            expect(await order.tokenFrom()).to.equal(await subject.tokenFrom())
            expect(await steth.balanceOf(await order.getAddress())).to.greaterThanOrEqual(value - STETH_INACCURACY)
            expect(await steth.balanceOf(await subject.getAddress())).to.lessThanOrEqual(STETH_INACCURACY)
        })

        it("settlement should check hash", async() => {})
        it("should not be possible to cancel order due to expiration time", () => {})
        it ("should be possible to cancel order after expiration time", async () => {})

        it("settlement should pull off assets from order contract", async () => {
            await network.provider.request({
                method: "hardhat_impersonateAccount",
                params: [mainnet.SETTLEMENT],
            });
            const settlmentSigner = await ethers.provider.getSigner(mainnet.SETTLEMENT)
            const stethSettlement = await ethers.getContractAt("IERC20", mainnet.STETH, settlmentSigner)
            const orderAddress = await order.getAddress()

            await stethSettlement.transferFrom(
                orderAddress,
                mainnet.SETTLEMENT,
                await stethSettlement.balanceOf(await order.getAddress())
            )

            expect(await stethSettlement.balanceOf(await order.getAddress())).to.lessThanOrEqual(STETH_INACCURACY)
        })
    })
})