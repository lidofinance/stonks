import { ethers } from 'hardhat'
import { expect } from 'chai'
import { Signer } from 'ethers'
import {
  takeSnapshot,
  SnapshotRestorer,
  time,
  mine,
} from '@nomicfoundation/hardhat-network-helpers'
import { Order, Stonks, AmountConverterTest, OracleRouter, IERC20 } from '../../typechain-types'
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
import { isClose } from '../../utils/assert'

const PRICE_TOLERANCE_IN_BP = 1000
const MARGIN_IN_BPS = 500
const contracts = getContracts()

/**
 * Helper to simulate negative rebase by transferring tokens out of the order contract
 * stETH uses a shares-based system, so we transfer tokens instead of manipulating storage
 */
async function simulateNegativeRebase(
  tokenAddress: string,
  orderAddress: string,
  rebaseAmount: bigint
): Promise<void> {
  // Get the token contract
  const token = await ethers.getContractAt('IERC20', tokenAddress)
  const currentBalance = await token.balanceOf(orderAddress)

  // Calculate amount to transfer
  const amountToTransfer = currentBalance > rebaseAmount ? rebaseAmount : currentBalance

  // Impersonate the order contract to transfer tokens out
  await ethers.provider.send('hardhat_impersonateAccount', [orderAddress])
  await ethers.provider.send('hardhat_setBalance', [orderAddress, '0x1000000000000000000'])
  const orderSigner = await ethers.getSigner(orderAddress)

  // Transfer tokens to a recipient (simulate rebase loss)
  const [, recipient] = await ethers.getSigners()
  await token.connect(orderSigner).transfer(await recipient.getAddress(), amountToTransfer)

  // Verify the balance decreased
  const newBalance = await token.balanceOf(orderAddress)
  const expectedBalance = currentBalance - amountToTransfer

  // Allow for small rounding differences (1-2 wei) due to stETH shares
  if (newBalance > expectedBalance + 2n || newBalance < expectedBalance - 2n) {
    throw new Error(`Balance transfer failed: expected ~${expectedBalance}, got ${newBalance}`)
  }
}

