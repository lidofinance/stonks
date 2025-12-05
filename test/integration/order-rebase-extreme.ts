import { ethers } from 'hardhat'
import { expect } from 'chai'
import { parseEther, Signer } from 'ethers'
import {
  setBalance,
  takeSnapshot,
  SnapshotRestorer,
  time,
} from '@nomicfoundation/hardhat-network-helpers'
import { setup, TokenPair } from './setup'
import { getContracts } from '../../utils/contracts'
import { IERC20, Stonks, Order } from '../../typechain-types'
import { placeOrderFromAgent } from '../helpers/order-helpers'
import { MAGIC_VALUE } from '../../utils/gpv2-helpers'
import {
  simulateRebase,
  simulatePartialFill,
  EXTREME_REBASE_TOLERANCE,
  REBASE_TOLERANCE,
} from '../helpers/rebase-helpers'

const contracts = getContracts()

describe('Extreme rebase scenarios', function () {
  let snapshot: SnapshotRestorer
  let stonks: Stonks
  let manager: Signer
  let tokenFrom: IERC20
  let order: Order
  let orderAddress: string

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

    expect(await stonks.ALLOW_PARTIAL_FILL()).to.equal(true)
  })

  after(async function () {
    await snapshot.restore()
  })

  const placeOrder = async (fundAmount: bigint) => {
    const createdOrder = await placeOrderFromAgent(stonks, manager, tokenFrom, fundAmount)
    order = createdOrder
    orderAddress = await createdOrder.getAddress()
    return createdOrder
  }

  describe('Extreme positive rebases', function () {
    let testSnapshot: SnapshotRestorer

    beforeEach(async function () {
      testSnapshot = await takeSnapshot()
      await placeOrder(parseEther('1000'))
    })

    afterEach(async function () {
      await testSnapshot.restore()
    })

    it('should handle 1000% positive rebase (10x increase)', async function () {
      await simulatePartialFill(tokenFrom, orderAddress, 50)

      const balanceBefore = await tokenFrom.balanceOf(orderAddress)
      const rebaseAmount = balanceBefore * 10n

      await simulateRebase(tokenFrom, orderAddress, rebaseAmount, true)

      const balanceAfter = await tokenFrom.balanceOf(orderAddress)
      expect(balanceAfter).to.be.closeTo(balanceBefore + rebaseAmount, EXTREME_REBASE_TOLERANCE)

      const [currentHash] = await order.getOrderDetails()
      expect(await order.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
    })

    it('should handle 100% positive rebase after 90% fill', async function () {
      await simulatePartialFill(tokenFrom, orderAddress, 90)

      const balanceBefore = await tokenFrom.balanceOf(orderAddress)
      const rebaseAmount = balanceBefore

      await simulateRebase(tokenFrom, orderAddress, rebaseAmount, true)

      const balanceAfter = await tokenFrom.balanceOf(orderAddress)
      expect(balanceAfter).to.be.closeTo(balanceBefore * 2n, REBASE_TOLERANCE)

      const [currentHash] = await order.getOrderDetails()
      expect(await order.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
    })

    it('should handle series of 50% positive rebases', async function () {
      let currentBalance = await tokenFrom.balanceOf(orderAddress)

      for (let i = 0; i < 5; i++) {
        const rebaseAmount = currentBalance / 2n
        await simulateRebase(tokenFrom, orderAddress, rebaseAmount, true)
        currentBalance = await tokenFrom.balanceOf(orderAddress)

        const [currentHash] = await order.getOrderDetails()
        expect(await order.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
      }

      const finalBalance = await tokenFrom.balanceOf(orderAddress)
      expect(finalBalance).to.be.closeTo(parseEther('7593.75'), EXTREME_REBASE_TOLERANCE)
    })
  })

  describe('Extreme negative rebases', function () {
    let testSnapshot: SnapshotRestorer

    beforeEach(async function () {
      testSnapshot = await takeSnapshot()
      await placeOrder(parseEther('1000'))
    })

    afterEach(async function () {
      await testSnapshot.restore()
    })

    it('should handle 99% negative rebase (near-total loss)', async function () {
      await simulatePartialFill(tokenFrom, orderAddress, 50)

      const balanceBefore = await tokenFrom.balanceOf(orderAddress)
      const rebaseAmount = (balanceBefore * 99n) / 100n

      await simulateRebase(tokenFrom, orderAddress, rebaseAmount, false)

      const balanceAfter = await tokenFrom.balanceOf(orderAddress)
      expect(balanceAfter).to.be.closeTo(balanceBefore / 100n, REBASE_TOLERANCE)

      const [currentHash] = await order.getOrderDetails()
      expect(await order.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
    })

    it('should handle 95% negative rebase after 80% fill', async function () {
      await simulatePartialFill(tokenFrom, orderAddress, 80)

      const balanceBefore = await tokenFrom.balanceOf(orderAddress)
      const rebaseAmount = (balanceBefore * 95n) / 100n

      await simulateRebase(tokenFrom, orderAddress, rebaseAmount, false)

      const balanceAfter = await tokenFrom.balanceOf(orderAddress)
      expect(balanceAfter).to.be.closeTo((balanceBefore * 5n) / 100n, REBASE_TOLERANCE)

      const [currentHash] = await order.getOrderDetails()
      expect(await order.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
    })

    it('should handle series of 20% negative rebases', async function () {
      let currentBalance = await tokenFrom.balanceOf(orderAddress)

      for (let i = 0; i < 5; i++) {
        const rebaseAmount = (currentBalance * 20n) / 100n
        await simulateRebase(tokenFrom, orderAddress, rebaseAmount, false)
        currentBalance = await tokenFrom.balanceOf(orderAddress)

        const [currentHash] = await order.getOrderDetails()
        expect(await order.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
      }

      const finalBalance = await tokenFrom.balanceOf(orderAddress)
      expect(finalBalance).to.be.closeTo(parseEther('327.68'), EXTREME_REBASE_TOLERANCE)
    })

    it('should handle rebase reducing balance to near-zero', async function () {
      await simulatePartialFill(tokenFrom, orderAddress, 99)

      const balanceBefore = await tokenFrom.balanceOf(orderAddress)
      const rebaseAmount = balanceBefore - parseEther('0.01')

      await simulateRebase(tokenFrom, orderAddress, rebaseAmount, false)

      const balanceAfter = await tokenFrom.balanceOf(orderAddress)
      expect(balanceAfter).to.be.closeTo(parseEther('0.01'), parseEther('0.001'))

      const [currentHash] = await order.getOrderDetails()
      expect(await order.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
    })
  })

  describe('Alternating extreme rebases', function () {
    let testSnapshot: SnapshotRestorer

    beforeEach(async function () {
      testSnapshot = await takeSnapshot()
      await placeOrder(parseEther('1000'))
    })

    afterEach(async function () {
      await testSnapshot.restore()
    })

    it('should handle +100%, -50%, +100%, -50% pattern', async function () {
      let currentBalance = await tokenFrom.balanceOf(orderAddress)

      await simulateRebase(tokenFrom, orderAddress, currentBalance, true)
      currentBalance = await tokenFrom.balanceOf(orderAddress)
      expect(currentBalance).to.be.closeTo(parseEther('2000'), REBASE_TOLERANCE)

      await simulateRebase(tokenFrom, orderAddress, currentBalance / 2n, false)
      currentBalance = await tokenFrom.balanceOf(orderAddress)
      expect(currentBalance).to.be.closeTo(parseEther('1000'), REBASE_TOLERANCE)

      await simulateRebase(tokenFrom, orderAddress, currentBalance, true)
      currentBalance = await tokenFrom.balanceOf(orderAddress)
      expect(currentBalance).to.be.closeTo(parseEther('2000'), REBASE_TOLERANCE)

      await simulateRebase(tokenFrom, orderAddress, currentBalance / 2n, false)
      currentBalance = await tokenFrom.balanceOf(orderAddress)
      expect(currentBalance).to.be.closeTo(parseEther('1000'), REBASE_TOLERANCE)

      const [currentHash] = await order.getOrderDetails()
      expect(await order.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
    })

    it('should handle +500%, fill 50%, -90% sequence', async function () {
      const initialBalance = await tokenFrom.balanceOf(orderAddress)

      await simulateRebase(tokenFrom, orderAddress, initialBalance * 5n, true)
      let currentBalance = await tokenFrom.balanceOf(orderAddress)
      expect(currentBalance).to.be.closeTo(parseEther('6000'), EXTREME_REBASE_TOLERANCE)

      await simulatePartialFill(tokenFrom, orderAddress, 50)
      currentBalance = await tokenFrom.balanceOf(orderAddress)

      const rebaseAmount = (currentBalance * 90n) / 100n
      await simulateRebase(tokenFrom, orderAddress, rebaseAmount, false)
      const finalBalance = await tokenFrom.balanceOf(orderAddress)

      expect(finalBalance).to.be.closeTo(parseEther('300'), EXTREME_REBASE_TOLERANCE)

      const [currentHash] = await order.getOrderDetails()
      expect(await order.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
    })
  })

  describe('Rebase timing edge cases', function () {
    let testSnapshot: SnapshotRestorer

    beforeEach(async function () {
      testSnapshot = await takeSnapshot()
    })

    afterEach(async function () {
      await testSnapshot.restore()
    })

    it('should handle rebase immediately after order placement', async function () {
      await placeOrder(parseEther('1000'))

      const rebaseAmount = parseEther('100')
      await simulateRebase(tokenFrom, orderAddress, rebaseAmount, true)

      const [currentHash] = await order.getOrderDetails()
      expect(await order.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
    })

    it('should handle rebase at order expiration', async function () {
      await placeOrder(parseEther('1000'))

      const orderDuration = await stonks.ORDER_DURATION_IN_SECONDS()
      await time.increase(orderDuration - 10n)

      const rebaseAmount = parseEther('50')
      await simulateRebase(tokenFrom, orderAddress, rebaseAmount, true)

      await time.increase(15n)

      const [currentHash] = await order.getOrderDetails()
      await expect(order.isValidSignature(currentHash, '0x')).to.be.revertedWithCustomError(
        order,
        'OrderExpired'
      )
    })

    it('should handle multiple rebases in rapid succession', async function () {
      await placeOrder(parseEther('1000'))

      for (let i = 0; i < 10; i++) {
        const rebaseAmount = parseEther('10')
        await simulateRebase(tokenFrom, orderAddress, rebaseAmount, i % 2 === 0)
      }

      const [currentHash] = await order.getOrderDetails()
      expect(await order.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
    })
  })

  describe('Rebase with recovery operations', function () {
    let testSnapshot: SnapshotRestorer

    beforeEach(async function () {
      testSnapshot = await takeSnapshot()
      await placeOrder(parseEther('1000'))
    })

    afterEach(async function () {
      await testSnapshot.restore()
    })

    it('should allow recovery after extreme positive rebase', async function () {
      const balanceBefore = await tokenFrom.balanceOf(orderAddress)

      await simulateRebase(tokenFrom, orderAddress, balanceBefore * 10n, true)

      const orderDuration = await stonks.ORDER_DURATION_IN_SECONDS()
      await time.increase(Number(orderDuration) + 1)

      const actualBalance = await tokenFrom.balanceOf(orderAddress)

      const stonksBalanceBefore = await tokenFrom.balanceOf(await stonks.getAddress())

      await order.recoverTokenFrom()

      const stonksBalanceAfter = await tokenFrom.balanceOf(await stonks.getAddress())

      expect(stonksBalanceAfter).to.be.closeTo(
        stonksBalanceBefore + actualBalance,
        parseEther('0.1')
      )
    })

    it('should allow recovery after extreme negative rebase', async function () {
      const balanceBefore = await tokenFrom.balanceOf(orderAddress)
      const rebaseAmount = (balanceBefore * 95n) / 100n
      await simulateRebase(tokenFrom, orderAddress, rebaseAmount, false)

      const orderDuration = await stonks.ORDER_DURATION_IN_SECONDS()
      await time.increase(Number(orderDuration) + 1)

      const actualBalance = await tokenFrom.balanceOf(orderAddress)

      const stonksBalanceBefore = await tokenFrom.balanceOf(await stonks.getAddress())
      await order.recoverTokenFrom()
      const stonksBalanceAfter = await tokenFrom.balanceOf(await stonks.getAddress())

      expect(stonksBalanceAfter).to.be.closeTo(
        stonksBalanceBefore + actualBalance,
        parseEther('0.01')
      )
    })
  })
})
