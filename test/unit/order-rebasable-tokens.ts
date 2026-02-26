import { ethers } from 'hardhat'
import { expect } from 'chai'
import { Signer } from 'ethers'
import {
  takeSnapshot,
  SnapshotRestorer,
  time,
  mine,
} from '@nomicfoundation/hardhat-network-helpers'
import { Order, Stonks, AmountConverterTest, OracleRouter } from '../../typechain-types'
import { getTestOracleRouter, resetTestOracleRouter } from '../../utils/test-oracle-router'
import { refreshTestFeedData, resetTestFeedRegistryStub } from '../../utils/test-feed-registry'
import { deployStonks } from '../../scripts/deployments/stonks'
import { getContracts } from '../../utils/contracts'
import { MAGIC_VALUE } from '../../utils/gpv2-helpers'
import { fillUpERC20FromTreasury } from '../../utils/fill-up-balance'
import { QuoteDenomination } from '../../utils/oracle-router'
import { getPlaceOrderData } from '../../utils/get-events'
import { simulateNegativeRebase } from '../../utils/test-oracle-router'

const PRICE_TOLERANCE_IN_BP = 1000
const MARGIN_IN_BPS = 500
const contracts = getContracts()

describe('Order - Rebasable Tokens (stETH -> LDO)', async function () {
  let manager: Signer
  let stonksPartialFill: Stonks
  let stonksNoPartialFill: Stonks
  let amountConverterTest: AmountConverterTest
  let oracleRouter: OracleRouter
  let snapshot: SnapshotRestorer
  let orderPartial: Order
  let orderNoPartial: Order

  before(async function () {
    snapshot = await takeSnapshot()
    manager = (await ethers.getSigners())[0]

    const amountConverterTestFactory = await ethers.getContractFactory('AmountConverterTest')

    oracleRouter = await getTestOracleRouter({
      tokens: [contracts.STETH, contracts.LDO],
      useRealPrices: true,
    })

    await refreshTestFeedData([contracts.STETH, contracts.LDO])

    await oracleRouter.setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86400, true)
    await oracleRouter.setTokenFeed(contracts.LDO, QuoteDenomination.ETH, 86400, true)

    amountConverterTest = await amountConverterTestFactory.deploy(
      await oracleRouter.getAddress(),
      [contracts.STETH],
      [contracts.LDO],
      true
    )
    await amountConverterTest.waitForDeployment()

    // Deploy Stonks with partial fills enabled
    const { stonks: stonksPartialFillLocal } = await deployStonks({
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
        allowedTokensToBuy: [contracts.LDO],
        useEthAnchor: true,
      },
    })

    // Deploy Stonks with partial fills disabled
    const { stonks: stonksNoPartialFillLocal } = await deployStonks({
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
        allowedTokensToBuy: [contracts.LDO],
        useEthAnchor: true,
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

    const expectedBuyAmountNoPartial =
      await stonksNoPartialFill.estimateTradeOutputFromCurrentBalance()
    const placeOrderTxNoPartial = await stonksNoPartialFill.placeOrder(expectedBuyAmountNoPartial)
    const placeOrderTxReceiptNoPartial = await placeOrderTxNoPartial.wait()
    if (!placeOrderTxReceiptNoPartial) throw Error('placeOrderTxReceiptNoPartial is null')

    const decodedOrderTxNoPartial = await getPlaceOrderData(placeOrderTxReceiptNoPartial)
    orderNoPartial = await ethers.getContractAt('Order', decodedOrderTxNoPartial.address, manager)
  })

  describe('Partial Fills Configuration', function () {
    let configSnapshot: SnapshotRestorer

    beforeEach(async function () {
      configSnapshot = await takeSnapshot()
    })

    afterEach(async function () {
      await configSnapshot.restore()
    })

    it('should have correct ALLOW_PARTIAL_FILL value for partial fill enabled', async function () {
      expect(await stonksPartialFill.ALLOW_PARTIAL_FILL()).to.equal(true)
    })

    it('should have correct ALLOW_PARTIAL_FILL value for partial fill disabled', async function () {
      expect(await stonksNoPartialFill.ALLOW_PARTIAL_FILL()).to.equal(false)
    })

    it('should set partiallyFillable correctly in order when partial fills enabled', async function () {
      // Note: partiallyFillable is not directly accessible, but we can verify behavior
      // by draining balances and observing how each order reacts.
      const [tokenFrom] = await stonksPartialFill.getOrderParameters()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const orderDetailsPartial = await orderPartial.getOrderDetails()
      const orderDetailsNoPartial = await orderNoPartial.getOrderDetails()
      const sellAmountPartial = orderDetailsPartial[4]
      const sellAmountNoPartial = orderDetailsNoPartial[4]
      const orderPartialAddress = await orderPartial.getAddress()
      const orderNoPartialAddress = await orderNoPartial.getAddress()
      const [, recipient] = await ethers.getSigners()

      const drainPartial = sellAmountPartial / 10n === 0n ? 1n : sellAmountPartial / 10n
      const impersonateAndDrain = async (address: string, amount: bigint) => {
        await ethers.provider.send('hardhat_impersonateAccount', [address])
        await ethers.provider.send('hardhat_setBalance', [address, '0x1000000000000000000'])
        const signer = await ethers.getSigner(address)
        await token.connect(signer).transfer(await recipient.getAddress(), amount)
        await ethers.provider.send('hardhat_stopImpersonatingAccount', [address])
      }

      // Drain part of the balance on the partial-fill order: it should remain valid.
      await impersonateAndDrain(orderPartialAddress, drainPartial)
      const reducedPartialBalance = await token.balanceOf(orderPartialAddress)
      expect(reducedPartialBalance).to.be.closeTo(sellAmountPartial - drainPartial, 2n)

      const [currentHashPartial] = await orderPartial.getOrderDetails()
      expect(await orderPartial.isValidSignature(currentHashPartial, '0x')).to.equal(MAGIC_VALUE)

      // Drain the same proportion from the non-partial order: it should now revert.
      const drainNoPartial = sellAmountNoPartial / 10n === 0n ? 1n : sellAmountNoPartial / 10n
      await impersonateAndDrain(orderNoPartialAddress, drainNoPartial)
      const reducedNoPartialBalance = await token.balanceOf(orderNoPartialAddress)
      expect(reducedNoPartialBalance).to.be.closeTo(sellAmountNoPartial - drainNoPartial, 2n)

      const [currentHashNoPartial] = await orderNoPartial.getOrderDetails()
      await expect(orderNoPartial.isValidSignature(currentHashNoPartial, '0x'))
        .to.be.revertedWithCustomError(orderNoPartial, 'InsufficientSellBalance')
        .withArgs(sellAmountNoPartial, reducedNoPartialBalance)
    })
  })

  describe('Negative Rebase Simulation', function () {
    let localSnapshot: SnapshotRestorer

    beforeEach(async function () {
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
      // stETH uses shares-based accounting, so transfers can introduce up to 1 wei rounding
      // Integer division (initialBalance / 10n) also truncates, contributing to small differences
      const newBalance = await token.balanceOf(orderAddress)
      expect(newBalance).to.be.closeTo(initialBalance - rebaseAmount, 2n)

      // Order should still be valid with partial fills enabled
      const [currentHash] = await orderPartial.getOrderDetails()
      expect(await orderPartial.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
    })

    it('should revert with InsufficientSellBalance when partial fills disabled after negative rebase', async function () {
      const [tokenFrom] = await stonksNoPartialFill.getOrderParameters()
      const orderDetails = await orderNoPartial.getOrderDetails()
      const orderAddress = await orderNoPartial.getAddress()
      const sellAmount = orderDetails[4]

      // Get initial balance
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)

      // Simulate a 10% negative rebase
      const rebaseAmount = initialBalance / 10n
      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      // Verify balance decreased
      // stETH uses shares-based accounting, so transfers can introduce up to 1 wei rounding
      // Integer division (initialBalance / 10n) also truncates, contributing to small differences
      const newBalance = await token.balanceOf(orderAddress)
      const expectedBalance = sellAmount - rebaseAmount
      expect(newBalance).to.be.closeTo(expectedBalance, 2n)

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
      expect(newBalance).to.be.closeTo(expectedBalance, 2n)

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
      // Allow 1 wei tolerance due to stETH shares rounding
      expect(newBalance).to.be.closeTo(initialBalance - rebaseAmount, 1n)

      // Order should still be valid
      const [currentHash] = await orderPartial.getOrderDetails()
      expect(await orderPartial.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
    })

    afterEach(async function () {
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
      expect(balanceAfter).to.be.closeTo(0n, 2n)
    })
  })

  after(async function () {
    await snapshot.restore()
    resetTestOracleRouter()
    resetTestFeedRegistryStub()
  })
})
