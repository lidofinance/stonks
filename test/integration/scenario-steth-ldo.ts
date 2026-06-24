import { ethers } from 'hardhat'
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
import { setup, TokenPair } from './setup'
import { getContracts } from '../../utils/contracts'
import { IERC20, Stonks, Order } from '../../typechain-types'
import { MAGIC_VALUE } from '../../utils/gpv2-helpers'
import { getPlaceOrderData } from '../../utils/get-events'

const contracts = getContracts()

const stethLdoPair: TokenPair = {
  tokenFrom: contracts.STETH,
  tokenTo: contracts.LDO,
  name: 'stETH->LDO Rebasable',
  priceFeedHeartbeatTimeout: 86400 * 7,
  useEthBridge: true,
  allowPartialFill: true,
}

/**
 * Helper to simulate rebase by transferring tokens
 * Positive rebase: transfers tokens TO the order
 * Negative rebase: transfers tokens FROM the order
 */
async function simulateRebase(
  token: IERC20,
  orderAddress: string,
  rebaseAmount: bigint,
  isPositive: boolean
): Promise<{ balanceBefore: bigint; balanceAfter: bigint }> {
  const balanceBefore = await token.balanceOf(orderAddress)

  if (isPositive) {
    // Positive rebase: transfer tokens to order
    const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
    await impersonateAccount(contracts.AGENT)
    await token.connect(treasurySigner).transfer(orderAddress, rebaseAmount)
  } else {
    // Negative rebase: transfer tokens from order
    await impersonateAccount(orderAddress)
    await setBalance(orderAddress, parseEther('1'))
    const orderSigner = await ethers.getSigner(orderAddress)
    const [, recipient] = await ethers.getSigners()
    await token.connect(orderSigner).transfer(await recipient.getAddress(), rebaseAmount)
  }

  const balanceAfter = await token.balanceOf(orderAddress)
  return { balanceBefore, balanceAfter }
}

