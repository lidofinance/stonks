import { ethers } from 'hardhat'
import { expect } from 'chai'
import { parseEther, Signer } from 'ethers'
import { setBalance, impersonateAccount, takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import { setup, TokenPair } from './setup'
import { getContracts } from '../../utils/contracts'
import { IERC20, Stonks, Order } from '../../typechain-types'
import { MAGIC_VALUE } from '../../utils/gpv2-helpers'
import { getPlaceOrderData } from '../../utils/get-events'
import { simulateRebase, simulatePartialFill, REBASE_TOLERANCE, MULTI_REBASE_TOLERANCE } from '../helpers/rebase-helpers'

const contracts = getContracts()

const stethLdoPair: TokenPair = {
  tokenFrom: contracts.STETH,
  tokenTo: contracts.LDO,
  name: 'stETH->LDO Partial Fill + Rebase',
  priceFeedHeartbeatTimeout: 86400,
  useEthBridge: true,
  allowPartialFill: true,
}


describe('Partial fills with rebasable tokens', function () {
  let snapshot: SnapshotRestorer
  let value: bigint
  let stonks: Stonks
  let manager: Signer
  let tokenFrom: IERC20
  let tokenTo: IERC20
  let order: Order
  let orderAddress: string

  this.beforeAll(async () => {
    snapshot = await takeSnapshot()

    const result = await setup(stethLdoPair)
    stonks = result.stonks
    value = result.value
    manager = result.manager

    tokenFrom = await ethers.getContractAt('IERC20', await stonks.TOKEN_FROM())
    tokenTo = await ethers.getContractAt('IERC20', await stonks.TOKEN_TO())

    await setBalance(await manager.getAddress(), parseEther('100'))
    await setBalance(contracts.AGENT, parseEther('100'))

    expect(await stonks.ALLOW_PARTIAL_FILL()).to.equal(true)
  })

  this.afterAll(async () => {
    await snapshot.restore()
  })

  context('Positive rebase after partial fill', () => {
    let testSnapshot: SnapshotRestorer
    let initialSellAmount: bigint
    let initialBuyAmount: bigint

    beforeEach(async () => {
      testSnapshot = await takeSnapshot()

      const fundAmount = parseEther('1000')
      const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
      await impersonateAccount(contracts.AGENT)
      await tokenFrom.connect(treasurySigner).transfer(await stonks.getAddress(), fundAmount)

      const estimatedBuyAmount = await stonks.estimateTradeOutputFromCurrentBalance()
      const tx = await stonks.connect(manager).placeOrder(estimatedBuyAmount)
      const receipt = await tx.wait()
      if (!receipt) throw new Error('No receipt')

      const orderData = await getPlaceOrderData(receipt)
      order = await ethers.getContractAt('Order', orderData.address)
      orderAddress = orderData.address

      const [, , , sellAmount, buyAmount] = await order.getOrderDetails()
      initialSellAmount = sellAmount
      initialBuyAmount = buyAmount

      const [currentHash] = await order.getOrderDetails()
      expect(await order.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
    })

    afterEach(async () => {
      await testSnapshot.restore()
    })

    it('should enforce price tolerance after 50% fill + 5 stETH positive rebase', async () => {
      const { soldAmount, remainingBalance: balanceAfterFill } = await simulatePartialFill(
        tokenFrom,
        orderAddress,
        50
      )

      expect(soldAmount).to.be.closeTo(initialSellAmount / 2n, REBASE_TOLERANCE)
      expect(balanceAfterFill).to.be.closeTo(initialSellAmount / 2n, REBASE_TOLERANCE)

      const rebaseAmount = parseEther('5')
      const { balanceAfter: balanceAfterRebase } = await simulateRebase(
        tokenFrom,
        orderAddress,
        rebaseAmount,
        true
      )

      const expectedBalance = balanceAfterFill + rebaseAmount
      expect(balanceAfterRebase).to.be.closeTo(expectedBalance, REBASE_TOLERANCE)

      const [currentHash] = await order.getOrderDetails()
      expect(await order.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)

      const [, , , sellAmount, buyAmount] = await order.getOrderDetails()
      expect(sellAmount).to.equal(initialSellAmount)
      expect(buyAmount).to.equal(initialBuyAmount)
    })

    it('should maintain correct minBuyAmount calculation after positive rebase', async () => {
      await simulatePartialFill(tokenFrom, orderAddress, 50)

      const rebaseAmount = parseEther('5')
      await simulateRebase(tokenFrom, orderAddress, rebaseAmount, true)

      const [, , , sellAmount, buyAmount] = await order.getOrderDetails()

      expect(sellAmount).to.equal(initialSellAmount)

      expect(buyAmount).to.equal(initialBuyAmount)

    })
  })

  context('Negative rebase after partial fill', () => {
    let testSnapshot: SnapshotRestorer
    let initialSellAmount: bigint
    let initialBuyAmount: bigint

    beforeEach(async () => {
      testSnapshot = await takeSnapshot()

      const fundAmount = parseEther('1000')
      const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
      await impersonateAccount(contracts.AGENT)
      await tokenFrom.connect(treasurySigner).transfer(await stonks.getAddress(), fundAmount)

      const estimatedBuyAmount = await stonks.estimateTradeOutputFromCurrentBalance()
      const tx = await stonks.connect(manager).placeOrder(estimatedBuyAmount)
      const receipt = await tx.wait()
      if (!receipt) throw new Error('No receipt')

      const orderData = await getPlaceOrderData(receipt)
      order = await ethers.getContractAt('Order', orderData.address)
      orderAddress = orderData.address

      const [, , , sellAmount, buyAmount] = await order.getOrderDetails()
      initialSellAmount = sellAmount
      initialBuyAmount = buyAmount
    })

    afterEach(async () => {
      await testSnapshot.restore()
    })

    it('should enforce price tolerance after 50% fill + 5 stETH negative rebase', async () => {
      const { remainingBalance: balanceAfterFill } = await simulatePartialFill(
        tokenFrom,
        orderAddress,
        50
      )

      const rebaseAmount = parseEther('5')
      const { balanceAfter: balanceAfterRebase } = await simulateRebase(
        tokenFrom,
        orderAddress,
        rebaseAmount,
        false
      )

      const expectedBalance = balanceAfterFill - rebaseAmount
      expect(balanceAfterRebase).to.be.closeTo(expectedBalance, REBASE_TOLERANCE)

      const [currentHash] = await order.getOrderDetails()
      expect(await order.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)

      const [, , , sellAmount, buyAmount] = await order.getOrderDetails()
      expect(sellAmount).to.equal(initialSellAmount)
      expect(buyAmount).to.equal(initialBuyAmount)
    })

    it('should handle negative rebase gracefully with partial fills enabled', async () => {
      const { remainingBalance: balanceAfterFill } = await simulatePartialFill(
        tokenFrom,
        orderAddress,
        50
      )

      const rebaseAmount = parseEther('5')
      const { balanceAfter: balanceAfterRebase } = await simulateRebase(
        tokenFrom,
        orderAddress,
        rebaseAmount,
        false
      )

      const [currentHash] = await order.getOrderDetails()
      expect(await order.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)

      const expectedBalanceAfterRebase = balanceAfterFill - rebaseAmount
      expect(balanceAfterRebase).to.be.closeTo(expectedBalanceAfterRebase, REBASE_TOLERANCE)
    })
  })

  context('Multiple partial fills with intermittent rebases', () => {
    let testSnapshot: SnapshotRestorer

    beforeEach(async () => {
      testSnapshot = await takeSnapshot()

      const fundAmount = parseEther('1000')
      const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
      await impersonateAccount(contracts.AGENT)
      await tokenFrom.connect(treasurySigner).transfer(await stonks.getAddress(), fundAmount)

      const estimatedBuyAmount = await stonks.estimateTradeOutputFromCurrentBalance()
      const tx = await stonks.connect(manager).placeOrder(estimatedBuyAmount)
      const receipt = await tx.wait()
      if (!receipt) throw new Error('No receipt')

      const orderData = await getPlaceOrderData(receipt)
      order = await ethers.getContractAt('Order', orderData.address)
      orderAddress = orderData.address
    })

    afterEach(async () => {
      await testSnapshot.restore()
    })

    it('should handle: fill 30% → rebase +2% → fill 20% → rebase -1%', async () => {
      const initialBalance = await tokenFrom.balanceOf(orderAddress)

      const { remainingBalance: balance1 } = await simulatePartialFill(tokenFrom, orderAddress, 30)
      expect(balance1).to.be.closeTo((initialBalance * 70n) / 100n, REBASE_TOLERANCE)

      const rebase1 = (balance1 * 2n) / 100n
      const { balanceAfter: balance2 } = await simulateRebase(tokenFrom, orderAddress, rebase1, true)
      expect(balance2).to.be.closeTo(balance1 + rebase1, REBASE_TOLERANCE)

      let [currentHash] = await order.getOrderDetails()
      expect(await order.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)

      const { remainingBalance: balance3 } = await simulatePartialFill(tokenFrom, orderAddress, 20)
      expect(balance3).to.be.closeTo((balance2 * 80n) / 100n, REBASE_TOLERANCE)

      const rebase2 = (balance3 * 1n) / 100n
      const { balanceAfter: balance4 } = await simulateRebase(
        tokenFrom,
        orderAddress,
        rebase2,
        false
      )
      expect(balance4).to.be.closeTo(balance3 - rebase2, REBASE_TOLERANCE)

      ;[currentHash] = await order.getOrderDetails()
      expect(await order.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)

      const expectedFinal =
        (((((initialBalance * 70n) / 100n) * 102n) / 100n) * 80n * 99n) / 10000n
      expect(balance4).to.be.closeTo(expectedFinal, MULTI_REBASE_TOLERANCE)
    })
  })
})

