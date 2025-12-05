import { ethers } from 'hardhat'
import { expect } from 'chai'
import { parseEther, Signer } from 'ethers'
import {
  setBalance,
  impersonateAccount,
  takeSnapshot,
  SnapshotRestorer,
  time,
} from '@nomicfoundation/hardhat-network-helpers'
import { setup, TokenPair } from './setup'
import { getContracts } from '../../utils/contracts'
import { IERC20, Stonks, Order } from '../../typechain-types'
import { MAGIC_VALUE } from '../../utils/gpv2-helpers'
import { getPlaceOrderData } from '../../utils/get-events'
import {
  simulatePartialFill,
  REBASE_TOLERANCE,
  MULTI_REBASE_TOLERANCE,
} from '../helpers/rebase-helpers'
import { placeOrderFromAgent } from '../helpers/order-helpers'

const contracts = getContracts()

describe('Multi-order scenarios', function () {
  let snapshot: SnapshotRestorer
  let stonks: Stonks
  let manager: Signer
  let tokenFrom: IERC20

  const pair: TokenPair = {
    tokenFrom: contracts.STETH,
    tokenTo: contracts.LDO,
    priceFeedHeartbeatTimeout: 86400,
    useEthBridge: true,
    allowPartialFill: true,
  }

  before(async function () {
    snapshot = await takeSnapshot()

    const result = await setup(pair)
    stonks = result.stonks
    manager = result.manager

    tokenFrom = await ethers.getContractAt('IERC20', await stonks.TOKEN_FROM())

    await setBalance(await manager.getAddress(), parseEther('100'))
    await setBalance(contracts.AGENT, parseEther('100'))
  })

  after(async function () {
    await snapshot.restore()
  })
  const placeOrder = async (fundAmount: bigint): Promise<Order> => {
    return placeOrderFromAgent(stonks, manager, tokenFrom, fundAmount)
  }

  describe('Sequential orders', function () {
    let testSnapshot: SnapshotRestorer

    beforeEach(async function () {
      testSnapshot = await takeSnapshot()
    })

    afterEach(async function () {
      await testSnapshot.restore()
    })

    it('should place second order after first expires', async function () {
      const order1 = await placeOrder(parseEther('1000'))
      const [hash1] = await order1.getOrderDetails()
      expect(await order1.isValidSignature(hash1, '0x')).to.equal(MAGIC_VALUE)

      const orderDuration = await stonks.ORDER_DURATION_IN_SECONDS()
      await time.increase(orderDuration + 1n)

      await expect(order1.isValidSignature(hash1, '0x')).to.be.revertedWithCustomError(
        order1,
        'OrderExpired'
      )

      const order2 = await placeOrder(parseEther('500'))
      const [hash2] = await order2.getOrderDetails()
      expect(await order2.isValidSignature(hash2, '0x')).to.equal(MAGIC_VALUE)

      expect(await order1.getAddress()).to.not.equal(await order2.getAddress())
    })

    it('should handle 5 sequential orders with partial fills', async function () {
      const orders: Order[] = []

      for (let i = 0; i < 5; i++) {
        const order = await placeOrder(parseEther('100'))
        orders.push(order)

        await simulatePartialFill(tokenFrom, await order.getAddress(), 30)

        const [hash] = await order.getOrderDetails()
        expect(await order.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)

        const orderDuration = await stonks.ORDER_DURATION_IN_SECONDS()
        await time.increase(orderDuration + 1n)
      }

      expect(orders.length).to.equal(5)

      const uniqueAddresses = new Set(await Promise.all(orders.map((o) => o.getAddress())))
      expect(uniqueAddresses.size).to.equal(5)
    })

    it('should maintain independent state across orders', async function () {
      const order1 = await placeOrder(parseEther('1000'))
      const [, , , sellAmount1, buyAmount1] = await order1.getOrderDetails()

      const orderDuration = await stonks.ORDER_DURATION_IN_SECONDS()
      await time.increase(orderDuration + 1n)

      const order2 = await placeOrder(parseEther('500'))
      const [, , , sellAmount2, buyAmount2] = await order2.getOrderDetails()

      expect(sellAmount1).to.not.equal(sellAmount2)
      expect(buyAmount1).to.not.equal(buyAmount2)

      const ratio1 = (sellAmount1 * 10000n) / buyAmount1
      const ratio2 = (sellAmount2 * 10000n) / buyAmount2

      expect(ratio1).to.be.closeTo(ratio2, 10n)
    })
  })

  describe('Order lifecycle edge cases', function () {
    let testSnapshot: SnapshotRestorer

    beforeEach(async function () {
      testSnapshot = await takeSnapshot()
    })

    afterEach(async function () {
      await testSnapshot.restore()
    })

    it('should handle order placement with zero balance in Stonks', async function () {
      const stonksBalance = await tokenFrom.balanceOf(await stonks.getAddress())
      if (stonksBalance > 0n) {
        const adminSigner = await ethers.getImpersonatedSigner(contracts.ADMIN)
        await setBalance(contracts.ADMIN, parseEther('1'))
        await stonks.connect(adminSigner).recoverERC20(await tokenFrom.getAddress(), 0n)
      }

      expect(await tokenFrom.balanceOf(await stonks.getAddress())).to.equal(0n)

      await expect(
        stonks.connect(manager).placeOrder(parseEther('1'))
      ).to.be.revertedWithCustomError(stonks, 'MinimumPossibleBalanceNotMet')
    })

    it('should handle rapid order placements (stress test)', async function () {
      const orders: Order[] = []

      for (let i = 0; i < 3; i++) {
        const order = await placeOrder(parseEther('10'))
        orders.push(order)

        const orderDuration = await stonks.ORDER_DURATION_IN_SECONDS()
        await time.increase(orderDuration + 1n)
      }

      for (const order of orders) {
        const [hash] = await order.getOrderDetails()
        await expect(order.isValidSignature(hash, '0x')).to.be.revertedWithCustomError(
          order,
          'OrderExpired'
        )
      }
    })
  })

  describe('Rebase affecting order placement', function () {
    let testSnapshot: SnapshotRestorer

    beforeEach(async function () {
      testSnapshot = await takeSnapshot()
    })

    afterEach(async function () {
      await testSnapshot.restore()
    })

    it('should reflect rebase in Stonks balance before placing new order', async function () {
      const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
      await impersonateAccount(contracts.AGENT)
      await tokenFrom
        .connect(treasurySigner)
        .transfer(await stonks.getAddress(), parseEther('1000'))

      const stonksAddress = await stonks.getAddress()
      const balanceBefore = await tokenFrom.balanceOf(stonksAddress)

      const rebaseAmount = parseEther('100')
      await tokenFrom.connect(treasurySigner).transfer(stonksAddress, rebaseAmount)

      const balanceAfter = await tokenFrom.balanceOf(stonksAddress)
      expect(balanceAfter).to.be.closeTo(balanceBefore + rebaseAmount, REBASE_TOLERANCE)

      const estimatedBuyAmount = await stonks.estimateTradeOutputFromCurrentBalance()
      const tx = await stonks.connect(manager).placeOrder(estimatedBuyAmount)
      const receipt = await tx.wait()
      if (!receipt) throw new Error('No receipt')

      const orderData = await getPlaceOrderData(receipt)
      const order = await ethers.getContractAt('Order', orderData.address)

      const [, , , sellAmount] = await order.getOrderDetails()
      expect(sellAmount).to.be.closeTo(balanceAfter, REBASE_TOLERANCE)
    })

    it('should place order with correct amount after negative "rebase" in Stonks', async function () {
      const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
      await impersonateAccount(contracts.AGENT)
      await tokenFrom
        .connect(treasurySigner)
        .transfer(await stonks.getAddress(), parseEther('1000'))

      const stonksAddress = await stonks.getAddress()
      await impersonateAccount(stonksAddress)
      await setBalance(stonksAddress, parseEther('1'))

      const stonksSigner = await ethers.getSigner(stonksAddress)
      const [, recipient] = await ethers.getSigners()

      const balanceBefore = await tokenFrom.balanceOf(stonksAddress)
      const rebaseAmount = parseEther('100')
      await tokenFrom.connect(stonksSigner).transfer(await recipient.getAddress(), rebaseAmount)

      const balanceAfter = await tokenFrom.balanceOf(stonksAddress)
      expect(balanceAfter).to.be.closeTo(balanceBefore - rebaseAmount, REBASE_TOLERANCE)

      const estimatedBuyAmount = await stonks.estimateTradeOutputFromCurrentBalance()
      const tx = await stonks.connect(manager).placeOrder(estimatedBuyAmount)
      const receipt = await tx.wait()
      if (!receipt) throw new Error('No receipt')

      const orderData = await getPlaceOrderData(receipt)
      const order = await ethers.getContractAt('Order', orderData.address)

      const [, , , sellAmount] = await order.getOrderDetails()
      expect(sellAmount).to.be.closeTo(balanceAfter, REBASE_TOLERANCE)
    })
  })

  describe('Order cancellation and recovery patterns', function () {
    let testSnapshot: SnapshotRestorer

    beforeEach(async function () {
      testSnapshot = await takeSnapshot()
    })

    afterEach(async function () {
      await testSnapshot.restore()
    })

    it('should recover from multiple expired orders', async function () {
      const orders: Order[] = []

      for (let i = 0; i < 3; i++) {
        const order = await placeOrder(parseEther('100'))
        orders.push(order)

        const orderDuration = await stonks.ORDER_DURATION_IN_SECONDS()
        await time.increase(orderDuration + 1n)
      }

      const orderDuration = await stonks.ORDER_DURATION_IN_SECONDS()
      await time.increase(Number(orderDuration) + 1)

      const stonksBalanceBefore = await tokenFrom.balanceOf(await stonks.getAddress())

      let totalExpectedRecovery = 0n
      for (const order of orders) {
        const orderBalance = await tokenFrom.balanceOf(await order.getAddress())
        totalExpectedRecovery += orderBalance
        await order.recoverTokenFrom()
      }

      const stonksBalanceAfter = await tokenFrom.balanceOf(await stonks.getAddress())
      expect(stonksBalanceAfter).to.be.closeTo(
        stonksBalanceBefore + totalExpectedRecovery,
        MULTI_REBASE_TOLERANCE
      )
    })

    it('should handle emergency cancel of order after partial fill', async function () {
      const order = await placeOrder(parseEther('1000'))

      const adminSigner = await ethers.getImpersonatedSigner(contracts.ADMIN)
      await setBalance(contracts.ADMIN, parseEther('1'))

      await order.connect(adminSigner).setEmergencyOperator(await adminSigner.getAddress())

      const { remainingBalance } = await simulatePartialFill(
        tokenFrom,
        await order.getAddress(),
        40
      )

      const stonksBalanceBefore = await tokenFrom.balanceOf(await stonks.getAddress())
      await order.connect(adminSigner).emergencyCancelAndReturn()
      const stonksBalanceAfter = await tokenFrom.balanceOf(await stonks.getAddress())

      expect(stonksBalanceAfter).to.be.closeTo(
        stonksBalanceBefore + remainingBalance,
        REBASE_TOLERANCE
      )

      const [hash] = await order.getOrderDetails()
      await expect(order.isValidSignature(hash, '0x')).to.be.revertedWithCustomError(
        order,
        'OrderCancelled'
      )
    })
  })

  describe('Advanced multi-order behavior', function () {
    let testSnapshot: SnapshotRestorer

    beforeEach(async function () {
      testSnapshot = await takeSnapshot()
    })

    afterEach(async function () {
      await testSnapshot.restore()
    })

    it('should handle 10+ concurrent orders for same token pair', async function () {
      const orders: Order[] = []
      const orderCount = 12

      for (let i = 0; i < orderCount; i++) {
        const order = await placeOrder(parseEther('10'))
        orders.push(order)

        const [hash] = await order.getOrderDetails()
        expect(await order.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)
      }

      expect(orders.length).to.equal(orderCount)

      const addresses = await Promise.all(orders.map((o) => o.getAddress()))
      const uniqueAddresses = new Set(addresses)
      expect(uniqueAddresses.size).to.equal(orderCount)

      for (const order of orders) {
        const [hash, , , sellAmount, buyAmount] = await order.getOrderDetails()
        expect(await order.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)
        expect(sellAmount).to.be.greaterThan(0n)
        expect(buyAmount).to.be.greaterThan(0n)
      }
    })

    it('should handle order expiration cascades', async function () {
      const orders: Order[] = []
      const expirations = [1, 2, 3]

      for (const expiry of expirations) {
        const order = await placeOrder(parseEther('20'))
        orders.push(order)
        await time.increase(expiry * 3600)
      }

      for (const order of orders) {
        const [hash] = await order.getOrderDetails()
        await expect(order.isValidSignature(hash, '0x')).to.be.revertedWithCustomError(
          order,
          'OrderExpired'
        )
      }

      const stonksBalanceBefore = await tokenFrom.balanceOf(await stonks.getAddress())
      let totalRecovered = 0n

      for (let i = orders.length - 1; i >= 0; i--) {
        const balance = await tokenFrom.balanceOf(await orders[i].getAddress())
        totalRecovered += balance
        await orders[i].recoverTokenFrom()
      }

      const stonksBalanceAfter = await tokenFrom.balanceOf(await stonks.getAddress())
      expect(stonksBalanceAfter).to.be.closeTo(
        stonksBalanceBefore + totalRecovered,
        MULTI_REBASE_TOLERANCE
      )
    })

    it('should handle emergency cancel on subset of active orders', async function () {
      const orders: Order[] = []

      const adminSigner = await ethers.getImpersonatedSigner(contracts.ADMIN)
      await setBalance(contracts.ADMIN, parseEther('1'))

      for (let i = 0; i < 5; i++) {
        const order = await placeOrder(parseEther('15'))
        orders.push(order)
        await order.connect(adminSigner).setEmergencyOperator(await adminSigner.getAddress())
      }

      for (const order of orders) {
        const [hash] = await order.getOrderDetails()
        expect(await order.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)
      }

      await orders[1].connect(adminSigner).emergencyCancelAndReturn()
      await orders[3].connect(adminSigner).emergencyCancelAndReturn()

      const [hash0] = await orders[0].getOrderDetails()
      const [hash1] = await orders[1].getOrderDetails()
      const [hash2] = await orders[2].getOrderDetails()
      const [hash3] = await orders[3].getOrderDetails()
      const [hash4] = await orders[4].getOrderDetails()

      expect(await orders[0].isValidSignature(hash0, '0x')).to.equal(MAGIC_VALUE)
      await expect(orders[1].isValidSignature(hash1, '0x')).to.be.revertedWithCustomError(
        orders[1],
        'OrderCancelled'
      )
      expect(await orders[2].isValidSignature(hash2, '0x')).to.equal(MAGIC_VALUE)
      await expect(orders[3].isValidSignature(hash3, '0x')).to.be.revertedWithCustomError(
        orders[3],
        'OrderCancelled'
      )
      expect(await orders[4].isValidSignature(hash4, '0x')).to.equal(MAGIC_VALUE)
    })
  })
})
