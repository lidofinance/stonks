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
import { placeOrderFromAgent } from '../helpers/order-helpers'
import { MAGIC_VALUE } from '../../utils/gpv2-helpers'
import { simulateRebase, simulatePartialFill, REBASE_TOLERANCE } from '../helpers/rebase-helpers'

const contracts = getContracts()

describe('Emergency scenarios', () => {
  let snapshot: SnapshotRestorer
  let stonks: Stonks
  let manager: Signer
  let tokenFrom: IERC20
  let admin: Signer
  let emergencyOperator: Signer

  const pair: TokenPair = {
    tokenFrom: contracts.STETH,
    tokenTo: contracts.LDO,
    priceFeedHeartbeatTimeout: 86400 * 7,
    useEthBridge: true,
    allowPartialFill: true,
  }

  before(async () => {
    snapshot = await takeSnapshot()

    const result = await setup(pair)
    stonks = result.stonks
    manager = result.manager

    tokenFrom = await ethers.getContractAt('IERC20', await stonks.TOKEN_FROM())

    admin = await ethers.getImpersonatedSigner(contracts.ADMIN)
    await setBalance(contracts.ADMIN, parseEther('100'))

    const [, , emergencySigner] = await ethers.getSigners()
    emergencyOperator = emergencySigner
    await stonks.connect(admin).setEmergencyOperator(await emergencyOperator.getAddress())

    await setBalance(await manager.getAddress(), parseEther('100'))
    await setBalance(contracts.AGENT, parseEther('100'))
  })

  after(async () => {
    await snapshot.restore()
  })

  async function placeOrder(fundAmount: bigint): Promise<Order> {
    return placeOrderFromAgent(stonks, manager, tokenFrom, fundAmount)
  }

  describe('Emergency pause during partial fill', () => {
    let testSnapshot: SnapshotRestorer

    beforeEach(async () => {
      testSnapshot = await takeSnapshot()
    })

    afterEach(async () => {
      await testSnapshot.restore()
    })

    it('should pause creation and prevent new orders', async () => {
      const order = await placeOrder(parseEther('1000'))

      await simulatePartialFill(tokenFrom, await order.getAddress(), 50)

      await stonks.connect(emergencyOperator).pauseCreation()

      const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
      await impersonateAccount(contracts.AGENT)
      await tokenFrom.connect(treasurySigner).transfer(await stonks.getAddress(), parseEther('100'))

      await expect(stonks.connect(manager).placeOrder(parseEther('1'))).to.be.revertedWith(
        'Pausable: paused'
      )
    })

    it('should allow existing order to remain valid during creation pause', async () => {
      const order = await placeOrder(parseEther('1000'))

      await stonks.connect(admin).pauseCreation()

      const [hash] = await order.getOrderDetails()
      expect(await order.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)

      await simulatePartialFill(tokenFrom, await order.getAddress(), 30)

      expect(await order.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)
    })

    it('should unpause and allow new orders again', async () => {
      await stonks.connect(admin).pauseCreation()

      const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
      await impersonateAccount(contracts.AGENT)
      await tokenFrom.connect(treasurySigner).transfer(await stonks.getAddress(), parseEther('100'))

      await expect(stonks.connect(manager).placeOrder(parseEther('1'))).to.be.revertedWith(
        'Pausable: paused'
      )

      await stonks.connect(admin).unpauseCreation()

      const order = await placeOrder(parseEther('100'))
      const [hash] = await order.getOrderDetails()
      expect(await order.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)
    })
  })

  describe('Emergency signature pause', () => {
    let testSnapshot: SnapshotRestorer

    beforeEach(async () => {
      testSnapshot = await takeSnapshot()
    })

    afterEach(async () => {
      await testSnapshot.restore()
    })

    it('should pause signatures and invalidate existing order', async () => {
      const order = await placeOrder(parseEther('1000'))

      const [hash] = await order.getOrderDetails()
      expect(await order.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)

      await stonks.connect(emergencyOperator).pauseSignatures()

      await expect(order.isValidSignature(hash, '0x')).to.be.revertedWithCustomError(
        order,
        'SignaturesGloballyPaused'
      )
    })

    it('should maintain pause after partial fill', async () => {
      const order = await placeOrder(parseEther('1000'))

      await simulatePartialFill(tokenFrom, await order.getAddress(), 40)

      await stonks.connect(admin).pauseSignatures()

      const [hash] = await order.getOrderDetails()
      await expect(order.isValidSignature(hash, '0x')).to.be.revertedWithCustomError(
        order,
        'SignaturesGloballyPaused'
      )
    })

    it('should unpause signatures and restore order validity', async () => {
      const order = await placeOrder(parseEther('1000'))

      await stonks.connect(admin).pauseSignatures()

      const [hash] = await order.getOrderDetails()
      await expect(order.isValidSignature(hash, '0x')).to.be.revertedWithCustomError(
        order,
        'SignaturesGloballyPaused'
      )

      await stonks.connect(admin).unpauseSignatures()

      expect(await order.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)
    })
  })

  describe('Kill switch scenarios', () => {
    let testSnapshot: SnapshotRestorer

    beforeEach(async () => {
      testSnapshot = await takeSnapshot()
    })

    afterEach(async () => {
      await testSnapshot.restore()
    })

    it('should activate kill switch and prevent all operations', async () => {
      const order = await placeOrder(parseEther('1000'))

      await stonks.connect(emergencyOperator).killSwitch()

      await expect(stonks.connect(manager).placeOrder(parseEther('1'))).to.be.reverted

      const [hash] = await order.getOrderDetails()
      await expect(order.isValidSignature(hash, '0x')).to.be.reverted
    })

    it('should handle kill switch after partial fill with rebase', async () => {
      const order = await placeOrder(parseEther('1000'))

      await simulatePartialFill(tokenFrom, await order.getAddress(), 60)

      const rebaseAmount = parseEther('50')
      await simulateRebase(tokenFrom, await order.getAddress(), rebaseAmount, true)

      await stonks.connect(admin).killSwitch()

      const [hash] = await order.getOrderDetails()
      await expect(order.isValidSignature(hash, '0x')).to.be.revertedWithCustomError(
        order,
        'SignaturesGloballyPaused'
      )
    })

    it('should allow recovery operations after kill switch', async () => {
      const order = await placeOrder(parseEther('1000'))

      await stonks.connect(emergencyOperator).killSwitch()

      const orderDuration = await stonks.ORDER_DURATION_IN_SECONDS()
      await time.increase(Number(orderDuration) + 1)

      await setBalance(contracts.ADMIN, parseEther('1'))

      const agentBalanceBefore = await tokenFrom.balanceOf(await stonks.getAddress())
      await order.connect(admin).recoverTokenFrom()
      const stonksBalanceAfter = await tokenFrom.balanceOf(await stonks.getAddress())

      expect(stonksBalanceAfter).to.be.closeTo(
        agentBalanceBefore + parseEther('1000'),
        REBASE_TOLERANCE
      )
    })
  })

  describe('Emergency cancel and return', () => {
    it('should emergency cancel active order and return funds', async () => {
      const order = await placeOrder(parseEther('1000'))

      await order.connect(admin).setEmergencyOperator(await emergencyOperator.getAddress())

      const stonksBalanceBefore = await tokenFrom.balanceOf(await stonks.getAddress())

      await order.connect(emergencyOperator).emergencyCancelAndReturn()

      expect(await order.cancelled()).to.be.true

      const stonksBalanceAfter = await tokenFrom.balanceOf(await stonks.getAddress())

      const balanceIncrease = stonksBalanceAfter - stonksBalanceBefore
      expect(balanceIncrease).to.be.closeTo(parseEther('1000'), REBASE_TOLERANCE)

      const [hash] = await order.getOrderDetails()
      await expect(order.isValidSignature(hash, '0x')).to.be.revertedWithCustomError(
        order,
        'OrderIsCancelled'
      )
    })

    it('should emergency cancel after partial fill and return remaining', async () => {
      const order = await placeOrder(parseEther('1000'))

      await order.connect(admin).setEmergencyOperator(await emergencyOperator.getAddress())

      await simulatePartialFill(tokenFrom, await order.getAddress(), 70)

      const remainingBalance = await tokenFrom.balanceOf(await order.getAddress())

      const stonksBalanceBefore = await tokenFrom.balanceOf(await stonks.getAddress())
      await order.connect(emergencyOperator).emergencyCancelAndReturn()

      expect(await order.cancelled()).to.be.true

      const stonksBalanceAfter = await tokenFrom.balanceOf(await stonks.getAddress())

      const balanceIncrease = stonksBalanceAfter - stonksBalanceBefore
      expect(balanceIncrease).to.be.closeTo(remainingBalance, REBASE_TOLERANCE)
    })

    it('should handle emergency cancel after rebase', async () => {
      const order = await placeOrder(parseEther('1000'))

      await order.connect(admin).setEmergencyOperator(await emergencyOperator.getAddress())

      const rebaseAmount = parseEther('200')
      await simulateRebase(tokenFrom, await order.getAddress(), rebaseAmount, true)

      const orderBalance = await tokenFrom.balanceOf(await order.getAddress())

      const stonksBalanceBefore = await tokenFrom.balanceOf(await stonks.getAddress())
      await order.connect(emergencyOperator).emergencyCancelAndReturn()

      expect(await order.cancelled()).to.be.true

      const stonksBalanceAfter = await tokenFrom.balanceOf(await stonks.getAddress())

      const balanceIncrease = stonksBalanceAfter - stonksBalanceBefore
      expect(balanceIncrease).to.be.closeTo(orderBalance, REBASE_TOLERANCE)
    })
  })

  describe('Emergency operator change during operations', () => {
    let testSnapshot: SnapshotRestorer

    beforeEach(async () => {
      testSnapshot = await takeSnapshot()
    })

    afterEach(async () => {
      await testSnapshot.restore()
    })

    it('should change emergency operator and new operator can pause', async () => {
      await placeOrder(parseEther('1000'))

      const [, , , newEmergencySigner] = await ethers.getSigners()

      await stonks.connect(admin).setEmergencyOperator(await newEmergencySigner.getAddress())

      await expect(stonks.connect(emergencyOperator).pauseCreation()).to.be.revertedWithCustomError(
        stonks,
        'NotEmergencyOperator'
      )

      await stonks.connect(newEmergencySigner).pauseCreation()

      expect(await stonks.isCreationPaused()).to.be.true
    })

    it('should maintain order validity during emergency operator change', async () => {
      const order = await placeOrder(parseEther('1000'))

      const [, , , newEmergencySigner] = await ethers.getSigners()

      await stonks.connect(admin).setEmergencyOperator(await newEmergencySigner.getAddress())

      const [hash] = await order.getOrderDetails()
      expect(await order.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)
    })
  })

  describe('Manager change during active order', () => {
    let testSnapshot: SnapshotRestorer

    beforeEach(async () => {
      testSnapshot = await takeSnapshot()
    })

    afterEach(async () => {
      await testSnapshot.restore()
    })

    it('should change manager and new manager cannot place orders for old Stonks', async () => {
      await placeOrder(parseEther('1000'))

      const [, , , newManagerSigner] = await ethers.getSigners()

      await stonks.connect(admin).setManager(await newManagerSigner.getAddress())

      await expect(
        stonks.connect(manager).placeOrder(parseEther('1'))
      ).to.be.revertedWithCustomError(stonks, 'NotAdminOrManager')

      const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
      await impersonateAccount(contracts.AGENT)
      await tokenFrom.connect(treasurySigner).transfer(await stonks.getAddress(), parseEther('100'))

      await stonks.connect(newManagerSigner).placeOrder(parseEther('1'))
    })

    it('should maintain existing order validity during manager change', async () => {
      const order = await placeOrder(parseEther('1000'))

      const [, , , newManagerSigner] = await ethers.getSigners()
      await stonks.connect(admin).setManager(await newManagerSigner.getAddress())

      const [hash] = await order.getOrderDetails()
      expect(await order.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)

      await simulatePartialFill(tokenFrom, await order.getAddress(), 30)

      expect(await order.isValidSignature(hash, '0x')).to.equal(MAGIC_VALUE)
    })
  })

  describe('Emergency revoke relayer', () => {
    let testSnapshot: SnapshotRestorer

    beforeEach(async () => {
      testSnapshot = await takeSnapshot()
    })

    afterEach(async () => {
      await testSnapshot.restore()
    })

    it('should revoke relayer approval in emergency', async () => {
      const order = await placeOrder(parseEther('1000'))

      await order.connect(admin).setEmergencyOperator(await emergencyOperator.getAddress())

      const relayerAddress = contracts.VAULT_RELAYER

      const allowanceBefore = await tokenFrom.allowance(await order.getAddress(), relayerAddress)
      expect(allowanceBefore).to.be.greaterThan(0n)

      await order.connect(emergencyOperator).emergencyRevokeRelayer()

      const allowanceAfter = await tokenFrom.allowance(await order.getAddress(), relayerAddress)
      expect(allowanceAfter).to.equal(0n)
    })

    it('should revoke relayer after partial fill', async () => {
      const order = await placeOrder(parseEther('1000'))

      await order.connect(admin).setEmergencyOperator(await emergencyOperator.getAddress())

      await simulatePartialFill(tokenFrom, await order.getAddress(), 50)

      await order.connect(emergencyOperator).emergencyRevokeRelayer()

      const allowance = await tokenFrom.allowance(await order.getAddress(), contracts.VAULT_RELAYER)
      expect(allowance).to.equal(0n)
    })
  })
})