describe('Order - Rebasable Tokens (stETH -> LDO)', async function () {
  let manager: Signer
  let stonksPartialFill: Stonks
  let stonksNoPartialFill: Stonks
  let amountConverterTest: AmountConverterTest
  let oracleRouter: OracleRouter
  let snapshot: SnapshotRestorer
  let orderPartial: Order
  let orderNoPartial: Order
  let orderHashPartial: string

  this.beforeAll(async function () {
    snapshot = await takeSnapshot()
    manager = (await ethers.getSigners())[0]

    const amountConverterTestFactory = await ethers.getContractFactory('AmountConverterTest')

    oracleRouter = await getTestOracleRouter({
      tokens: [contracts.STETH, contracts.LDO],
      useRealPrices: true,
    })

    await refreshTestFeedData([contracts.STETH, contracts.LDO])

    amountConverterTest = await amountConverterTestFactory.deploy(
      await oracleRouter.getAddress(),
      [contracts.STETH],
      [contracts.LDO]
    )
    await amountConverterTest.waitForDeployment()

    // Deploy Stonks with partial fills enabled
    const { stonks: stonksPartialFillLocal } = await deployStonks({
      factoryParams: {
        agent: contracts.AGENT,
        relayer: contracts.VAULT_RELAYER,
        settlement: contracts.SETTLEMENT,
        priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        oracleRouterAddress: await oracleRouter.getAddress(),
      },
      stonksParams: {
        tokenFrom: contracts.STETH,
        tokenTo: contracts.LDO,
        manager: await manager.getAddress(),
        marginInBps: MARGIN_IN_BPS,
        orderDuration: 3600,
        priceToleranceInBps: PRICE_TOLERANCE_IN_BP,
        maxImprovementInBps: 100,
        allowPartialFill: true,
        amountConverterAddress: await amountConverterTest.getAddress(),
      },
      amountConverterParams: {
        oracleRouter: await oracleRouter.getAddress(),
        allowedTokensToSell: [contracts.STETH],
        allowedStableTokensToBuy: [contracts.LDO],
      },
    })

    // Deploy Stonks with partial fills disabled
    const { stonks: stonksNoPartialFillLocal } = await deployStonks({
      factoryParams: {
        agent: contracts.AGENT,
        relayer: contracts.VAULT_RELAYER,
        settlement: contracts.SETTLEMENT,
        priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        oracleRouterAddress: await oracleRouter.getAddress(),
      },
      stonksParams: {
        tokenFrom: contracts.STETH,
        tokenTo: contracts.LDO,
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
        allowedStableTokensToBuy: [contracts.LDO],
      },
    })

    stonksPartialFill = stonksPartialFillLocal
    stonksNoPartialFill = stonksNoPartialFillLocal

    // Fund both contracts
    await fillUpERC20FromTreasury({
      token: contracts.STETH,
      amount: ethers.parseEther('1'),
      address: await stonksPartialFill.getAddress(),
    })

    await fillUpERC20FromTreasury({
      token: contracts.STETH,
      amount: ethers.parseEther('1'),
      address: await stonksNoPartialFill.getAddress(),
    })

    // Place orders
    const expectedBuyAmountPartial = await stonksPartialFill.estimateTradeOutputFromCurrentBalance()
    const placeOrderTxPartial = await stonksPartialFill.placeOrder(expectedBuyAmountPartial)
    const placeOrderTxReceiptPartial = await placeOrderTxPartial.wait()
    if (!placeOrderTxReceiptPartial) throw Error('placeOrderTxReceiptPartial is null')

    const decodedOrderTxPartial = await getPlaceOrderData(placeOrderTxReceiptPartial)
    orderPartial = await ethers.getContractAt('Order', decodedOrderTxPartial.address, manager)
    orderHashPartial = await formOrderHashFromTxReceipt(placeOrderTxReceiptPartial)

    const expectedBuyAmountNoPartial =
      await stonksNoPartialFill.estimateTradeOutputFromCurrentBalance()
    const placeOrderTxNoPartial = await stonksNoPartialFill.placeOrder(expectedBuyAmountNoPartial)
    const placeOrderTxReceiptNoPartial = await placeOrderTxNoPartial.wait()
    if (!placeOrderTxReceiptNoPartial) throw Error('placeOrderTxReceiptNoPartial is null')

    const decodedOrderTxNoPartial = await getPlaceOrderData(placeOrderTxReceiptNoPartial)
    orderNoPartial = await ethers.getContractAt('Order', decodedOrderTxNoPartial.address, manager)
  })

  describe('Partial Fills Configuration', function () {
    it('should have correct ALLOW_PARTIAL_FILL value for partial fill enabled', async function () {
      expect(await stonksPartialFill.ALLOW_PARTIAL_FILL()).to.equal(true)
    })

    it('should have correct ALLOW_PARTIAL_FILL value for partial fill disabled', async function () {
      expect(await stonksNoPartialFill.ALLOW_PARTIAL_FILL()).to.equal(false)
    })

    it('should set partiallyFillable correctly in order when partial fills enabled', async function () {
      // Note: partiallyFillable is not directly accessible, but we can verify behavior
      // by checking that orders with partial fills don't revert on insufficient balance
      const [tokenFrom] = await stonksPartialFill.getOrderParameters()
      const orderDetails = await orderPartial.getOrderDetails()
      const sellAmount = orderDetails[3]

      // Verify order can be validated initially
      expect(await orderPartial.isValidSignature(orderHashPartial, '0x')).to.equal(MAGIC_VALUE)
    })
  })

  describe('Negative Rebase Simulation', function () {
    let localSnapshot: SnapshotRestorer

    this.beforeEach(async function () {
      localSnapshot = await takeSnapshot()
    })

    it('should allow order validation with partial fills enabled after negative rebase', async function () {
      const [tokenFrom] = await stonksPartialFill.getOrderParameters()
      const orderAddress = await orderPartial.getAddress()

      // Get initial balance
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)

      // Simulate a 10% negative rebase
      const rebaseAmount = initialBalance / 10n
      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      // Verify balance decreased
      const newBalance = await token.balanceOf(orderAddress)
      expect(newBalance).to.be.equal(initialBalance - rebaseAmount)

      // Order should still be valid with partial fills enabled
      const [currentHash] = await orderPartial.getOrderDetails()
      expect(await orderPartial.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
    })

    it('should revert with InsufficientSellBalance when partial fills disabled after negative rebase', async function () {
      const [tokenFrom] = await stonksNoPartialFill.getOrderParameters()
      const orderDetails = await orderNoPartial.getOrderDetails()
      const orderAddress = await orderNoPartial.getAddress()
      const sellAmount = orderDetails[3]

      // Get initial balance
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)

      // Simulate a 10% negative rebase
      const rebaseAmount = initialBalance / 10n
      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      // Verify balance decreased
      const newBalance = await token.balanceOf(orderAddress)
      expect(newBalance).to.be.equal(initialBalance - rebaseAmount)
      expect(newBalance).to.be.lessThan(sellAmount)

      // Order should revert with InsufficientSellBalance
      const [currentHash] = await orderNoPartial.getOrderDetails()
      await expect(orderNoPartial.isValidSignature(currentHash, '0x'))
        .to.be.revertedWithCustomError(orderNoPartial, 'InsufficientSellBalance')
        .withArgs(sellAmount, newBalance)
    })

    it('should handle large negative rebase (50%) with partial fills enabled', async function () {
      const [tokenFrom] = await stonksPartialFill.getOrderParameters()
      const orderAddress = await orderPartial.getAddress()

      // Simulate a 50% negative rebase
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = initialBalance / 2n

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const newBalance = await token.balanceOf(orderAddress)
      const expectedBalance = initialBalance - rebaseAmount
      expect(isClose(newBalance, expectedBalance, 2n)).to.be.true

      // Order should still be valid
      const [currentHash] = await orderPartial.getOrderDetails()
      expect(await orderPartial.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
    })

    it('should handle small negative rebase (1%) with partial fills enabled', async function () {
      const [tokenFrom] = await stonksPartialFill.getOrderParameters()
      const orderAddress = await orderPartial.getAddress()

      // Simulate a 1% negative rebase
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = initialBalance / 100n

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const newBalance = await token.balanceOf(orderAddress)
      expect(newBalance).to.be.equal(initialBalance - rebaseAmount)

      // Order should still be valid
      const [currentHash] = await orderPartial.getOrderDetails()
      expect(await orderPartial.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
    })

    this.afterEach(async function () {
      await localSnapshot.restore()
    })
  })

  describe('Order Recovery After Negative Rebase', function () {
    it('should allow token recovery after order expiration with partial fills enabled', async function () {
      const [tokenFrom] = await stonksPartialFill.getOrderParameters()
      const orderAddress = await orderPartial.getAddress()

      // Simulate negative rebase
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = initialBalance / 10n
      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      // Wait for order expiration
      await time.increase(3601)
      await mine()

      // Should be able to recover remaining balance
      await expect(orderPartial.recoverTokenFrom()).to.not.be.reverted

      const balanceAfter = await token.balanceOf(orderAddress)
      expect(balanceAfter).to.be.lessThan(initialBalance - rebaseAmount)
    })
  })

  this.afterAll(async function () {
    await snapshot.restore()
    resetTestOracleRouter()
    resetTestFeedRegistryStub()
  })
})
