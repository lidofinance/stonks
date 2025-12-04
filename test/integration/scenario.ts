import { ethers, network } from 'hardhat'
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs'
import { expect } from 'chai'
import { parseEther, Signer, TransactionReceipt } from 'ethers'
import {
  setBalance,
  impersonateAccount,
  setCode,
  takeSnapshot,
  SnapshotRestorer,
  time,
} from '@nomicfoundation/hardhat-network-helpers'
import {
  setup,
  setupOverDeployedContracts,
  setupPriceSpikeStub,
  setupPriceImprovementStub,
  pairs,
  TokenPair,
  Setup,
} from './setup'
import { getContracts } from '../../utils/contracts'
import { IERC20, Stonks, Order } from '../../typechain-types'
import { MAGIC_VALUE } from '../../utils/gpv2-helpers'
import { getPlaceOrderData } from '../../utils/get-events'

const deployedContracts: string[] = []
const testItems: Array<TokenPair | string> = deployedContracts.length ? deployedContracts : pairs
const contracts = getContracts()

describe('Scenario test multi-pair', function () {
  testItems.forEach((item) => {
    const isStonksDeployed = typeof item === 'string'

    describe(`${isStonksDeployed ? item : (item as TokenPair).name}`, function () {
      let snapshot: SnapshotRestorer
      let snapshotOrderPlaced: SnapshotRestorer
      let value: bigint
      let stonks: Stonks
      let manager: Signer
      let tokenFrom: IERC20
      let expectedBuyAmount: bigint
      let orderReceipt: TransactionReceipt
      let order: Order

      this.beforeAll(async () => {
        snapshot = await takeSnapshot()

        let result: Setup

        if (isStonksDeployed) {
          result = await setupOverDeployedContracts(item as string)
        } else {
          result = await setup(item as TokenPair)
        }

        stonks = result.stonks
        value = result.value
        manager = result.manager

        tokenFrom = await ethers.getContractAt('IERC20', await stonks.TOKEN_FROM())

        await setBalance(await manager.getAddress(), parseEther('100'))
        await setBalance(contracts.AGENT, parseEther('100'))
      })

      this.afterAll(async () => {
        await snapshot.restore()
      })

      context('Setup', () => {
        it('agent should fill up a stonks with tokenFrom (EasyTrack imitation)', async function () {
          const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
          const token = tokenFrom.connect(treasurySigner)
          const currentBalance = await token.balanceOf(stonks)

          if (currentBalance > 0) {
            value = currentBalance
            this.skip()
          }

          await impersonateAccount(contracts.AGENT)

          const transferTx = await token.transfer(stonks, value)
          await transferTx.wait()

          const balance = await token.balanceOf(stonks)
          expect(balance).to.be.closeTo(value, 2n)
        })

        it('manager should successfully place an order', async () => {
          expectedBuyAmount = await stonks.estimateTradeOutputFromCurrentBalance()
          const orderTx = await stonks.placeOrder(expectedBuyAmount)

          orderReceipt = (await orderTx.wait())!
          if (!orderReceipt) throw new Error('No order receipt')

          const { address } = await getPlaceOrderData(orderReceipt)

          order = await ethers.getContractAt('Order', address)
          // stETH shares-based rounding: allow 4 wei tolerance for cumulative transfer precision loss
          expect(await tokenFrom.balanceOf(address)).to.be.closeTo(value, 4n)
          expect(await tokenFrom.balanceOf(stonks)).to.be.closeTo(BigInt(0), 2n)

          const [orderHashFromContract] = await order.getOrderDetails()
          expect(orderHashFromContract).to.match(/^0x[0-9a-fA-F]{64}$/)

          snapshotOrderPlaced = await takeSnapshot()
        })
      })

      context('Successful trade', () => {
        it('settlement should successfully check hash (isValidSignature)', async () => {
          const [currentHash] = await order.getOrderDetails()
          expect(await order.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
          await expect(order.isValidSignature(ethers.ZeroHash, '0x'))
            .to.be.revertedWithCustomError(order, 'InvalidOrderHash')
            .withArgs(currentHash, ethers.ZeroHash)
        })

        it('settlement should pull off assets from order contract (swap imitation)', async () => {
          await setCode(contracts.VAULT_RELAYER, ethers.ZeroHash)
          await setBalance(contracts.VAULT_RELAYER, ethers.parseEther('100'))
          await impersonateAccount(contracts.VAULT_RELAYER)

          const relayerSigner = await ethers.provider.getSigner(contracts.VAULT_RELAYER)
          const stethWithRelayerSigner = tokenFrom.connect(relayerSigner)

          await stethWithRelayerSigner.transferFrom(
            order,
            contracts.VAULT_RELAYER,
            await stethWithRelayerSigner.balanceOf(order)
          )

          expect(await stethWithRelayerSigner.balanceOf(order)).to.be.closeTo(BigInt(0), 1n)
        })
      })

      context('Order expired', () => {
        before(async () => {
          await snapshotOrderPlaced.restore()
        })
        it('should not be possible to cancel order due to expiration time', async () => {
          const orderDetails = await order.getOrderDetails()
          await expect(order.recoverTokenFrom())
            .to.be.revertedWithCustomError(order, 'OrderNotExpired')
            .withArgs(orderDetails[5], anyValue)
        })
        it('should be possible to recover tokenFrom after expiration time', async () => {
          await network.provider.send('evm_increaseTime', [
            Number(await stonks.ORDER_DURATION_IN_SECONDS()) + 1,
          ])
          await order.recoverTokenFrom()

          expect(await tokenFrom.balanceOf(order)).to.be.closeTo(BigInt(0), 1n)
        })
        it('should be invalid after order expiration', async () => {
          const [currentHash, , , , , validTo] = await order.getOrderDetails()
          await expect(order.isValidSignature(currentHash, '0x'))
            .to.be.revertedWithCustomError(order, 'OrderExpired')
            .withArgs(validTo)
        })
      })

      context('Market price spike', () => {
        before(async () => {
          await snapshotOrderPlaced.restore()
        })
        it('settlement should successfully check hash', async () => {
          const [currentHash] = await order.getOrderDetails()
          expect(await order.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
          await expect(order.isValidSignature(ethers.ZeroHash, '0x'))
            .to.be.revertedWithCustomError(order, 'InvalidOrderHash')
            .withArgs(currentHash, ethers.ZeroHash)
        })
        it('should change stonks amount converter address', async () => {
          await setupPriceSpikeStub(stonks, manager)

          const [currentHash] = await order.getOrderDetails()
          await expect(order.isValidSignature(currentHash, '0x')).to.be.revertedWithCustomError(
            order,
            'PriceShortfallExceedsTolerance'
          )
        })
        it('should be possible to recover tokenFrom after price spike', async () => {
          await time.increase((await stonks.ORDER_DURATION_IN_SECONDS()) + 1n)
          await order.recoverTokenFrom()

          expect(await tokenFrom.balanceOf(order)).to.be.closeTo(BigInt(0), 1n)
        })
        it('should create a new order for new market conditions', async () => {
          const expectedBuyAmount = await stonks.estimateTradeOutputFromCurrentBalance()
          const orderTx = await stonks.placeOrder(expectedBuyAmount)

          const orderReceipt = (await orderTx.wait())!
          if (!orderReceipt) throw new Error('No order receipt')

          const { address } = await getPlaceOrderData(orderReceipt)

          const newOrder = await ethers.getContractAt('Order', address)
          expect(await tokenFrom.balanceOf(address)).to.be.closeTo(value, 5n)
          expect(await tokenFrom.balanceOf(stonks)).to.be.closeTo(BigInt(0), 5n)

          const [orderHashFromContract] = await newOrder.getOrderDetails()
          expect(orderHashFromContract).to.match(/^0x[0-9a-fA-F]{64}$/)
          expect(await newOrder.getAddress()).to.not.be.equal(await order.getAddress())
        })
      })
      context('Manager change', () => {
        before(async () => {
          await snapshotOrderPlaced.restore()
        })
        it('admin should change a manager', async () => {
          const admin = await ethers.getImpersonatedSigner(contracts.ADMIN)
          await ethers.provider.send('hardhat_setBalance', [
            contracts.ADMIN,
            '0x1000000000000000000',
          ])
          await stonks.connect(admin).setManager(ethers.ZeroAddress)
          expect(await stonks.manager()).to.be.equal(ethers.ZeroAddress)
        })
        it('manager should not be allowed to interact', async () => {
          await expect(stonks.placeOrder(1))
            .to.be.revertedWithCustomError(stonks, 'NotAdminOrManager')
            .withArgs(await manager.getAddress())
        })
      })
      context('Unexpected tokens', () => {
        let stubToken: any
        before(async () => {
          await snapshotOrderPlaced.restore()

          const stubTokenFactory = await ethers.getContractFactory('ERC_20')
          stubToken = await stubTokenFactory.deploy()
          await stubToken.waitForDeployment()
        })
        it('should fill up stonks with unexpected token', async () => {
          const value = parseEther('1')
          await stubToken.transfer(contracts.AGENT, value)
          // Use a regular signer to transfer tokens to stonks (not agent, as agent is only fund recipient)
          const [deployer] = await ethers.getSigners()
          await stubToken.connect(deployer).transfer(stonks, value)

          expect(await stubToken.balanceOf(stonks)).to.equal(value)
        })
        it('manager should recover unexpected token', async () => {
          const agentBalanceBefore = await stubToken.balanceOf(contracts.AGENT)
          const value = await stubToken.balanceOf(stonks)
          await stonks.connect(manager).recoverERC20(stubToken, value)
          expect(await stubToken.balanceOf(stonks)).to.equal(0)
          expect(await stubToken.balanceOf(contracts.AGENT)).to.equal(agentBalanceBefore + value)
        })
        it('should fill up order contract with unexpected token', async () => {
          const value = parseEther('1')
          await stubToken.transfer(contracts.AGENT, value)
          // Use a regular signer to transfer tokens to order (not agent, as agent is only fund recipient)
          const [deployer] = await ethers.getSigners()
          await stubToken.connect(deployer).transfer(order, value)

          expect(await stubToken.balanceOf(order)).to.be.closeTo(value, 1n)
        })
        it('manager should recover unexpected token from order contract', async () => {
          const agentBalanceBefore = await stubToken.balanceOf(contracts.AGENT)
          const value = await stubToken.balanceOf(order)
          await order.connect(manager).recoverERC20(stubToken, value)
          expect(await stubToken.balanceOf(stonks)).to.equal(0)
          expect(await stubToken.balanceOf(contracts.AGENT)).to.equal(agentBalanceBefore + value)
        })
      })

      context('Price improvement scenarios', () => {
        let snapshotBeforeOrder: SnapshotRestorer
        let stonksWithCap: Stonks
        let stonksStrict: Stonks
        let orderWithCap: Order
        let orderStrict: Order

        before(async () => {
          await snapshotOrderPlaced.restore()
        })

        it('should revert when price improvement exceeds cap', async function () {
          snapshotBeforeOrder = await takeSnapshot()

          // Reuse existing setup - deploy new stonks with maxImprovement = 100 bps
          const stonksFactory = await ethers.getContractFactory('Stonks')
          const amountConverter = await ethers.getContractAt(
            'AmountConverter',
            await stonks.AMOUNT_CONVERTER()
          )
          const orderSample = await stonks.ORDER_SAMPLE()

          stonksWithCap = await stonksFactory.deploy({
            admin: contracts.ADMIN,
            agent: contracts.AGENT,
            manager: await manager.getAddress(),
            tokenFrom: await stonks.TOKEN_FROM(),
            tokenTo: await stonks.TOKEN_TO(),
            amountConverter: await amountConverter.getAddress(),
            orderSample: orderSample,
            orderDurationInSeconds: await stonks.ORDER_DURATION_IN_SECONDS(),
            marginInBasisPoints: await stonks.MARGIN_IN_BASIS_POINTS(),
            priceToleranceInBasisPoints: await stonks.PRICE_TOLERANCE_IN_BASIS_POINTS(),
            maxImprovementInBasisPoints: 100n, // maxImprovement = 100 bps (1%)
            allowPartialFill: await stonks.ALLOW_PARTIAL_FILL(),
          })
          await stonksWithCap.waitForDeployment()

          // Fund stonks
          const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
          await impersonateAccount(contracts.AGENT)
          const token = tokenFrom.connect(treasurySigner)
          await token.transfer(await stonksWithCap.getAddress(), value)

          // Place order
          const expectedBuyAmount = await stonksWithCap.estimateTradeOutputFromCurrentBalance()
          const orderTx = await stonksWithCap.placeOrder(expectedBuyAmount)
          const orderReceipt = (await orderTx.wait())!
          const { address } = await getPlaceOrderData(orderReceipt)
          orderWithCap = await ethers.getContractAt('Order', address)

          // Simulate price improvement that exceeds cap (e.g., 2% improvement when cap is 1%)
          await setupPriceImprovementStub(stonksWithCap, manager, 200n) // 2% improvement

          const [currentHash] = await orderWithCap.getOrderDetails()
          await expect(
            orderWithCap.isValidSignature(currentHash, '0x')
          ).to.be.revertedWithCustomError(orderWithCap, 'PriceImprovementExceedsLimit')

          await snapshotBeforeOrder.restore()
        })

        it('should revert in strict mode (maxImprovement = 0) when price improves', async function () {
          snapshotBeforeOrder = await takeSnapshot()

          // Reuse existing setup - deploy new stonks with strict mode
          const stonksFactory = await ethers.getContractFactory('Stonks')
          const amountConverter = await ethers.getContractAt(
            'AmountConverter',
            await stonks.AMOUNT_CONVERTER()
          )
          const orderSample = await stonks.ORDER_SAMPLE()

          stonksStrict = await stonksFactory.deploy({
            admin: contracts.ADMIN,
            agent: contracts.AGENT,
            manager: await manager.getAddress(),
            tokenFrom: await stonks.TOKEN_FROM(),
            tokenTo: await stonks.TOKEN_TO(),
            amountConverter: await amountConverter.getAddress(),
            orderSample: orderSample,
            orderDurationInSeconds: await stonks.ORDER_DURATION_IN_SECONDS(),
            marginInBasisPoints: await stonks.MARGIN_IN_BASIS_POINTS(),
            priceToleranceInBasisPoints: await stonks.PRICE_TOLERANCE_IN_BASIS_POINTS(),
            maxImprovementInBasisPoints: 0n, // maxImprovement = 0 (strict mode)
            allowPartialFill: await stonks.ALLOW_PARTIAL_FILL(),
          })
          await stonksStrict.waitForDeployment()

          // Fund stonks
          const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
          await impersonateAccount(contracts.AGENT)
          const token = tokenFrom.connect(treasurySigner)
          await token.transfer(await stonksStrict.getAddress(), value)

          // Place order
          const expectedBuyAmount = await stonksStrict.estimateTradeOutputFromCurrentBalance()
          const orderTx = await stonksStrict.placeOrder(expectedBuyAmount)
          const orderReceipt = (await orderTx.wait())!
          const { address } = await getPlaceOrderData(orderReceipt)
          orderStrict = await ethers.getContractAt('Order', address)

          // Simulate any price improvement (even small)
          await setupPriceImprovementStub(stonksStrict, manager, 50n) // 0.5% improvement

          const [currentHash] = await orderStrict.getOrderDetails()
          await expect(
            orderStrict.isValidSignature(currentHash, '0x')
          ).to.be.revertedWithCustomError(orderStrict, 'PriceImprovementRejectedInStrictMode')

          await snapshotBeforeOrder.restore()
        })

        it('should accept price improvement within cap', async function () {
          snapshotBeforeOrder = await takeSnapshot()

          // Reuse existing setup - deploy new stonks with maxImprovement = 100 bps
          const stonksFactory = await ethers.getContractFactory('Stonks')
          const amountConverter = await ethers.getContractAt(
            'AmountConverter',
            await stonks.AMOUNT_CONVERTER()
          )
          const orderSample = await stonks.ORDER_SAMPLE()

          stonksWithCap = await stonksFactory.deploy({
            admin: contracts.ADMIN,
            agent: contracts.AGENT,
            manager: await manager.getAddress(),
            tokenFrom: await stonks.TOKEN_FROM(),
            tokenTo: await stonks.TOKEN_TO(),
            amountConverter: await amountConverter.getAddress(),
            orderSample: orderSample,
            orderDurationInSeconds: await stonks.ORDER_DURATION_IN_SECONDS(),
            marginInBasisPoints: await stonks.MARGIN_IN_BASIS_POINTS(),
            priceToleranceInBasisPoints: await stonks.PRICE_TOLERANCE_IN_BASIS_POINTS(),
            maxImprovementInBasisPoints: 100n, // maxImprovement = 100 bps (1%)
            allowPartialFill: await stonks.ALLOW_PARTIAL_FILL(),
          })
          await stonksWithCap.waitForDeployment()

          // Fund stonks
          const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
          await impersonateAccount(contracts.AGENT)
          const token = tokenFrom.connect(treasurySigner)
          await token.transfer(await stonksWithCap.getAddress(), value)

          // Place order
          const expectedBuyAmount = await stonksWithCap.estimateTradeOutputFromCurrentBalance()
          const orderTx = await stonksWithCap.placeOrder(expectedBuyAmount)
          const orderReceipt = (await orderTx.wait())!
          const { address } = await getPlaceOrderData(orderReceipt)
          orderWithCap = await ethers.getContractAt('Order', address)

          // Simulate price improvement within cap (e.g., 0.5% improvement when cap is 1%)
          await setupPriceImprovementStub(stonksWithCap, manager, 50n) // 0.5% improvement

          const [currentHash] = await orderWithCap.getOrderDetails()
          expect(await orderWithCap.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)

          await snapshotBeforeOrder.restore()
        })
      })

      this.afterAll(async () => {
        await snapshot.restore()
      })
    })
  })
})
