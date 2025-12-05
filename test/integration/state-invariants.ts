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
import { simulateRebase, simulatePartialFill } from '../helpers/rebase-helpers'

const contracts = getContracts()

describe('State invariants', function () {
  let snapshot: SnapshotRestorer
  let stonks: Stonks
  let manager: Signer
  let tokenFrom: IERC20
  let tokenTo: IERC20

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
    tokenTo = await ethers.getContractAt('IERC20', await stonks.TOKEN_TO())

    await setBalance(await manager.getAddress(), parseEther('100'))
    await setBalance(contracts.AGENT, parseEther('100'))
  })

  after(async function () {
    await snapshot.restore()
  })

  const placeOrder = async (fundAmount: bigint): Promise<Order> => {
    return placeOrderFromAgent(stonks, manager, tokenFrom, fundAmount)
  }

  describe('Immutable state invariants', function () {
    it('should maintain AGENT as immutable recipient across operations', async function () {
      const order = await placeOrder(parseEther('1000'))

      const agentFromOrder = await order.AGENT()
      expect(agentFromOrder).to.equal(contracts.AGENT)

      await simulatePartialFill(tokenFrom, await order.getAddress(), 50)

      expect(await order.AGENT()).to.equal(contracts.AGENT)

      await simulateRebase(tokenFrom, await order.getAddress(), parseEther('100'), true)

      expect(await order.AGENT()).to.equal(contracts.AGENT)
    })

    it('should maintain ADMIN immutability', async function () {
      const adminFromStonks = await stonks.ADMIN()
      expect(adminFromStonks).to.equal(contracts.ADMIN)

      const order = await placeOrder(parseEther('1000'))
      const adminFromOrder = await order.ADMIN()
      expect(adminFromOrder).to.equal(contracts.ADMIN)

      await simulatePartialFill(tokenFrom, await order.getAddress(), 30)

      expect(await order.ADMIN()).to.equal(contracts.ADMIN)
      expect(await stonks.ADMIN()).to.equal(contracts.ADMIN)
    })

    it('should maintain TOKEN_FROM and TOKEN_TO immutability', async function () {
      const tokenFromAddress = await stonks.TOKEN_FROM()
      const tokenToAddress = await stonks.TOKEN_TO()

      const order = await placeOrder(parseEther('1000'))

      const orderTokenFrom = await tokenFrom.getAddress()
      const orderTokenTo = await tokenTo.getAddress()

      expect(orderTokenFrom).to.equal(tokenFromAddress)
      expect(orderTokenTo).to.equal(tokenToAddress)

      await simulateRebase(tokenFrom, await order.getAddress(), parseEther('50'), false)

      expect(orderTokenFrom).to.equal(tokenFromAddress)
      expect(orderTokenTo).to.equal(tokenToAddress)
    })

    it('should maintain ALLOW_PARTIAL_FILL immutability', async function () {
      expect(await stonks.ALLOW_PARTIAL_FILL()).to.equal(true)

      const order = await placeOrder(parseEther('1000'))

      await simulatePartialFill(tokenFrom, await order.getAddress(), 70)

      expect(await stonks.ALLOW_PARTIAL_FILL()).to.equal(true)
    })

    it('should maintain order parameters immutability', async function () {
      const order = await placeOrder(parseEther('1000'))

      const [, , , initialSellAmount, initialBuyAmount, initialValidTo] =
        await order.getOrderDetails()

      await simulatePartialFill(tokenFrom, await order.getAddress(), 50)

      const [, , , sellAmount, buyAmount, validTo] = await order.getOrderDetails()

      expect(sellAmount).to.equal(initialSellAmount)
      expect(buyAmount).to.equal(initialBuyAmount)
      expect(validTo).to.equal(initialValidTo)

      await simulateRebase(tokenFrom, await order.getAddress(), parseEther('100'), true)

      const [, , , sellAmount2, buyAmount2, validTo2] = await order.getOrderDetails()

      expect(sellAmount2).to.equal(initialSellAmount)
      expect(buyAmount2).to.equal(initialBuyAmount)
      expect(validTo2).to.equal(initialValidTo)
    })
  })

  describe('Price tolerance invariants', function () {
    it('should never allow order when buyAmount < minAcceptable', async function () {
      const order = await placeOrder(parseEther('1000'))

      const [, , , , buyAmount] = await order.getOrderDetails()

      const priceToleranceBps = await stonks.PRICE_TOLERANCE_IN_BASIS_POINTS()
      const minAcceptableBuyAmount = buyAmount - (buyAmount * priceToleranceBps) / 10000n

      const currentBalance = await tokenFrom.balanceOf(await order.getAddress())
      const converterAddress = await stonks.AMOUNT_CONVERTER()
      const converter = await ethers.getContractAt('AmountConverter', converterAddress)
      const estimatedBuy = await converter.getExpectedOut(
        await stonks.TOKEN_FROM(),
        await stonks.TOKEN_TO(),
        currentBalance
      )

      expect(estimatedBuy).to.be.greaterThanOrEqual(minAcceptableBuyAmount)
    })

    it('should maintain price tolerance across partial fills', async function () {
      const order = await placeOrder(parseEther('1000'))

      for (let i = 0; i < 5; i++) {
        await simulatePartialFill(tokenFrom, await order.getAddress(), 10)

        const [hash] = await order.getOrderDetails()
        expect(await order.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)
      }
    })

    it('should maintain price tolerance across rebases', async function () {
      const order = await placeOrder(parseEther('1000'))

      for (let i = 0; i < 10; i++) {
        const rebaseAmount = parseEther('10')
        await simulateRebase(tokenFrom, await order.getAddress(), rebaseAmount, i % 2 === 0)

        const [hash] = await order.getOrderDetails()
        expect(await order.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)
      }
    })
  })

  describe('Partial fill invariants', function () {
    let testSnapshot: SnapshotRestorer

    beforeEach(async function () {
      testSnapshot = await takeSnapshot()
    })

    afterEach(async function () {
      await testSnapshot.restore()
    })

    it('should never revert on partial fill when ALLOW_PARTIAL_FILL = true', async function () {
      expect(await stonks.ALLOW_PARTIAL_FILL()).to.equal(true)

      const order = await placeOrder(parseEther('1000'))

      for (let i = 10; i <= 90; i += 10) {
        const { remainingBalance } = await simulatePartialFill(
          tokenFrom,
          await order.getAddress(),
          10
        )

        expect(remainingBalance).to.be.greaterThan(0n)

        const [hash] = await order.getOrderDetails()
        expect(await order.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)
      }
    })

    it('should always allow recovery when balance > 0', async function () {
      const order = await placeOrder(parseEther('1000'))

      await simulatePartialFill(tokenFrom, await order.getAddress(), 95)

      const remainingBalance = await tokenFrom.balanceOf(await order.getAddress())
      expect(remainingBalance).to.be.greaterThan(0n)

      const orderDuration = await stonks.ORDER_DURATION_IN_SECONDS()
      await time.increase(Number(orderDuration) + 1)

      const actualBalance = await tokenFrom.balanceOf(await order.getAddress())

      const stonksBalanceBefore = await tokenFrom.balanceOf(await stonks.getAddress())

      await order.recoverTokenFrom()

      const stonksBalanceAfter = await tokenFrom.balanceOf(await stonks.getAddress())

      expect(stonksBalanceAfter).to.be.closeTo(
        stonksBalanceBefore + actualBalance,
        parseEther('0.01')
      )
    })
  })

  describe('Access control invariants', function () {
    let testSnapshot: SnapshotRestorer

    beforeEach(async function () {
      testSnapshot = await takeSnapshot()
    })

    afterEach(async function () {
      await testSnapshot.restore()
    })

    it('should never allow non-admin/manager to call admin functions', async function () {
      const [, , stranger] = await ethers.getSigners()

      await expect(
        stonks.connect(stranger).setManager(await stranger.getAddress())
      ).to.be.revertedWithCustomError(stonks, 'NotAdmin')

      await expect(
        stonks.connect(stranger).setEmergencyOperator(await stranger.getAddress())
      ).to.be.revertedWithCustomError(stonks, 'NotAdmin')

      await expect(stonks.connect(stranger).pauseCreation()).to.be.revertedWithCustomError(
        stonks,
        'NotEmergencyOperator'
      )
    })

    it('should never allow AGENT to call operational functions', async function () {
      const agentSigner = await ethers.getImpersonatedSigner(contracts.AGENT)
      await setBalance(contracts.AGENT, parseEther('1'))

      await expect(
        stonks.connect(agentSigner).placeOrder(parseEther('1'))
      ).to.be.revertedWithCustomError(stonks, 'NotAdminOrManager')

      await expect(stonks.connect(agentSigner).pauseCreation()).to.be.revertedWithCustomError(
        stonks,
        'NotEmergencyOperator'
      )
    })

    it('should maintain emergency operator permissions', async function () {
      const order = await placeOrder(parseEther('1000'))

      const emergencyOperatorAddress = await stonks.emergencyOperator()

      const emergencyOperator = await ethers.getImpersonatedSigner(emergencyOperatorAddress)
      await setBalance(emergencyOperatorAddress, parseEther('1'))

      await stonks.connect(emergencyOperator).pauseCreation()
      expect(await stonks.isCreationPaused()).to.be.true

      await order.connect(emergencyOperator).emergencyCancelAndReturn()

      const [hash] = await order.getOrderDetails()
      await expect(order.isValidSignature(hash, '0x')).to.be.revertedWithCustomError(
        order,
        'OrderCancelled'
      )
    })
  })

  describe('Fund flow invariants', function () {
    let testSnapshot: SnapshotRestorer

    beforeEach(async function () {
      testSnapshot = await takeSnapshot()
    })

    afterEach(async function () {
      await testSnapshot.restore()
    })

    it('should always send recovered funds to AGENT', async function () {
      const order = await placeOrder(parseEther('1000'))

      const adminSigner = await ethers.getImpersonatedSigner(contracts.ADMIN)
      await setBalance(contracts.ADMIN, parseEther('1'))

      await order.connect(adminSigner).setEmergencyOperator(await adminSigner.getAddress())

      const stonksBalanceBefore = await tokenFrom.balanceOf(await stonks.getAddress())
      const orderBalance = await tokenFrom.balanceOf(await order.getAddress())

      await order.connect(adminSigner).emergencyCancelAndReturn()

      const stonksBalanceAfter = await tokenFrom.balanceOf(await stonks.getAddress())

      expect(stonksBalanceAfter).to.be.closeTo(
        stonksBalanceBefore + orderBalance,
        parseEther('0.01')
      )
    })

    it('should never lose tokens during partial fills + rebases', async function () {
      const order = await placeOrder(parseEther('1000'))
      const orderAddress = await order.getAddress()

      let totalAccountedTokens = parseEther('1000')

      for (let i = 0; i < 5; i++) {
        const balanceBefore = await tokenFrom.balanceOf(orderAddress)

        if (i % 2 === 0) {
          await simulatePartialFill(tokenFrom, orderAddress, 10)
          const balanceAfter = await tokenFrom.balanceOf(orderAddress)
          const filled = balanceBefore - balanceAfter
          totalAccountedTokens -= filled
        } else {
          const rebaseAmount = balanceBefore / 10n
          await simulateRebase(tokenFrom, orderAddress, rebaseAmount, true)
          totalAccountedTokens += rebaseAmount
        }
      }

      const finalBalance = await tokenFrom.balanceOf(orderAddress)
      expect(finalBalance).to.be.closeTo(totalAccountedTokens, parseEther('1'))
    })

    it('should maintain token conservation across operations', async function () {
      const fundAmount = parseEther('1000')

      const order = await placeOrder(fundAmount)

      const stonksBalance = await tokenFrom.balanceOf(await stonks.getAddress())
      const orderBalance = await tokenFrom.balanceOf(await order.getAddress())

      expect(stonksBalance + orderBalance).to.be.closeTo(fundAmount, parseEther('0.01'))

      const adminSigner = await ethers.getImpersonatedSigner(contracts.ADMIN)
      await setBalance(contracts.ADMIN, parseEther('1'))

      await order.connect(adminSigner).setEmergencyOperator(await adminSigner.getAddress())
      await order.connect(adminSigner).emergencyCancelAndReturn()

      const stonksBalanceAfter = await tokenFrom.balanceOf(await stonks.getAddress())

      expect(stonksBalanceAfter).to.be.closeTo(orderBalance, parseEther('0.01'))
    })
  })

  describe('Order state invariants', function () {
    let testSnapshot: SnapshotRestorer

    beforeEach(async function () {
      testSnapshot = await takeSnapshot()
    })

    afterEach(async function () {
      await testSnapshot.restore()
    })

    it('should never allow reuse of cancelled order', async function () {
      const order = await placeOrder(parseEther('1000'))

      const adminSigner = await ethers.getImpersonatedSigner(contracts.ADMIN)
      await setBalance(contracts.ADMIN, parseEther('1'))

      await order.connect(adminSigner).setEmergencyOperator(await adminSigner.getAddress())
      await order.connect(adminSigner).emergencyCancelAndReturn()

      const [hash] = await order.getOrderDetails()
      await expect(order.isValidSignature(hash, '0x')).to.be.revertedWithCustomError(
        order,
        'OrderCancelled'
      )

      await order.connect(adminSigner).emergencyCancelAndReturn()
    })

    it('should never allow signature validation when globally paused', async function () {
      const order = await placeOrder(parseEther('1000'))

      const adminSigner = await ethers.getImpersonatedSigner(contracts.ADMIN)
      await setBalance(contracts.ADMIN, parseEther('1'))

      await stonks.connect(adminSigner).pauseSignatures()

      const [hash] = await order.getOrderDetails()
      await expect(order.isValidSignature(hash, '0x')).to.be.revertedWithCustomError(
        order,
        'SignaturesGloballyPaused'
      )

      await simulatePartialFill(tokenFrom, await order.getAddress(), 20)

      await expect(order.isValidSignature(hash, '0x')).to.be.revertedWithCustomError(
        order,
        'SignaturesGloballyPaused'
      )

      await simulateRebase(tokenFrom, await order.getAddress(), parseEther('100'), true)

      await expect(order.isValidSignature(hash, '0x')).to.be.revertedWithCustomError(
        order,
        'SignaturesGloballyPaused'
      )
    })

    it('should maintain order hash immutability', async function () {
      const order = await placeOrder(parseEther('1000'))

      const [initialHash] = await order.getOrderDetails()

      await simulatePartialFill(tokenFrom, await order.getAddress(), 40)
      const [hashAfterFill] = await order.getOrderDetails()
      expect(hashAfterFill).to.equal(initialHash)

      await simulateRebase(tokenFrom, await order.getAddress(), parseEther('200'), true)
      const [hashAfterRebase] = await order.getOrderDetails()
      expect(hashAfterRebase).to.equal(initialHash)
    })
  })
})
