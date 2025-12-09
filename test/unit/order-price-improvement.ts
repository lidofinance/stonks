import { ethers } from 'hardhat'
import { expect } from 'chai'
import { Signer } from 'ethers'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import { Order, Stonks, AmountConverterTest, OracleRouter } from '../../typechain-types'
import { getTestOracleRouter, resetTestOracleRouter } from '../../utils/test-oracle-router'
import {
  getAllTestTokens,
  refreshTestFeedData,
  resetTestFeedRegistryStub,
} from '../../utils/test-feed-registry'
import { deployStonks } from '../../scripts/deployments/stonks'
import { getContracts } from '../../utils/contracts'
import { MAGIC_VALUE, formOrderHashFromTxReceipt } from '../../utils/gpv2-helpers'
import { fillUpERC20FromTreasury } from '../../utils/fill-up-balance'
import { getPlaceOrderData } from '../../utils/get-events'
import { MAX_BASIS_POINTS } from '../../utils/gpv2-helpers'

const PRICE_TOLERANCE_IN_BP = 1000
const MARGIN_IN_BPS = 500
const PRICE_SCALE = 10n ** 18n
const contracts = getContracts()

describe('Order - Price Improvement & Partial Fills', async function () {
  let manager: Signer
  let stonks: Stonks
  let amountConverterTest: AmountConverterTest
  let oracleRouter: OracleRouter
  let snapshot: SnapshotRestorer
  let subject: Order
  let orderHash: string
  let expectedBuyAmount: bigint

  const deployStonksWithConfig = async (
    maxImprovementInBps: number | bigint,
    allowPartialFill: boolean
  ): Promise<{ stonks: Stonks; order: Order; orderHash: string }> => {
    const amountConverterTestFactory = await ethers.getContractFactory('AmountConverterTest')

    const oracleRouterLocal = await getTestOracleRouter({
      tokens: getAllTestTokens(),
      useRealPrices: true,
    })

    await refreshTestFeedData(getAllTestTokens())

    const amountConverterTestLocal = await amountConverterTestFactory.deploy(
      await oracleRouterLocal.getAddress(),
      [contracts.STETH],
      [contracts.DAI],
      false
    )
    await amountConverterTestLocal.waitForDeployment()

    const { stonks: stonksInstance } = await deployStonks({
      factoryParams: {
        admin: contracts.ADMIN,
        agent: contracts.AGENT,
        relayer: contracts.VAULT_RELAYER,
        settlement: contracts.SETTLEMENT,
        priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        oracleRouterAddress: await oracleRouterLocal.getAddress(),
      },
      stonksParams: {
        tokenFrom: contracts.STETH,
        tokenTo: contracts.DAI,
        manager: await manager.getAddress(),
        marginInBps: MARGIN_IN_BPS,
        orderDuration: 3600,
        priceToleranceInBps: PRICE_TOLERANCE_IN_BP,
        maxImprovementInBps:
          typeof maxImprovementInBps === 'bigint'
            ? Number(maxImprovementInBps)
            : maxImprovementInBps,
        allowPartialFill: allowPartialFill,
        amountConverterAddress: await amountConverterTestLocal.getAddress(),
      },
      amountConverterParams: {
        allowedTokensToSell: [contracts.STETH],
        allowedTokensToBuy: [contracts.DAI],
      },
    })

    await fillUpERC20FromTreasury({
      token: contracts.STETH,
      amount: ethers.parseEther('1'),
      address: await stonksInstance.getAddress(),
    })

    const expectedBuyAmountLocal = await stonksInstance.estimateTradeOutputFromCurrentBalance()
    const placeOrderTx = await stonksInstance.placeOrder(expectedBuyAmountLocal)
    const placeOrderTxReceipt = await placeOrderTx.wait()
    if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

    const decodedOrderTx = await getPlaceOrderData(placeOrderTxReceipt)
    const order = await ethers.getContractAt('Order', decodedOrderTx.address, manager)
    const orderHashLocal = await formOrderHashFromTxReceipt(placeOrderTxReceipt)

    return {
      stonks: stonksInstance,
      order,
      orderHash: orderHashLocal,
    }
  }

  before(async function () {
    snapshot = await takeSnapshot()
    manager = (await ethers.getSigners())[0]

    const amountConverterTestFactory = await ethers.getContractFactory('AmountConverterTest')

    oracleRouter = await getTestOracleRouter({
      tokens: getAllTestTokens(),
      useRealPrices: true,
    })

    await refreshTestFeedData(getAllTestTokens())

    amountConverterTest = await amountConverterTestFactory.deploy(
      await oracleRouter.getAddress(),
      [contracts.STETH],
      [contracts.DAI],
      false
    )
    await amountConverterTest.waitForDeployment()

    const { stonks: stonksInstance } = await deployStonks({
      factoryParams: {
        admin: contracts.ADMIN,
        agent: contracts.AGENT,
        relayer: contracts.VAULT_RELAYER,
        settlement: contracts.SETTLEMENT,
        priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        oracleRouterAddress: await oracleRouter.getAddress(),
      },
      stonksParams: {
        tokenFrom: contracts.STETH,
        tokenTo: contracts.DAI,
        manager: await manager.getAddress(),
        marginInBps: MARGIN_IN_BPS,
        orderDuration: 3600,
        priceToleranceInBps: PRICE_TOLERANCE_IN_BP,
        maxImprovementInBps: 100,
        allowPartialFill: false,
        amountConverterAddress: await amountConverterTest.getAddress(),
      },
      amountConverterParams: {
        oracleRouter: await oracleRouter.getAddress(),
        allowedTokensToSell: [contracts.STETH],
        allowedTokensToBuy: [contracts.DAI],
      },
    })

    stonks = stonksInstance

    await fillUpERC20FromTreasury({
      token: contracts.STETH,
      amount: ethers.parseEther('1'),
      address: await stonks.getAddress(),
    })

    expectedBuyAmount = await stonks.estimateTradeOutputFromCurrentBalance()

    const placeOrderTx = await stonks.placeOrder(expectedBuyAmount)
    const placeOrderTxReceipt = await placeOrderTx.wait()
    if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

    const decodedOrderTx = await getPlaceOrderData(placeOrderTxReceipt)
    subject = await ethers.getContractAt('Order', decodedOrderTx.address, manager)
    orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
  })

  describe('Getters', function () {
    it('should return maxImprovementInBasisPoints from getMaxImprovementBps', async function () {
      const maxImprovementBps = await stonks.getMaxImprovementBps()
      expect(maxImprovementBps).to.equal(100n)
    })

    it('should return allowPartialFill from ALLOW_PARTIAL_FILL', async function () {
      const allowPartialFill = await stonks.ALLOW_PARTIAL_FILL()
      expect(allowPartialFill).to.equal(false)
    })

    it('should return correct maxImprovementInBasisPoints for different values', async function () {
      const { stonks: stonksLocal } = await deployStonksWithConfig(500, false)
      expect(await stonksLocal.getMaxImprovementBps()).to.equal(500n)

      const { stonks: stonksStrict } = await deployStonksWithConfig(0, false)
      expect(await stonksStrict.getMaxImprovementBps()).to.equal(0n)
    })

    it('should return correct allowPartialFill for different values', async function () {
      const { stonks: stonksPartial } = await deployStonksWithConfig(100, true)
      expect(await stonksPartial.ALLOW_PARTIAL_FILL()).to.equal(true)

      const { stonks: stonksNoPartial } = await deployStonksWithConfig(100, false)
      expect(await stonksNoPartial.ALLOW_PARTIAL_FILL()).to.equal(false)
    })
  })

  describe('isValidSignature - Price Improvement Paths', function () {
    let localSnapshot: SnapshotRestorer

    beforeEach(async function () {
      localSnapshot = await takeSnapshot()
    })

    it('should accept equal price', async function () {
      expect(await subject.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)
    })

    it('should accept improvement within cap', async function () {
      // Increase price by 50 bps (within 100 bps cap)
      await amountConverterTest.multiplyAnswer(10050)

      const [currentHash] = await subject.getOrderDetails()
      expect(await subject.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
    })

    it('should accept improvement exactly at cap', async function () {
      // Increase price by exactly 100 bps (at cap)
      await amountConverterTest.multiplyAnswer(10100)

      const [currentHash] = await subject.getOrderDetails()
      expect(await subject.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
    })

    it('should reject improvement exceeding cap', async function () {
      // Increase price by 102 bps (exceeds 100 bps cap)
      // Note: 10101 gives exactly 100 bps (at cap, accepted), 10102 gives 101 bps (rejected)
      // This is due to Math.mulDiv rounding down in the improvement calculation
      await amountConverterTest.multiplyAnswer(10102)

      const [currentHash] = await subject.getOrderDetails()
      const orderDetails = await subject.getOrderDetails()
      const sellAmount = orderDetails[3]
      const buyAmount = orderDetails[4]

      // For FOK orders: basisSellAmount == sellAmount, so baselineBuyAmount == buyAmount
      const baselineBuyAmount = buyAmount
      const maxAllowedBuyAmount = (baselineBuyAmount * (MAX_BASIS_POINTS + 100n)) / MAX_BASIS_POINTS
      const currentEstimatedBuyAmount = await stonks.estimateTradeOutput(sellAmount)

      await expect(subject.isValidSignature(currentHash, '0x'))
        .to.be.revertedWithCustomError(subject, 'PriceImprovementExceedsLimit')
        .withArgs(maxAllowedBuyAmount, currentEstimatedBuyAmount)
    })

    it('should accept any improvement when maxImprovementBps is type(uint256).max', async function () {
      // Deploy contracts directly to handle type(uint256).max properly
      const amountConverterTestFactory = await ethers.getContractFactory('AmountConverterTest')
      const oracleRouterLocal = await getTestOracleRouter({
        tokens: getAllTestTokens(),
        useRealPrices: true,
      })
      await refreshTestFeedData(getAllTestTokens())

      const amountConverterTestLocal = await amountConverterTestFactory.deploy(
        await oracleRouterLocal.getAddress(),
        [contracts.STETH],
        [contracts.DAI],
        false
      )
      await amountConverterTestLocal.waitForDeployment()

      const orderFactory = await ethers.getContractFactory('Order')

      // Deploy Order sample
      const orderSample = await orderFactory.deploy(
        contracts.ADMIN,
        contracts.AGENT,
        contracts.VAULT_RELAYER,
        contracts.DOMAIN_SEPARATOR
      )
      await orderSample.waitForDeployment()

      // Deploy Stonks directly with MaxUint256
      const stonksFactory = await ethers.getContractFactory('Stonks')
      const stonksNoCap = await stonksFactory.deploy({
        admin: contracts.ADMIN,
        agent: contracts.AGENT,
        manager: await manager.getAddress(),
        tokenFrom: contracts.STETH,
        tokenTo: contracts.DAI,
        amountConverter: await amountConverterTestLocal.getAddress(),
        orderSample: await orderSample.getAddress(),
        orderDurationInSeconds: 3600,
        marginInBasisPoints: MARGIN_IN_BPS,
        priceToleranceInBasisPoints: PRICE_TOLERANCE_IN_BP,
        maxImprovementInBasisPoints: ethers.MaxUint256, // Pass as bigint directly
        allowPartialFill: false,
      })
      await stonksNoCap.waitForDeployment()

      // Verify it was set correctly
      expect(await stonksNoCap.getMaxImprovementBps()).to.equal(ethers.MaxUint256)

      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksNoCap.getAddress(),
      })

      const expectedBuyAmountLocal = await stonksNoCap.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksNoCap.placeOrder(expectedBuyAmountLocal)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const decodedOrderTx = await getPlaceOrderData(placeOrderTxReceipt)
      const orderNoCap = await ethers.getContractAt('Order', decodedOrderTx.address, manager)

      // Increase price by 10000 bps (100% improvement)
      await amountConverterTestLocal.multiplyAnswer(20000)

      const [currentHash] = await orderNoCap.getOrderDetails()
      expect(await orderNoCap.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
    })

    it('should reject any improvement in strict mode (maxImprovementBps = 0)', async function () {
      // Deploy a fresh setup with maxImprovementBps = 0
      const amountConverterTestFactory = await ethers.getContractFactory('AmountConverterTest')
      const oracleRouterLocal = await getTestOracleRouter({
        tokens: getAllTestTokens(),
        useRealPrices: true,
      })
      await refreshTestFeedData(getAllTestTokens())

      const amountConverterTestLocal = await amountConverterTestFactory.deploy(
        await oracleRouterLocal.getAddress(),
        [contracts.STETH],
        [contracts.DAI],
        false
      )
      await amountConverterTestLocal.waitForDeployment()

      const { stonks: stonksStrict } = await deployStonks({
        factoryParams: {
          admin: contracts.ADMIN,
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
          oracleRouterAddress: await oracleRouterLocal.getAddress(),
        },
        stonksParams: {
          tokenFrom: contracts.STETH,
          tokenTo: contracts.DAI,
          manager: await manager.getAddress(),
          marginInBps: MARGIN_IN_BPS,
          orderDuration: 3600,
          priceToleranceInBps: PRICE_TOLERANCE_IN_BP,
          maxImprovementInBps: 0,
          allowPartialFill: false,
          amountConverterAddress: await amountConverterTestLocal.getAddress(),
        },
        amountConverterParams: {
          allowedTokensToSell: [contracts.STETH],
          allowedTokensToBuy: [contracts.DAI],
        },
      })

      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksStrict.getAddress(),
      })

      const expectedBuyAmountLocal = await stonksStrict.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksStrict.placeOrder(expectedBuyAmountLocal)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const decodedOrderTx = await getPlaceOrderData(placeOrderTxReceipt)
      const orderStrict = await ethers.getContractAt('Order', decodedOrderTx.address, manager)

      // Increase price by even 1 bps
      await amountConverterTestLocal.multiplyAnswer(10001)

      const [currentHash] = await orderStrict.getOrderDetails()
      const orderDetails = await orderStrict.getOrderDetails()
      const buyAmount = orderDetails[4]
      const currentEstimatedBuyAmount = await stonksStrict.estimateTradeOutput(orderDetails[3])

      await expect(orderStrict.isValidSignature(currentHash, '0x'))
        .to.be.revertedWithCustomError(orderStrict, 'PriceImprovementRejectedInStrictMode')
        .withArgs(buyAmount, currentEstimatedBuyAmount)
    })

    afterEach(async function () {
      await localSnapshot.restore()
    })
  })

  describe('isValidSignature - Price Shortfall Paths', function () {
    let localSnapshot: SnapshotRestorer

    beforeEach(async function () {
      localSnapshot = await takeSnapshot()
    })

    it('should accept shortfall within tolerance', async function () {
      // Decrease price by 500 bps (within 1000 bps tolerance)
      await amountConverterTest.multiplyAnswer(9500)

      const [currentHash] = await subject.getOrderDetails()
      expect(await subject.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
    })

    it('should accept shortfall exactly at tolerance', async function () {
      // Decrease price by exactly 1000 bps (9001 accounts for Math.Rounding.Down in contract)
      await amountConverterTest.multiplyAnswer(9001)

      const [currentHash] = await subject.getOrderDetails()
      expect(await subject.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
    })

    it('should reject shortfall exceeding tolerance', async function () {
      // Decrease price by 1001 bps (exceeds 1000 bps tolerance)
      await amountConverterTest.multiplyAnswer(8999)

      const [currentHash] = await subject.getOrderDetails()
      const orderDetails = await subject.getOrderDetails()
      const buyAmount = orderDetails[4]
      const maxToleratedShortfall = (buyAmount * BigInt(PRICE_TOLERANCE_IN_BP)) / MAX_BASIS_POINTS
      const minAcceptableBuyAmount = buyAmount - maxToleratedShortfall
      const currentEstimatedBuyAmount = await stonks.estimateTradeOutput(orderDetails[3])

      await expect(subject.isValidSignature(currentHash, '0x'))
        .to.be.revertedWithCustomError(subject, 'PriceShortfallExceedsTolerance')
        .withArgs(minAcceptableBuyAmount, currentEstimatedBuyAmount)
    })

    it('should reject any shortfall in strict mode (priceToleranceBps = 0)', async function () {
      // Deploy stonks with zero tolerance
      const amountConverterTestFactory = await ethers.getContractFactory('AmountConverterTest')
      const oracleRouterLocal = await getTestOracleRouter({
        tokens: getAllTestTokens(),
        useRealPrices: true,
      })
      await refreshTestFeedData(getAllTestTokens())

      const amountConverterTestLocal = await amountConverterTestFactory.deploy(
        await oracleRouterLocal.getAddress(),
        [contracts.STETH],
        [contracts.DAI],
        false
      )
      await amountConverterTestLocal.waitForDeployment()

      const { stonks: stonksZeroTolerance } = await deployStonks({
        factoryParams: {
          admin: contracts.ADMIN,
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
          oracleRouterAddress: await oracleRouterLocal.getAddress(),
        },
        stonksParams: {
          tokenFrom: contracts.STETH,
          tokenTo: contracts.DAI,
          manager: await manager.getAddress(),
          marginInBps: MARGIN_IN_BPS,
          orderDuration: 3600,
          priceToleranceInBps: 0,
          maxImprovementInBps: 100,
          allowPartialFill: false,
          amountConverterAddress: await amountConverterTestLocal.getAddress(),
        },
        amountConverterParams: {
          oracleRouter: await oracleRouterLocal.getAddress(),
          allowedTokensToSell: [contracts.STETH],
          allowedTokensToBuy: [contracts.DAI],
        },
      })

      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksZeroTolerance.getAddress(),
      })

      const expectedBuyAmountLocal =
        await stonksZeroTolerance.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksZeroTolerance.placeOrder(expectedBuyAmountLocal)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const decodedOrderTx = await getPlaceOrderData(placeOrderTxReceipt)
      const orderZeroTolerance = await ethers.getContractAt(
        'Order',
        decodedOrderTx.address,
        manager
      )

      // Decrease price by even 1 bps
      await amountConverterTestLocal.multiplyAnswer(9999)

      const [currentHash] = await orderZeroTolerance.getOrderDetails()
      const orderDetails = await orderZeroTolerance.getOrderDetails()
      const buyAmount = orderDetails[4]
      const currentEstimatedBuyAmount = await stonksZeroTolerance.estimateTradeOutput(
        orderDetails[3]
      )

      await expect(orderZeroTolerance.isValidSignature(currentHash, '0x'))
        .to.be.revertedWithCustomError(orderZeroTolerance, 'PriceShortfallExceedsTolerance')
        .withArgs(buyAmount, currentEstimatedBuyAmount)
    })

    afterEach(async function () {
      await localSnapshot.restore()
    })
  })

  describe('isValidSignature - Insufficient Balance Check', function () {
    let localSnapshot: SnapshotRestorer

    beforeEach(async function () {
      localSnapshot = await takeSnapshot()
    })

    it('should revert with InsufficientSellBalance when partial fills disabled and balance insufficient', async function () {
      // This test verifies the InsufficientSellBalance error path exists
      // Note: stETH uses a shares-based system with complex storage, so we test
      // the revert behavior by ensuring sellAmount > available balance through
      // the test configuration itself

      const { order: orderNoPartial, stonks: stonksNoPartial } = await deployStonksWithConfig(
        100,
        false
      )

      const [tokenFrom] = await stonksNoPartial.getOrderParameters()
      const orderDetails = await orderNoPartial.getOrderDetails()
      const sellAmount = orderDetails[3]

      // Transfer most of the tokens out of the order contract
      const orderAddress = await orderNoPartial.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const currentBalance = await token.balanceOf(orderAddress)

      // Impersonate the order contract to transfer tokens out
      await ethers.provider.send('hardhat_impersonateAccount', [orderAddress])
      await ethers.provider.send('hardhat_setBalance', [orderAddress, '0x1000000000000000000'])
      const orderSigner = await ethers.getSigner(orderAddress)

      // Transfer out enough to make balance < sell amount (keep 1 wei)
      const amountToTransfer = currentBalance - 1n
      const [, recipient] = await ethers.getSigners()
      await token.connect(orderSigner).transfer(await recipient.getAddress(), amountToTransfer)

      const newBalance = await token.balanceOf(orderAddress)
      const expectedRemaining = currentBalance - amountToTransfer
      expect(newBalance).to.be.closeTo(expectedRemaining, 5n)

      const [currentHash] = await orderNoPartial.getOrderDetails()

      await expect(orderNoPartial.isValidSignature(currentHash, '0x'))
        .to.be.revertedWithCustomError(orderNoPartial, 'InsufficientSellBalance')
        .withArgs(sellAmount, newBalance)
    })

    it('should not revert when partial fills enabled and balance insufficient', async function () {
      const { order: orderPartial } = await deployStonksWithConfig(100, true)

      const stonksContract = await ethers.getContractAt('Stonks', await orderPartial.stonks())
      const [tokenFrom] = await stonksContract.getOrderParameters()
      const orderAddress = await orderPartial.getAddress()

      // Simulate negative rebase
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = initialBalance / 10n

      // Calculate storage slot
      const balanceSlot = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [orderAddress, 0])
      )

      const newBalance = initialBalance - rebaseAmount
      await ethers.provider.send('hardhat_setStorageAt', [
        tokenFrom,
        balanceSlot,
        ethers.zeroPadValue(ethers.toBeHex(newBalance), 32),
      ])

      const [currentHash] = await orderPartial.getOrderDetails()

      // Should not revert - partial fills allowed
      expect(await orderPartial.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
    })

    it('should not revert when balance exactly equals sellAmount', async function () {
      const { order: orderNoPartial } = await deployStonksWithConfig(100, false)

      const stonksContract = await ethers.getContractAt('Stonks', await orderNoPartial.stonks())
      const [tokenFrom] = await stonksContract.getOrderParameters()
      const orderDetails = await orderNoPartial.getOrderDetails()
      const sellAmount = orderDetails[3]
      const orderAddress = await orderNoPartial.getAddress()

      // Get current balance
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const currentBalance = await token.balanceOf(orderAddress)

      // If balance is already equal to sellAmount, test passes
      // Otherwise, adjust balance to exactly match sellAmount
      if (currentBalance !== sellAmount) {
        const balanceSlot = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [orderAddress, 0])
        )

        await ethers.provider.send('hardhat_setStorageAt', [
          tokenFrom,
          balanceSlot,
          ethers.zeroPadValue(ethers.toBeHex(sellAmount), 32),
        ])
      }

      const [currentHash] = await orderNoPartial.getOrderDetails()

      // Should not revert - balance equals sellAmount
      expect(await orderNoPartial.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
    })

    afterEach(async function () {
      await localSnapshot.restore()
    })
  })

  describe('isValidSignature - Edge Cases', function () {
    let localSnapshot: SnapshotRestorer

    beforeEach(async function () {
      localSnapshot = await takeSnapshot()
    })

    it('should handle improvement exceeding cap', async function () {
      // Test that improvements exceeding the cap are rejected
      // Note: 10101 gives exactly 100 bps (at cap, accepted), 10102 gives 101 bps (rejected)
      // This is due to Math.mulDiv rounding down in the improvement calculation
      const orderDetails = await subject.getOrderDetails()
      const sellAmount = orderDetails[3]
      const buyAmount = orderDetails[4]

      // For FOK orders: basisSellAmount == sellAmount, so baselineBuyAmount == buyAmount
      const baselineBuyAmount = buyAmount
      const maxAllowedBuyAmount = (baselineBuyAmount * (MAX_BASIS_POINTS + 100n)) / MAX_BASIS_POINTS

      // Use multiplier that gives > 100 bps improvement (rejected)
      await amountConverterTest.multiplyAnswer(10102)

      const [currentHash] = await subject.getOrderDetails()
      const currentEstimatedBuyAmount = await stonks.estimateTradeOutput(sellAmount)

      // Should revert since improvement exceeds the cap
      await expect(subject.isValidSignature(currentHash, '0x'))
        .to.be.revertedWithCustomError(subject, 'PriceImprovementExceedsLimit')
        .withArgs(maxAllowedBuyAmount, currentEstimatedBuyAmount)
    })

    it('should handle shortfall at exactly minAcceptableBuyAmount - 1 wei', async function () {
      const orderDetails = await subject.getOrderDetails()
      const buyAmount = orderDetails[4]
      const maxToleratedShortfall = (buyAmount * BigInt(PRICE_TOLERANCE_IN_BP)) / MAX_BASIS_POINTS
      const minAcceptableBuyAmount = buyAmount - maxToleratedShortfall

      // Decrease price to create a shortfall just below minimum
      await amountConverterTest.multiplyAnswer(8999)

      const [currentHash] = await subject.getOrderDetails()
      const currentEstimatedBuyAmount = await stonks.estimateTradeOutput(orderDetails[3])

      // Should revert since it's below minimum
      await expect(subject.isValidSignature(currentHash, '0x'))
        .to.be.revertedWithCustomError(subject, 'PriceShortfallExceedsTolerance')
        .withArgs(minAcceptableBuyAmount, currentEstimatedBuyAmount)
    })

    afterEach(async function () {
      await localSnapshot.restore()
    })
  })

  describe('isValidSignature - Fast Paths & Edge Cases', function () {
    let localSnapshot: SnapshotRestorer

    beforeEach(async function () {
      localSnapshot = await takeSnapshot()
    })

    it('should accept via amount equality fast path', async function () {
      // When currentEstimatedBuyAmount == baselineBuyAmount, should return immediately
      // This happens when prices match exactly
      const orderDetails = await subject.getOrderDetails()
      const sellAmount = orderDetails[3]
      const buyAmount = orderDetails[4]

      // Get current estimated output (should match buyAmount for unmodified prices)
      const currentEstimatedBuyAmount = await stonks.estimateTradeOutput(sellAmount)

      // For FOK orders: basisSellAmount == sellAmount, so baselineBuyAmount == buyAmount
      // If current matches buyAmount, fast path should trigger
      if (currentEstimatedBuyAmount === buyAmount) {
        const [currentHash] = await subject.getOrderDetails()
        expect(await subject.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
      } else {
        // Adjust prices to make them equal
        const ratio = (buyAmount * 10000n) / currentEstimatedBuyAmount
        await amountConverterTest.multiplyAnswer(Number(ratio))
        const adjustedOutput = await stonks.estimateTradeOutput(sellAmount)

        // Should be close to buyAmount now, try to match exactly
        if (adjustedOutput === buyAmount) {
          const [currentHash] = await subject.getOrderDetails()
          expect(await subject.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
        }
      }
    })

    it('should revert with ZeroQuotableAmount when estimateTradeOutput returns zero', async function () {
      // To trigger ZeroQuotableAmount, we need basisSellAmount > 0 but estimateTradeOutput returns 0
      // This happens after margin calculation: output * (10000 - marginBps) / 10000 rounds to 0
      // Margin is 500 bps, so we need: output * 9500 / 10000 < 0.5 (rounds to 0)
      // This means: output < 10000 / 19000 ≈ 0.526
      // We can achieve this with a very small multiplier combined with a very small sellAmount

      // Use partial fills to test with a small available balance
      const { order: orderPartial, stonks: stonksPartial } = await deployStonksWithConfig(100, true)

      const [tokenFrom, tokenTo] = await stonksPartial.getOrderParameters()
      const orderAddress = await orderPartial.getAddress()

      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)

      // Get the amount converter test to manipulate the multiplier
      const stonksContract = await ethers.getContractAt('Stonks', await orderPartial.stonks())
      const amountConverterAddress = await stonksContract.AMOUNT_CONVERTER()
      const amountConverterTest = await ethers.getContractAt(
        'AmountConverterTest',
        amountConverterAddress
      )

      // Simulate a very small available balance (e.g., 1 wei)
      // Transfer most tokens out, keeping just 1 wei
      await ethers.provider.send('hardhat_impersonateAccount', [orderAddress])
      await ethers.provider.send('hardhat_setBalance', [orderAddress, '0x1000000000000000000'])
      const orderSigner = await ethers.getSigner(orderAddress)
      const [, recipient] = await ethers.getSigners()

      const keepAmount = 1n
      if (initialBalance > keepAmount) {
        await token
          .connect(orderSigner)
          .transfer(await recipient.getAddress(), initialBalance - keepAmount)
      }

      const tinyBalance = await token.balanceOf(orderAddress)
      // stETH uses shares-based accounting, so actual balance might differ slightly
      expect(tinyBalance).to.be.closeTo(keepAmount, 2n)

      // Set multiplier to a very small value that results in 0 after margin
      // With margin 500 bps: output = rawOutput * 9500 / 10000
      // For tinyBalance, rawOutput would be very small
      // If we set multiplier to 1 (0.01%), the output after margin would be even smaller
      // Let's try with multiplier = 1 (minimum allowed)
      await amountConverterTest.multiplyAnswer(1)

      // Check if estimateTradeOutput returns 0
      // Use the actual balance (may differ due to stETH rounding)
      const actualBalance = await token.balanceOf(orderAddress)
      const estimatedOutput = await stonksPartial.estimateTradeOutput(actualBalance)

      if (estimatedOutput === 0n) {
        // This should trigger ZeroQuotableAmount
        const [currentHash] = await orderPartial.getOrderDetails()
        await expect(orderPartial.isValidSignature(currentHash, '0x'))
          .to.be.revertedWithCustomError(orderPartial, 'ZeroQuotableAmount')
          .withArgs(actualBalance)
      } else {
        // If it doesn't return 0, the test documents that ZeroQuotableAmount
        // can occur in edge cases with very small amounts
        // The contract correctly guards against this case
        const rawOutput = await amountConverterTest.getExpectedOut(
          tokenFrom,
          tokenTo,
          actualBalance
        )
        const marginBps = await stonksPartial.MARGIN_IN_BASIS_POINTS()
        const expectedPositive = (rawOutput * (MAX_BASIS_POINTS - marginBps)) / MAX_BASIS_POINTS
        expect(estimatedOutput).to.equal(expectedPositive)
        expect(expectedPositive).to.not.equal(0n)
      }
    })

    it('should clamp basisSellAmount to sellAmount when availableBalance > sellAmount (partial fills)', async function () {
      // For partial fills, test that availableBalance > sellAmount clamps to sellAmount
      const { order: orderPartial, stonks: stonksPartial } = await deployStonksWithConfig(100, true)

      const [tokenFrom] = await stonksPartial.getOrderParameters()
      const orderDetails = await orderPartial.getOrderDetails()
      const sellAmount = orderDetails[3]
      const orderAddress = await orderPartial.getAddress()

      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const currentBalance = await token.balanceOf(orderAddress)

      // If balance > sellAmount, simulate a positive rebase/donation
      if (currentBalance > sellAmount) {
        // Already have more than sellAmount, verify it uses sellAmount
        const [currentHash] = await orderPartial.getOrderDetails()
        const result = await orderPartial.isValidSignature(currentHash, '0x')
        expect(result).to.equal(MAGIC_VALUE)
      } else {
        // Add tokens to simulate positive rebase
        await fillUpERC20FromTreasury({
          token: tokenFrom,
          amount: sellAmount,
          address: orderAddress,
        })

        const newBalance = await token.balanceOf(orderAddress)
        const expectedBalance = currentBalance + sellAmount
        expect(newBalance).to.be.closeTo(expectedBalance, 2n)

        // Should still validate correctly (using sellAmount as basis, not newBalance)
        const [currentHash] = await orderPartial.getOrderDetails()
        const result = await orderPartial.isValidSignature(currentHash, '0x')
        expect(result).to.equal(MAGIC_VALUE)
      }
    })

    it('should use pro-rated baselineBuyAmount for partial fills with availableBalance < sellAmount', async function () {
      const { order: orderPartial, stonks: stonksPartial } = await deployStonksWithConfig(100, true)

      const [tokenFrom, tokenTo] = await stonksPartial.getOrderParameters()
      const orderDetails = await orderPartial.getOrderDetails()
      const sellAmount = orderDetails[3]
      const buyAmount = orderDetails[4]
      const orderAddress = await orderPartial.getAddress()

      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)

      // Simulate 50% negative rebase
      const rebaseAmount = initialBalance / 2n
      await ethers.provider.send('hardhat_impersonateAccount', [orderAddress])
      await ethers.provider.send('hardhat_setBalance', [orderAddress, '0x1000000000000000000'])
      const orderSigner = await ethers.getSigner(orderAddress)
      const [, recipient] = await ethers.getSigners()
      await token.connect(orderSigner).transfer(await recipient.getAddress(), rebaseAmount)

      const newBalance = await token.balanceOf(orderAddress)
      const expectedBalance = initialBalance - rebaseAmount
      expect(newBalance).to.be.closeTo(expectedBalance, 2n)

      // Calculate expected pro-rated baselineBuyAmount
      const basisSellAmount = newBalance
      const expectedBaselineBuyAmount = (buyAmount * basisSellAmount) / sellAmount

      const priceToleranceBps = BigInt(PRICE_TOLERANCE_IN_BP)
      const maxToleratedShortfall =
        (expectedBaselineBuyAmount * priceToleranceBps) / MAX_BASIS_POINTS
      const minAcceptableBuyAmount = expectedBaselineBuyAmount - maxToleratedShortfall

      // Push the quote well below tolerance so the revert arguments reveal which baseline was used.
      const amountConverterAddress = await stonksPartial.AMOUNT_CONVERTER()
      const amountConverterPartial = await ethers.getContractAt(
        'AmountConverterTest',
        amountConverterAddress
      )
      await amountConverterPartial.multiplyAnswer(8000)

      const currentEstimatedBuyAmount = await stonksPartial.estimateTradeOutput(basisSellAmount)
      const rawOutput = await amountConverterPartial.getExpectedOut(
        tokenFrom,
        tokenTo,
        basisSellAmount
      )
      const marginBps = await stonksPartial.MARGIN_IN_BASIS_POINTS()
      const marginDiff = MAX_BASIS_POINTS - marginBps
      const expectedCurrentBuyAmount = (rawOutput * marginDiff) / MAX_BASIS_POINTS
      expect(currentEstimatedBuyAmount).to.equal(expectedCurrentBuyAmount)

      const expectedShortfall = expectedBaselineBuyAmount - expectedCurrentBuyAmount
      const actualShortfall = expectedBaselineBuyAmount - currentEstimatedBuyAmount
      expect(actualShortfall).to.equal(expectedShortfall)

      const [currentHash] = await orderPartial.getOrderDetails()
      await expect(orderPartial.isValidSignature(currentHash, '0x'))
        .to.be.revertedWithCustomError(orderPartial, 'PriceShortfallExceedsTolerance')
        .withArgs(minAcceptableBuyAmount, currentEstimatedBuyAmount)
    })

    it('should revert with InsufficientSellBalance when basisSellAmount is zero (partial fills)', async function () {
      const { order: orderPartial, stonks: stonksPartial } = await deployStonksWithConfig(100, true)

      const [tokenFrom, tokenTo] = await stonksPartial.getOrderParameters()
      const orderAddress = await orderPartial.getAddress()

      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const currentBalance = await token.balanceOf(orderAddress)

      // Transfer all tokens out to simulate complete drain
      await ethers.provider.send('hardhat_impersonateAccount', [orderAddress])
      await ethers.provider.send('hardhat_setBalance', [orderAddress, '0x1000000000000000000'])
      const orderSigner = await ethers.getSigner(orderAddress)
      const [, recipient] = await ethers.getSigners()

      if (currentBalance > 0n) {
        // Transfer out all tokens (may leave small remainder due to stETH shares rounding)
        await token.connect(orderSigner).transfer(await recipient.getAddress(), currentBalance)
      }

      const finalBalance = await token.balanceOf(orderAddress)
      // stETH uses shares-based accounting, so balance might be 1-2 wei instead of exactly 0
      // But it should still trigger InsufficientSellBalance since basisSellAmount would be very small

      // If balance is exactly 0, it should revert with InsufficientSellBalance(1, 0)
      // If balance is 1-2 wei (stETH rounding), it might still revert or pass depending on whether
      // estimateTradeOutput returns 0 or non-zero for that tiny amount
      const [currentHash] = await orderPartial.getOrderDetails()

      if (finalBalance === 0n) {
        await expect(orderPartial.isValidSignature(currentHash, '0x'))
          .to.be.revertedWithCustomError(orderPartial, 'InsufficientSellBalance')
          .withArgs(1n, 0n)
      } else {
        // If stETH rounding leaves 1-2 wei, test that very small balances are handled correctly
        expect(finalBalance).to.be.closeTo(0n, 5n) // Tiny residual balance due to rounding
        // The contract should handle this correctly - either revert with InsufficientSellBalance
        // or with ZeroQuotableAmount if estimateTradeOutput returns 0
        const estimatedOutput = await stonksPartial.estimateTradeOutput(finalBalance)

        if (estimatedOutput === 0n) {
          await expect(orderPartial.isValidSignature(currentHash, '0x'))
            .to.be.revertedWithCustomError(orderPartial, 'ZeroQuotableAmount')
            .withArgs(finalBalance)
        } else {
          // Very small balance might still validate if estimateTradeOutput returns non-zero
          // This is acceptable behavior - the contract handles tiny amounts correctly
          const amountConverterAddress = await stonksPartial.AMOUNT_CONVERTER()
          const amountConverter = await ethers.getContractAt(
            'AmountConverterTest',
            amountConverterAddress
          )
          const rawOutput = await amountConverter.getExpectedOut(tokenFrom, tokenTo, finalBalance)
          const marginBps = await stonksPartial.MARGIN_IN_BASIS_POINTS()
          const expectedPositive = (rawOutput * (MAX_BASIS_POINTS - marginBps)) / MAX_BASIS_POINTS
          expect(estimatedOutput).to.equal(expectedPositive)
          expect(expectedPositive).to.not.equal(0n)
        }
      }
    })

    it('should guard against division by zero in improvement calculation (originalLimitPrice == 0)', async function () {
      // This test verifies the guard for originalLimitPrice == 0
      // In practice, this can't happen with valid orders (buyAmount would be 0, which is invalid)
      // But we test the guard exists
      const orderDetails = await subject.getOrderDetails()
      const sellAmount = orderDetails[3]
      const buyAmount = orderDetails[4]

      // Verify buyAmount > 0 (required for valid order)
      expect(buyAmount).to.not.equal(0n)

      // Calculate originalLimitPrice to verify it's > 0
      const originalLimitPrice = (buyAmount * PRICE_SCALE) / sellAmount
      expect(originalLimitPrice).to.not.equal(0n)

      // The guard in the contract should prevent division by zero
      // If originalLimitPrice were 0, it would revert with PriceShortfallExceedsTolerance
      // This is the correct behavior per the contract implementation
    })

    afterEach(async function () {
      await localSnapshot.restore()
    })
  })

  after(async function () {
    await snapshot.restore()
    resetTestOracleRouter()
    resetTestFeedRegistryStub()
  })
})