describe('stETH -> LDO: Full Lifecycle with Rebases', function () {
  let snapshot: SnapshotRestorer
  let snapshotOrderPlaced: SnapshotRestorer
  let value: bigint
  let stonks: Stonks
  let manager: Signer
  let tokenFrom: IERC20
  let tokenTo: IERC20
  let expectedBuyAmount: bigint
  let orderReceipt: TransactionReceipt
  let order: Order

  before(async function () {
    snapshot = await takeSnapshot()

    const result = await setup(stethLdoPair)
    stonks = result.stonks
    value = result.value
    manager = result.manager

    tokenFrom = await ethers.getContractAt('IERC20', await stonks.TOKEN_FROM())
    tokenTo = await ethers.getContractAt('IERC20', await stonks.TOKEN_TO())

    await setBalance(await manager.getAddress(), parseEther('100'))
    await setBalance(contracts.AGENT, parseEther('100'))
  })

  after(async function () {
    await snapshot.restore()
  })

  context('Setup', function () {
    it('agent should fill stonks with stETH', async function () {
      const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
      const token = tokenFrom.connect(treasurySigner)
      const currentBalance = await token.balanceOf(stonks)

      if (currentBalance > 0n) {
        value = currentBalance
        this.skip()
      }

      await impersonateAccount(contracts.AGENT)

      const transferTx = await token.transfer(stonks, value)
      await transferTx.wait()

      const balanceAfter = await token.balanceOf(stonks)

      // stETH shares-based rounding: allow 2 wei tolerance for transfer precision loss
      expect(balanceAfter).to.be.closeTo(value, 2n)
    })

    it('manager should place order', async function () {
      expectedBuyAmount = await stonks.estimateTradeOutputFromCurrentBalance()
      const orderTx = await stonks.placeOrder(expectedBuyAmount)

      orderReceipt = (await orderTx.wait())!
      if (!orderReceipt) throw new Error('No order receipt')

      const { address } = await getPlaceOrderData(orderReceipt)

      order = await ethers.getContractAt('Order', address)

      const tokenFromBalance = await tokenFrom.balanceOf(address)
      const tokenFromBalanceStonks = await tokenTo.balanceOf(stonks)

      // stETH shares-based rounding: allow 4 wei tolerance for cumulative transfer precision loss
      expect(tokenFromBalance).to.be.closeTo(value, 4n)
      expect(tokenFromBalanceStonks).to.be.closeTo(0n, 2n)

      const [orderHashFromContract] = await order.getOrderDetails()
      expect(orderHashFromContract).to.match(/^0x[0-9a-fA-F]{64}$/)

      snapshotOrderPlaced = await takeSnapshot()
    })
  })

  context('Positive Rebase During Active Order', function () {
    beforeEach(async function () {
      await snapshotOrderPlaced.restore()
    })

    it('order should remain valid after 5% positive rebase', async function () {
      const orderAddress = await order.getAddress()
      const rebaseAmount = (value * 5n) / 100n // 5%

      const { balanceBefore, balanceAfter } = await simulateRebase(
        tokenFrom,
        orderAddress,
        rebaseAmount,
        true
      )

      // Verify positive rebase occurred
      const expectedBalance = balanceBefore + rebaseAmount
      expect(balanceAfter).to.be.closeTo(expectedBalance, 2n)

      // Order should still be valid
      const [hash] = await order.getOrderDetails()
      expect(await order.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)
    })

    it('order should remain valid after 20% positive rebase', async function () {
      await snapshotOrderPlaced.restore()
      const orderAddress = await order.getAddress()
      const rebaseAmount = (value * 20n) / 100n // 20%

      const { balanceBefore, balanceAfter } = await simulateRebase(
        tokenFrom,
        orderAddress,
        rebaseAmount,
        true
      )

      const expectedBalance = balanceBefore + rebaseAmount
      expect(balanceAfter).to.be.closeTo(expectedBalance, 2n)

      const [hash] = await order.getOrderDetails()
      expect(await order.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)
    })
  })

  context('Negative Rebase During Active Order', function () {
    beforeEach(async function () {
      await snapshotOrderPlaced.restore()
    })

    it('should handle 1% negative rebase (within tolerance)', async function () {
      const orderAddress = await order.getAddress()
      const rebaseAmount = (value * 1n) / 100n // 1%

      const { balanceBefore, balanceAfter } = await simulateRebase(
        tokenFrom,
        orderAddress,
        rebaseAmount,
        false
      )

      const expectedBalance = balanceBefore - rebaseAmount
      expect(balanceAfter).to.be.closeTo(expectedBalance, 2n)

      // Order validity check - 1% rebase should keep balance above sellAmount
      const [hash] = await order.getOrderDetails()
      expect(await order.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)
    })

    it('should handle 10% negative rebase', async function () {
      const orderAddress = await order.getAddress()
      const rebaseAmount = (value * 10n) / 100n // 10%

      const { balanceBefore, balanceAfter } = await simulateRebase(
        tokenFrom,
        orderAddress,
        rebaseAmount,
        false
      )

      const expectedBalance = balanceBefore - rebaseAmount
      expect(balanceAfter).to.be.closeTo(expectedBalance, 2n)

      // Order validity check - 10% rebase should keep balance above sellAmount
      const [hash] = await order.getOrderDetails()
      expect(await order.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)
    })

    it('should handle 50% negative rebase (extreme case)', async function () {
      const orderAddress = await order.getAddress()
      const rebaseAmount = (value * 50n) / 100n // 50%

      const { balanceBefore, balanceAfter } = await simulateRebase(
        tokenFrom,
        orderAddress,
        rebaseAmount,
        false
      )

      const expectedBalance = balanceBefore - rebaseAmount
      expect(balanceAfter).to.be.closeTo(expectedBalance, 2n)

      // Order validity check - with partial fills enabled, 50% rebase should still be valid
      const [hash] = await order.getOrderDetails()
      expect(await order.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)
    })
  })

  context('Successful Trade After Rebase', function () {
    beforeEach(async function () {
      await snapshotOrderPlaced.restore()
    })

    it('settlement should validate signature after positive rebase', async function () {
      const orderAddress = await order.getAddress()
      const rebaseAmount = (value * 10n) / 100n // 10%

      await simulateRebase(tokenFrom, orderAddress, rebaseAmount, true)

      const [currentHash] = await order.getOrderDetails()
      expect(await order.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
    })

    it('settlement should pull assets (swap simulation)', async function () {
      const orderAddress = await order.getAddress()
      await simulateRebase(tokenFrom, orderAddress, (value * 10n) / 100n, true)

      await setCode(contracts.VAULT_RELAYER, ethers.ZeroHash)
      await setBalance(contracts.VAULT_RELAYER, parseEther('100'))
      await impersonateAccount(contracts.VAULT_RELAYER)

      const relayerSigner = await ethers.provider.getSigner(contracts.VAULT_RELAYER)
      const tokenWithRelayer = tokenFrom.connect(relayerSigner)

      const orderBalance = await tokenWithRelayer.balanceOf(order)
      await tokenWithRelayer.transferFrom(order, contracts.VAULT_RELAYER, orderBalance)

      const finalOrderBalance = await tokenWithRelayer.balanceOf(order)
      expect(finalOrderBalance).to.be.closeTo(0n, 1n)
    })
  })

  context('Order Expiration After Rebase', function () {
    beforeEach(async function () {
      await snapshotOrderPlaced.restore()
    })

    it('should not recover before expiration even with negative rebase', async function () {
      const orderAddress = await order.getAddress()
      const rebaseAmount = (value * 20n) / 100n // 20%
      await simulateRebase(tokenFrom, orderAddress, rebaseAmount, false)

      const orderDetails = await order.getOrderDetails()
      await expect(order.recoverTokenFrom())
        .to.be.revertedWithCustomError(order, 'OrderNotExpired')
        .withArgs(orderDetails[5], anyValue)
    })

    it('should recover remaining tokens after expiration', async function () {
      await time.increase((await stonks.ORDER_DURATION_IN_SECONDS()) + 1n)
      const balanceBeforeRecover = await tokenFrom.balanceOf(order)

      await order.recoverTokenFrom()

      const balanceAfterRecover = await tokenFrom.balanceOf(order)

      expect(balanceAfterRecover).to.be.closeTo(0n, 1n)
      expect(balanceBeforeRecover).to.be.gt(0)
    })

    it('order should be invalid after expiration', async function () {
      await time.increase((await stonks.ORDER_DURATION_IN_SECONDS()) + 1n)

      const [currentHash, , , , , validTo] = await order.getOrderDetails()
      await expect(order.isValidSignature(currentHash, '0x'))
        .to.be.revertedWithCustomError(order, 'OrderExpired')
        .withArgs(validTo)
    })
  })

  context('Multiple Orders with Rebases', function () {
    beforeEach(async function () {
      await snapshotOrderPlaced.restore()
    })

    it('should create new order after recovering from first', async function () {
      await time.increase((await stonks.ORDER_DURATION_IN_SECONDS()) + 1n)
      await order.recoverTokenFrom()

      // stonks should have recovered balance
      const stonksBalance = await tokenFrom.balanceOf(stonks)
      expect(stonksBalance).to.be.gt(0)

      const newExpectedBuy = await stonks.estimateTradeOutputFromCurrentBalance()
      const orderTx = await stonks.placeOrder(newExpectedBuy)
      const receipt = (await orderTx.wait())!

      const { address } = await getPlaceOrderData(receipt)
      const newOrder = await ethers.getContractAt('Order', address)

      const balance = await tokenFrom.balanceOf(address)
      expect(balance).to.be.closeTo(stonksBalance, 5n)

      expect(await newOrder.getAddress()).to.not.equal(await order.getAddress())
    })

    it('second order should handle negative rebase', async function () {
      // Fund stonks again
      const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
      const token = tokenFrom.connect(treasurySigner)
      await impersonateAccount(contracts.AGENT)
      await token.transfer(stonks, value)

      // Place new order
      const orderTx = await stonks.placeOrder(await stonks.estimateTradeOutputFromCurrentBalance())
      const receipt = (await orderTx.wait())!
      const { address } = await getPlaceOrderData(receipt)
      const newOrder = await ethers.getContractAt('Order', address)

      const orderAddress = await newOrder.getAddress()
      const currentBalance = await tokenFrom.balanceOf(orderAddress)
      const rebaseAmount = (currentBalance * 10n) / 100n // 10%

      const { balanceBefore, balanceAfter } = await simulateRebase(
        tokenFrom,
        orderAddress,
        rebaseAmount,
        false
      )

      expect(balanceAfter).to.be.closeTo(balanceBefore - rebaseAmount, 2n)
    })
  })

  context('Alternating Rebases', function () {
    beforeEach(async function () {
      await snapshotOrderPlaced.restore()
    })

    it('should handle positive then negative rebase', async function () {
      const orderAddress = await order.getAddress()

      // Positive rebase first
      const positiveRebase = (value * 10n) / 100n // 10%
      const { balanceAfter: afterPositive } = await simulateRebase(
        tokenFrom,
        orderAddress,
        positiveRebase,
        true
      )

      // Then negative rebase
      const negativeRebase = (value * 5n) / 100n // 5%
      const { balanceBefore: beforeNegative, balanceAfter: afterNegative } = await simulateRebase(
        tokenFrom,
        orderAddress,
        negativeRebase,
        false
      )

      expect(afterNegative).to.be.closeTo(beforeNegative - negativeRebase, 2n)
      expect(afterNegative).to.be.closeTo(afterPositive - negativeRebase, 2n)

      // Order should still be valid after positive then negative rebase
      const [hash] = await order.getOrderDetails()
      expect(await order.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)
    })
  })

  context('Small Amount Orders with Rebase', function () {
    beforeEach(async function () {
      await snapshotOrderPlaced.restore()
    })

    it('should handle small order with tiny rebase', async function () {
      // Fund with smaller amount
      const smallValue = parseEther('0.01')
      const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
      const token = tokenFrom.connect(treasurySigner)
      await impersonateAccount(contracts.AGENT)
      await token.transfer(stonks, smallValue)

      const expectedBuy = await stonks.estimateTradeOutputFromCurrentBalance()
      const orderTx = await stonks.placeOrder(expectedBuy)
      const receipt = (await orderTx.wait())!
      const { address } = await getPlaceOrderData(receipt)
      const smallOrder = await ethers.getContractAt('Order', address)

      // Apply tiny rebase (0.1%)
      const tinyRebase = smallValue / 1000n
      const { balanceBefore, balanceAfter } = await simulateRebase(
        tokenFrom,
        address,
        tinyRebase,
        false
      )

      expect(balanceAfter).to.be.closeTo(balanceBefore - tinyRebase, 2n)

      // Order should remain valid after tiny rebase
      const [hash] = await smallOrder.getOrderDetails()
      expect(await smallOrder.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)
    })
  })

  context('Large Amount Orders with Rebase', function () {
    beforeEach(async function () {
      await snapshotOrderPlaced.restore()
    })

    it('should handle large order with significant rebase', async function () {
      // Fund with larger amount
      const largeValue = parseEther('10')
      const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
      const token = tokenFrom.connect(treasurySigner)
      await impersonateAccount(contracts.AGENT)
      await token.transfer(stonks, largeValue)

      const expectedBuy = await stonks.estimateTradeOutputFromCurrentBalance()
      const orderTx = await stonks.placeOrder(expectedBuy)
      const receipt = (await orderTx.wait())!
      const { address } = await getPlaceOrderData(receipt)

      // Apply large rebase (15%)
      const largeRebase = (largeValue * 15n) / 100n
      const { balanceBefore, balanceAfter } = await simulateRebase(
        tokenFrom,
        address,
        largeRebase,
        false
      )

      expect(balanceAfter).to.be.closeTo(balanceBefore - largeRebase, 2n)
    })
  })

  context('No Rebase Baseline', function () {
    it('order should remain valid without any rebase', async function () {
      // Create fresh order for this test to avoid snapshot issues
      const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
      const token = tokenFrom.connect(treasurySigner)
      await impersonateAccount(contracts.AGENT)
      await token.transfer(stonks, value)

      const expectedBuy = await stonks.estimateTradeOutputFromCurrentBalance()
      const orderTx = await stonks.placeOrder(expectedBuy)
      const receipt = (await orderTx.wait())!
      const { address } = await getPlaceOrderData(receipt)
      const freshOrder = await ethers.getContractAt('Order', address)

      const balanceBefore = await tokenFrom.balanceOf(address)

      // Wait some time but no rebase (less than order duration of 300 seconds)
      await time.increase(150) // 2.5 minutes

      const balanceAfter = await tokenFrom.balanceOf(address)
      expect(balanceAfter).to.be.closeTo(balanceBefore, 2n)

      const [hash] = await freshOrder.getOrderDetails()
      expect(await freshOrder.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)
    })
  })

  context('Multiple Small Rebases', function () {
    beforeEach(async function () {
      await snapshotOrderPlaced.restore()
    })

    it('should handle sequence of small negative rebases', async function () {
      const orderAddress = await order.getAddress()
      const initialBalance = await tokenFrom.balanceOf(orderAddress)
      let currentBalance = initialBalance

      // Apply 5 small rebases of 1% each of CURRENT balance
      for (let i = 0; i < 5; ++i) {
        const rebaseAmount = (currentBalance * 1n) / 100n // 1%
        const { balanceAfter } = await simulateRebase(tokenFrom, orderAddress, rebaseAmount, false)
        currentBalance = balanceAfter
      }

      // After 5x 1% rebases, expect ~95% remaining with ±1% tolerance for stETH shares rounding
      expect(currentBalance).to.be.gt((initialBalance * 94n) / 100n)
      expect(currentBalance).to.be.lt((initialBalance * 96n) / 100n)

      // Order should remain valid after multiple small rebases
      const [hash] = await order.getOrderDetails()
      expect(await order.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)
    })

    it('should handle sequence of mixed rebases', async function () {
      const orderAddress = await order.getAddress()

      // +5%, -3%, +2%, -1%
      await simulateRebase(tokenFrom, orderAddress, (value * 5n) / 100n, true)
      await simulateRebase(tokenFrom, orderAddress, (value * 3n) / 100n, false)
      await simulateRebase(tokenFrom, orderAddress, (value * 2n) / 100n, true)
      await simulateRebase(tokenFrom, orderAddress, (value * 1n) / 100n, false)

      const finalBalance = await tokenFrom.balanceOf(orderAddress)
      // Net: +3%
      const expectedBalance = (value * 103n) / 100n

      expect(finalBalance).to.be.closeTo(expectedBalance, 10n)

      const [hash] = await order.getOrderDetails()
      expect(await order.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)
    })
  })

  context('Rebase Near Expiration', function () {
    beforeEach(async function () {
      await snapshotOrderPlaced.restore()
    })

    it('should handle negative rebase just before expiration', async function () {
      const orderAddress = await order.getAddress()
      const orderDuration = await stonks.ORDER_DURATION_IN_SECONDS()

      // Wait until just before expiration
      await time.increase(Number(orderDuration) - 60)

      const rebaseAmount = (value * 10n) / 100n // 10%
      const { balanceBefore, balanceAfter } = await simulateRebase(
        tokenFrom,
        orderAddress,
        rebaseAmount,
        false
      )

      expect(balanceAfter).to.be.closeTo(balanceBefore - rebaseAmount, 2n)

      // Order should still be valid (not expired yet)
      const [hash] = await order.getOrderDetails()
      expect(await order.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)
    })

    it('should handle positive rebase right at expiration boundary', async function () {
      const orderAddress = await order.getAddress()
      const orderDuration = await stonks.ORDER_DURATION_IN_SECONDS()

      await time.increase(Number(orderDuration))

      const rebaseAmount = (value * 5n) / 100n // 5%
      await simulateRebase(tokenFrom, orderAddress, rebaseAmount, true)

      // Order expired, rebase doesn't matter
      const [hash, , , , , validTo] = await order.getOrderDetails()
      await expect(order.isValidSignature(hash, '0x'))
        .to.be.revertedWithCustomError(order, 'OrderExpired')
        .withArgs(validTo)
    })
  })

  context('Recovery After Extreme Rebases', function () {
    beforeEach(async function () {
      await snapshotOrderPlaced.restore()
    })

    it('should recover remaining tokens after multiple negative rebases', async function () {
      const orderAddress = await order.getAddress()

      // Apply multiple negative rebases
      await simulateRebase(tokenFrom, orderAddress, (value * 10n) / 100n, false) // -10%
      await simulateRebase(tokenFrom, orderAddress, (value * 5n) / 100n, false) // -5%
      await simulateRebase(tokenFrom, orderAddress, (value * 4n) / 100n, false) // -4%

      const balanceBeforeExpiry = await tokenFrom.balanceOf(orderAddress)
      expect(balanceBeforeExpiry).to.be.gt(0)

      // Wait for expiration
      await time.increase((await stonks.ORDER_DURATION_IN_SECONDS()) + 1n)

      const stonksBalanceBefore = await tokenFrom.balanceOf(stonks)
      await order.recoverTokenFrom()
      const stonksBalanceAfter = await tokenFrom.balanceOf(stonks)

      const orderBalanceAfter = await tokenFrom.balanceOf(order)

      expect(orderBalanceAfter).to.be.closeTo(0n, 1n)
      expect(stonksBalanceAfter).to.be.gt(stonksBalanceBefore)
      expect(stonksBalanceAfter - stonksBalanceBefore).to.be.closeTo(balanceBeforeExpiry, 1n)
    })

    it('should recover full amount after positive rebases', async function () {
      const orderAddress = await order.getAddress()

      // Apply positive rebases
      await simulateRebase(tokenFrom, orderAddress, (value * 20n) / 100n, true) // +20%
      await simulateRebase(tokenFrom, orderAddress, (value * 10n) / 100n, true) // +10%

      const balanceBeforeExpiry = await tokenFrom.balanceOf(orderAddress)
      const expectedBalance = value + (value * 20n) / 100n + (value * 10n) / 100n

      expect(balanceBeforeExpiry).to.be.closeTo(expectedBalance, 10n)

      await time.increase((await stonks.ORDER_DURATION_IN_SECONDS()) + 1n)

      const stonksBalanceBefore = await tokenFrom.balanceOf(stonks)
      await order.recoverTokenFrom()
      const stonksBalanceAfter = await tokenFrom.balanceOf(stonks)

      const orderBalanceAfter = await tokenFrom.balanceOf(order)
      expect(orderBalanceAfter).to.be.closeTo(0n, 1n)
      expect(stonksBalanceAfter).to.be.gt(stonksBalanceBefore)
      expect(stonksBalanceAfter - stonksBalanceBefore).to.be.closeTo(balanceBeforeExpiry, 1n)
    })

    it('should revert recovery when balance below MIN_POSSIBLE_BALANCE after rebases', async function () {
      const orderAddress = await order.getAddress()
      const currentBalance = await tokenFrom.balanceOf(orderAddress)

      // Apply extreme negative rebase to bring balance below 10 wei
      // Leave 5 wei as target, stETH rounding might give us 4-6 wei
      const rebaseToLeave5Wei = currentBalance - 5n
      await simulateRebase(tokenFrom, orderAddress, rebaseToLeave5Wei, false)

      const balanceAfter = await tokenFrom.balanceOf(orderAddress)

      // Skip test if stETH rounding didn't leave us below MIN_POSSIBLE_BALANCE
      if (balanceAfter >= 10n) {
        this.skip()
      }

      const expectedMin = 0n
      const expectedMax = 9n
      expect(balanceAfter).to.be.gte(expectedMin)
      expect(balanceAfter).to.be.lte(expectedMax)

      // Wait for expiration
      await time.increase((await stonks.ORDER_DURATION_IN_SECONDS()) + 1n)

      // Should revert with InvalidAmountToRecover because balance < MIN_POSSIBLE_BALANCE (10 wei)
      await expect(order.recoverTokenFrom())
        .to.be.revertedWithCustomError(order, 'InvalidAmountToRecover')
        .withArgs(balanceAfter)
    })

    it('should handle dust recovery edge case: near MIN_POSSIBLE_BALANCE', async function () {
      const orderAddress = await order.getAddress()
      const currentBalance = await tokenFrom.balanceOf(orderAddress)

      // Apply rebase to leave 12-15 wei (to account for stETH rounding)
      const rebaseToLeave13Wei = currentBalance - 13n
      await simulateRebase(tokenFrom, orderAddress, rebaseToLeave13Wei, false)

      const balanceAfter = await tokenFrom.balanceOf(orderAddress)

      // Should be close to MIN_POSSIBLE_BALANCE (within 10 wei tolerance for stETH)
      expect(balanceAfter).to.be.lte(20n)
      expect(balanceAfter).to.be.gte(10n) // Must be at least MIN_POSSIBLE_BALANCE to recover

      // Wait for expiration
      await time.increase((await stonks.ORDER_DURATION_IN_SECONDS()) + 1n)

      // Should succeed with balance >= MIN_POSSIBLE_BALANCE
      const stonksBalanceBefore = await tokenFrom.balanceOf(stonks)
      await order.recoverTokenFrom()
      const stonksBalanceAfter = await tokenFrom.balanceOf(stonks)

      const orderBalanceAfter = await tokenFrom.balanceOf(order)
      expect(orderBalanceAfter).to.be.closeTo(0n, 1n)
      expect(stonksBalanceAfter).to.be.gt(stonksBalanceBefore)
      expect(stonksBalanceAfter - stonksBalanceBefore).to.be.closeTo(balanceAfter, 1n)
    })
  })

  context('Negative Rebase Beyond Tolerance (No Partial Fills)', function () {
    let stonksNoPartial: Stonks
    let orderNoPartial: Order

    before(async function () {
      // Deploy stonks WITHOUT partial fills
      const { stonks: stonksLocal } = await setup({
        tokenFrom: contracts.STETH,
        tokenTo: contracts.LDO,
        name: 'stETH->LDO No Partial',
        priceFeedHeartbeatTimeout: 86400 * 7,
        useEthBridge: true,
      })
      stonksNoPartial = stonksLocal

      // Fund and create order
      const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
      const token = tokenFrom.connect(treasurySigner)
      await impersonateAccount(contracts.AGENT)
      await token.transfer(await stonksNoPartial.getAddress(), value)

      const expectedBuy = await stonksNoPartial.estimateTradeOutputFromCurrentBalance()
      const orderTx = await stonksNoPartial.placeOrder(expectedBuy)
      const receipt = (await orderTx.wait())!
      const { address } = await getPlaceOrderData(receipt)
      orderNoPartial = await ethers.getContractAt('Order', address)
    })

    it('should revert with InsufficientSellBalance after significant negative rebase', async function () {
      const orderAddress = await orderNoPartial.getAddress()
      const [hash, , , sellAmount] = await orderNoPartial.getOrderDetails()

      // Apply 30% negative rebase
      const rebaseAmount = ((await tokenFrom.balanceOf(orderAddress)) * 30n) / 100n
      await simulateRebase(tokenFrom, orderAddress, rebaseAmount, false)

      const balanceAfter = await tokenFrom.balanceOf(orderAddress)
      expect(balanceAfter).to.be.lt(sellAmount)

      await expect(orderNoPartial.isValidSignature(hash, '0x'))
        .to.be.revertedWithCustomError(orderNoPartial, 'InsufficientSellBalance')
        .withArgs(sellAmount, balanceAfter)
    })

    it('should revert on multiple compounding negative rebases exceeding tolerance', async function () {
      // Apply multiple 10% rebases - compounds to ~60% loss
      const orderAddress = await orderNoPartial.getAddress()
      let currentBalance = await tokenFrom.balanceOf(orderAddress)

      for (let i = 0; i < 5; ++i) {
        const rebaseAmount = (currentBalance * 10n) / 100n
        await simulateRebase(tokenFrom, orderAddress, rebaseAmount, false)
        currentBalance = await tokenFrom.balanceOf(orderAddress)
      }

      const [hash, , , sellAmount] = await orderNoPartial.getOrderDetails()
      await expect(orderNoPartial.isValidSignature(hash, '0x'))
        .to.be.revertedWithCustomError(orderNoPartial, 'InsufficientSellBalance')
        .withArgs(sellAmount, currentBalance)
    })

    it('should revert when balance drops to near zero', async function () {
      const orderAddress = await orderNoPartial.getAddress()
      const currentBalance = await tokenFrom.balanceOf(orderAddress)

      // Drain almost all balance
      const rebaseAmount = (currentBalance * 99n) / 100n
      await simulateRebase(tokenFrom, orderAddress, rebaseAmount, false)

      const [hash, , , sellAmount] = await orderNoPartial.getOrderDetails()
      const balanceAfter = await tokenFrom.balanceOf(orderAddress)

      await expect(orderNoPartial.isValidSignature(hash, '0x'))
        .to.be.revertedWithCustomError(orderNoPartial, 'InsufficientSellBalance')
        .withArgs(sellAmount, balanceAfter)
    })
  })

  context('Unauthorized Access Attempts', function () {
    beforeEach(async function () {
      await snapshotOrderPlaced.restore()
    })

    it('should revert when non-manager tries to place order', async function () {
      const [, , unauthorized] = await ethers.getSigners()

      await expect(stonks.connect(unauthorized).placeOrder(parseEther('1')))
        .to.be.revertedWithCustomError(stonks, 'NotAdminOrManager')
        .withArgs(await unauthorized.getAddress())
    })

    it('anyone can recover tokens from order after expiration', async function () {
      const [, , anyone] = await ethers.getSigners()

      await time.increase((await stonks.ORDER_DURATION_IN_SECONDS()) + 1n)

      // recoverTokenFrom has no access control, anyone can call it after expiration
      await expect(order.connect(anyone).recoverTokenFrom()).to.not.be.reverted
    })

    it('should revert when non-admin/manager tries to recover ERC20 from order', async function () {
      const [, , unauthorized] = await ethers.getSigners()

      await expect(order.connect(unauthorized).recoverERC20(contracts.STETH, 1n))
        .to.be.revertedWithCustomError(order, 'NotAdminOrManager')
        .withArgs(await unauthorized.getAddress())
    })
  })

  context('Multiple Orders Can Be Created', function () {
    it('should allow creating multiple orders consecutively', async function () {
      // Stonks contract doesn't prevent multiple orders - each placeOrder creates a new Order contract
      const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
      const token = tokenFrom.connect(treasurySigner)
      await impersonateAccount(contracts.AGENT)
      await token.transfer(await stonks.getAddress(), value)

      const expectedBuy = await stonks.estimateTradeOutputFromCurrentBalance()
      const orderTx1 = await stonks.placeOrder(expectedBuy)
      const receipt1 = (await orderTx1.wait())!
      const { address: order1Address } = await getPlaceOrderData(receipt1)

      // Fund again
      await token.transfer(await stonks.getAddress(), value)

      // Can create another order - Stonks doesn't track/prevent this
      const orderTx2 = await stonks.placeOrder(expectedBuy)
      const receipt2 = (await orderTx2.wait())!
      const { address: order2Address } = await getPlaceOrderData(receipt2)

      expect(order1Address).to.not.equal(order2Address)
    })

    it('should fail when insufficient balance for new order', async function () {
      const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
      const token = tokenFrom.connect(treasurySigner)
      await impersonateAccount(contracts.AGENT)
      await token.transfer(await stonks.getAddress(), value)

      const expectedBuy = await stonks.estimateTradeOutputFromCurrentBalance()
      await stonks.placeOrder(expectedBuy)

      // Now balance is zero, second order should fail
      await expect(stonks.placeOrder(parseEther('1'))).to.be.revertedWithCustomError(
        stonks,
        'MinimumPossibleBalanceNotMet'
      )
    })
  })

  context('Recovery Before Expiration', function () {
    beforeEach(async function () {
      await snapshotOrderPlaced.restore()
    })

    it('should revert when trying to recover before expiration', async function () {
      const [, , , , , validTo] = await order.getOrderDetails()

      await expect(order.recoverTokenFrom())
        .to.be.revertedWithCustomError(order, 'OrderNotExpired')
        .withArgs(validTo, anyValue)
    })

    it('should revert even after 99% of order duration', async function () {
      const duration = await stonks.ORDER_DURATION_IN_SECONDS()
      await time.increase((duration * 99n) / 100n)

      const [, , , , , validTo] = await order.getOrderDetails()

      await expect(order.recoverTokenFrom())
        .to.be.revertedWithCustomError(order, 'OrderNotExpired')
        .withArgs(validTo, anyValue)
    })
  })

  context('Invalid Hash Scenarios', function () {
    beforeEach(async function () {
      await snapshotOrderPlaced.restore()
    })

    it('should revert with wrong order hash', async function () {
      const [correctHash] = await order.getOrderDetails()
      const wrongHash = ethers.ZeroHash

      await expect(order.isValidSignature(wrongHash, '0x'))
        .to.be.revertedWithCustomError(order, 'InvalidOrderHash')
        .withArgs(correctHash, wrongHash)
    })

    it('should revert with random hash', async function () {
      const [correctHash] = await order.getOrderDetails()
      const randomHash = ethers.keccak256(ethers.toUtf8Bytes('random'))

      await expect(order.isValidSignature(randomHash, '0x'))
        .to.be.revertedWithCustomError(order, 'InvalidOrderHash')
        .withArgs(correctHash, randomHash)
    })
  })

  context('Expired Order Operations', function () {
    beforeEach(async function () {
      await snapshotOrderPlaced.restore()
    })

    it('should revert signature validation after expiration', async function () {
      await time.increase((await stonks.ORDER_DURATION_IN_SECONDS()) + 1n)

      const [hash, , , , , validTo] = await order.getOrderDetails()

      await expect(order.isValidSignature(hash, '0x'))
        .to.be.revertedWithCustomError(order, 'OrderExpired')
        .withArgs(validTo)
    })

    it('should revert on expired order even with positive rebase', async function () {
      const orderAddress = await order.getAddress()

      // Apply positive rebase
      await simulateRebase(tokenFrom, orderAddress, (value * 10n) / 100n, true)

      // Wait for expiration
      await time.increase((await stonks.ORDER_DURATION_IN_SECONDS()) + 1n)

      const [hash, , , , , validTo] = await order.getOrderDetails()

      await expect(order.isValidSignature(hash, '0x'))
        .to.be.revertedWithCustomError(order, 'OrderExpired')
        .withArgs(validTo)
    })

    it('should still be valid exactly at expiration timestamp', async function () {
      // Order is valid until validTo (inclusive: validTo >= block.timestamp)
      await time.increase(await stonks.ORDER_DURATION_IN_SECONDS())

      const [hash] = await order.getOrderDetails()

      // At exact expiration time, order is still valid due to >= check
      expect(await order.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)
    })
  })

  context('Insufficient Balance Scenarios', function () {
    it('should revert when trying to place order with insufficient balance', async function () {
      // stonks has no balance - placeOrder should fail
      const amount = parseEther('1')
      await expect(stonks.placeOrder(amount)).to.be.revertedWithCustomError(
        stonks,
        'MinimumPossibleBalanceNotMet'
      )
    })

    it('should revert when balance is below minimum (10 wei)', async function () {
      const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
      const token = tokenFrom.connect(treasurySigner)
      await impersonateAccount(contracts.AGENT)

      // Transfer tiny amount (below minimum of 10 wei)
      // stETH shares-based system may round, so check actual balance
      await token.transfer(await stonks.getAddress(), 5n)
      const actualBalance = await token.balanceOf(stonks)
      expect(actualBalance).to.be.lt(10n)

      await expect(stonks.placeOrder(1n))
        .to.be.revertedWithCustomError(stonks, 'MinimumPossibleBalanceNotMet')
        .withArgs(10n, actualBalance)
    })
  })

  context('Catastrophic Rebase Scenarios', function () {
    beforeEach(async function () {
      await snapshotOrderPlaced.restore()
    })

    it('should handle 90% negative rebase', async function () {
      const orderAddress = await order.getAddress()
      const initialBalance = await tokenFrom.balanceOf(orderAddress)
      const rebaseAmount = (initialBalance * 90n) / 100n

      await simulateRebase(tokenFrom, orderAddress, rebaseAmount, false)

      const finalBalance = await tokenFrom.balanceOf(orderAddress)
      expect(finalBalance).to.be.lt((initialBalance * 15n) / 100n)

      // Order should remain valid with partial fills enabled even after 90% rebase
      const [hash] = await order.getOrderDetails()
      expect(await order.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)
    })

    it('should handle multiple severe rebases in succession', async function () {
      const orderAddress = await order.getAddress()
      let currentBalance = await tokenFrom.balanceOf(orderAddress)

      // Three 25% rebases
      for (let i = 0; i < 3; ++i) {
        const rebaseAmount = (currentBalance * 25n) / 100n
        await simulateRebase(tokenFrom, orderAddress, rebaseAmount, false)
        currentBalance = await tokenFrom.balanceOf(orderAddress)
      }

      // Should be ~42% of original (less than 50%)
      expect(currentBalance).to.be.lt((value * 50n) / 100n)
    })
  })

  context('Edge Cases', function () {
    beforeEach(async function () {
      await snapshotOrderPlaced.restore()
    })

    it('should handle dust amounts after multiple rebases', async function () {
      const dustValue = parseEther('0.001')
      const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
      const token = tokenFrom.connect(treasurySigner)
      await impersonateAccount(contracts.AGENT)
      await token.transfer(stonks, dustValue)

      const expectedBuy = await stonks.estimateTradeOutputFromCurrentBalance()
      const orderTx = await stonks.placeOrder(expectedBuy)
      const receipt = (await orderTx.wait())!
      const { address } = await getPlaceOrderData(receipt)

      const initialBalance = await tokenFrom.balanceOf(address)

      // Multiple tiny rebases
      let currentBalance = initialBalance
      await simulateRebase(tokenFrom, address, (currentBalance * 1n) / 100n, false) // -1%

      // Recalculate after first rebase
      currentBalance = await tokenFrom.balanceOf(address)
      await simulateRebase(tokenFrom, address, (currentBalance * 5n) / 1000n, false) // -0.5%

      const finalBalance = await tokenFrom.balanceOf(address)

      // After -1% and -0.5% rebases, should be roughly 98.5% remaining
      expect(finalBalance).to.be.gt(0)
      expect(finalBalance).to.be.lt(initialBalance)
      expect(finalBalance).to.be.gt((initialBalance * 98n) / 100n)
      expect(finalBalance).to.be.lt((initialBalance * 99n) / 100n)
    })

    it('should validate order parameters remain unchanged after rebases', async function () {
      const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
      const token = tokenFrom.connect(treasurySigner)
      await impersonateAccount(contracts.AGENT)
      await token.transfer(stonks, value)

      const orderTx = await stonks.placeOrder(await stonks.estimateTradeOutputFromCurrentBalance())
      const receipt = (await orderTx.wait())!
      const { address } = await getPlaceOrderData(receipt)
      const testOrder = await ethers.getContractAt('Order', address)

      const [hashBefore, , , sellAmountBefore, buyAmountBefore, validToBefore] =
        await testOrder.getOrderDetails()

      // Apply rebase
      await simulateRebase(tokenFrom, address, (value * 10n) / 100n, true)

      const [hashAfter, , , sellAmountAfter, buyAmountAfter, validToAfter] =
        await testOrder.getOrderDetails()

      // Order parameters should remain unchanged
      expect(hashBefore).to.equal(hashAfter)
      expect(sellAmountBefore).to.equal(sellAmountAfter)
      expect(buyAmountBefore).to.equal(buyAmountAfter)
      expect(validToBefore).to.equal(validToAfter)
    })
  })

  context('Dust Recovery from Stonks Contract', function () {
    let snapshot: SnapshotRestorer

    beforeEach(async function () {
      snapshot = await takeSnapshot()
    })

    afterEach(async function () {
      await snapshot.restore()
    })

    it('should allow admin to recover dust stETH from Stonks contract', async function () {
      const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
      await impersonateAccount(contracts.AGENT)

      // Send dust amount to stonks (stETH rounding might transfer slightly less)
      const dustAmount = 1000n // 1000 wei
      await tokenFrom.connect(treasurySigner).transfer(await stonks.getAddress(), dustAmount)

      const stonksBalance = await tokenFrom.balanceOf(stonks)
      expect(stonksBalance).to.be.gt(0n)
      expect(stonksBalance).to.be.closeTo(dustAmount, 10n)

      const agentBalanceBefore = await tokenFrom.balanceOf(contracts.AGENT)

      // Recover actual balance to account for stETH shares-based rounding
      const adminSigner = await ethers.getImpersonatedSigner(contracts.ADMIN)
      await ethers.provider.send('hardhat_setBalance', [contracts.ADMIN, '0x1000000000000000000'])
      await stonks.connect(adminSigner).recoverERC20(await tokenFrom.getAddress(), stonksBalance)

      const agentBalanceAfter = await tokenFrom.balanceOf(contracts.AGENT)
      const stonksBalanceAfter = await tokenFrom.balanceOf(stonks)

      expect(agentBalanceAfter).to.be.gt(agentBalanceBefore)
      expect(agentBalanceAfter - agentBalanceBefore).to.be.closeTo(stonksBalance, 2n)
      expect(stonksBalanceAfter).to.be.lt(stonksBalance)
    })

    it('should allow manager to recover dust stETH from Stonks contract', async function () {
      await impersonateAccount(contracts.AGENT)
      const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)

      // Send dust amount to stonks
      const dustAmount = 500n // 500 wei
      await tokenFrom.connect(treasurySigner).transfer(await stonks.getAddress(), dustAmount)

      const agentBalanceBefore = await tokenFrom.balanceOf(contracts.AGENT)

      // Manager recovers dust (sent to AGENT)
      await stonks.connect(manager).recoverERC20(await tokenFrom.getAddress(), dustAmount)

      const agentBalanceAfter = await tokenFrom.balanceOf(contracts.AGENT)
      expect(agentBalanceAfter).to.be.gt(agentBalanceBefore)
      expect(agentBalanceAfter - agentBalanceBefore).to.be.closeTo(dustAmount, 2n)
    })

    it('should recover dust from Stonks after order expires and tokens are recovered', async function () {
      const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
      await impersonateAccount(contracts.AGENT)

      // Create order
      await tokenFrom.connect(treasurySigner).transfer(await stonks.getAddress(), value)
      const expectedBuy = await stonks.estimateTradeOutputFromCurrentBalance()
      const orderTx = await stonks.placeOrder(expectedBuy)
      const receipt = (await orderTx.wait())!
      const { address: orderAddr } = await getPlaceOrderData(receipt)
      const testOrder = await ethers.getContractAt('Order', orderAddr)

      // Apply negative rebase leaving more than MIN_POSSIBLE_BALANCE
      await simulateRebase(tokenFrom, orderAddr, (value * 50n) / 100n, false) // -50%

      // Wait for expiration and recover
      await time.increase((await stonks.ORDER_DURATION_IN_SECONDS()) + 1n)
      await testOrder.recoverTokenFrom()

      // Now stonks has recovered balance, send some dust
      const dustAmount = 1000n
      await tokenFrom.connect(treasurySigner).transfer(await stonks.getAddress(), dustAmount)

      const stonksBalance = await tokenFrom.balanceOf(stonks)
      expect(stonksBalance).to.be.gt(dustAmount)

      const agentBalanceBefore = await tokenFrom.balanceOf(contracts.AGENT)

      // Recover all remaining balance including dust
      const adminSigner = await ethers.getImpersonatedSigner(contracts.ADMIN)
      await ethers.provider.send('hardhat_setBalance', [contracts.ADMIN, '0x1000000000000000000'])
      await stonks.connect(adminSigner).recoverERC20(await tokenFrom.getAddress(), stonksBalance)

      const agentBalanceAfter = await tokenFrom.balanceOf(contracts.AGENT)
      expect(agentBalanceAfter).to.be.gt(agentBalanceBefore)
      expect(agentBalanceAfter - agentBalanceBefore).to.be.closeTo(stonksBalance, 2n)
    })

    it('should not allow unauthorized users to recover dust from Stonks', async function () {
      const [, , unauthorized] = await ethers.getSigners()

      await expect(
        stonks.connect(unauthorized).recoverERC20(await tokenFrom.getAddress(), 100n)
      ).to.be.revertedWithCustomError(stonks, 'NotAdminOrManager')
    })

    it('should recover dust LDO tokens accidentally sent to Stonks', async function () {
      const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
      await impersonateAccount(contracts.AGENT)

      // Accidentally send LDO (tokenTo) to Stonks
      const accidentalAmount = parseEther('1')
      await tokenTo.connect(treasurySigner).transfer(await stonks.getAddress(), accidentalAmount)

      const stonksLdoBalance = await tokenTo.balanceOf(stonks)
      expect(stonksLdoBalance).to.be.gte(accidentalAmount)

      const agentBalanceBefore = await tokenTo.balanceOf(contracts.AGENT)

      // Recover accidental LDO
      const adminSigner = await ethers.getImpersonatedSigner(contracts.ADMIN)
      await ethers.provider.send('hardhat_setBalance', [contracts.ADMIN, '0x1000000000000000000'])
      await stonks.connect(adminSigner).recoverERC20(await tokenTo.getAddress(), accidentalAmount)

      const agentBalanceAfter = await tokenTo.balanceOf(contracts.AGENT)
      expect(agentBalanceAfter - agentBalanceBefore).to.be.closeTo(accidentalAmount, 2n)
    })
  })
})
