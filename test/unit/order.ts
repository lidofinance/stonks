import { ethers, network } from 'hardhat'
import { expect } from 'chai'
import { Signer } from 'ethers'
import { Order, Stonks, HashHelper, AmountConverterTest } from '../../typechain-types'
import { deployStonks } from '../../scripts/deployments/stonks'
import { mainnet } from '../../utils/contracts'
import { MAGIC_VALUE, formOrderHashFromTxReceipt } from '../../utils/gpv2-helpers'
import { fillUpERC20FromTreasury } from '../../utils/fill-up-balance'
import { getPlaceOrderData } from '../../utils/get-events'
import { isClose } from '../../utils/assert'
import { PlaceOrderDataEvent } from '../../utils/types'

const PRICE_TOLERANCE_IN_BP = 1000

describe('Order', async function () {
  const marginInBps = 500
  let manager: Signer
  let stonks: Stonks
  let hashHelper: HashHelper
  let amountConverterTest: AmountConverterTest
  let snapshotId: string
  let subject: Order
  let orderHash: string
  let orderData: PlaceOrderDataEvent
  let expectedBuyAmount: bigint

  this.beforeAll(async function () {
    snapshotId = await network.provider.send('evm_snapshot')
    manager = (await ethers.getSigners())[0]

    const amountConverterTestFactory = await ethers.getContractFactory('AmountConverterTest')
    amountConverterTest = await amountConverterTestFactory.deploy(
      mainnet.CHAINLINK_PRICE_FEED_REGISTRY,
      mainnet.CHAINLINK_USD_QUOTE,
      [mainnet.STETH],
      [mainnet.DAI],
      [3600]
    )
    await amountConverterTest.waitForDeployment()

    const { stonks: stonksInstance, amountConverter: amountConverterInstance } = await deployStonks(
      {
        factoryParams: {
          agent: mainnet.AGENT,
          relayer: mainnet.VAULT_RELAYER,
          settlement: mainnet.SETTLEMENT,
          priceFeedRegistry: mainnet.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: mainnet.STETH,
          tokenTo: mainnet.DAI,
          manager: await manager.getAddress(),
          marginInBps: marginInBps,
          orderDuration: 3600,
          priceToleranceInBps: PRICE_TOLERANCE_IN_BP,
          amountConverterAddress: await amountConverterTest.getAddress(),
        },
        amountConverterParams: {
          conversionTarget: mainnet.CHAINLINK_USD_QUOTE, // USD
          allowedTokensToSell: [mainnet.STETH],
          allowedStableTokensToBuy: [mainnet.DAI],
          priceFeedsHeartbeatTimeouts: [3600],
        },
      }
    )
    const HashHelperFactory = await ethers.getContractFactory('HashHelper')

    hashHelper = await HashHelperFactory.deploy()
    await hashHelper.waitForDeployment()

    stonks = stonksInstance

    await fillUpERC20FromTreasury({
      token: mainnet.STETH,
      amount: ethers.parseEther('1'),
      address: await stonks.getAddress(),
    })

    expectedBuyAmount = await stonks.estimateTradeOutputFromCurrentBalance()
    const placeOrderTx = await stonks.placeOrder(expectedBuyAmount)
    const placeOrderTxReceipt = await placeOrderTx.wait()

    if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

    const decodedOrderTx = await getPlaceOrderData(placeOrderTxReceipt)

    orderData = decodedOrderTx
    subject = await ethers.getContractAt('Order', orderData.address, manager)

    orderHash = await formOrderHashFromTxReceipt(
      placeOrderTxReceipt,
      stonks,
      expectedBuyAmount,
      BigInt(marginInBps)
    )
  })

  describe('initialization (direct):', function () {
    it('sample instance should be initialized by default', async () => {
      const subject = await ethers.getContractAt('Order', await stonks.ORDER_SAMPLE())
      await expect(
        subject.initialize(expectedBuyAmount, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(subject, 'OrderAlreadyInitialized')
    })
  })

  describe('initialization (from Stonks):', function () {
    it('should have correct order parameters', async () => {
      const [tokenFrom, tokenTo, orderDurationInSeconds] = await stonks.getOrderParameters()
      const token = await ethers.getContractAt('IERC20', tokenFrom)

      expect(await subject.stonks()).to.equal(await stonks.getAddress())
      expect(orderData.order.sellToken).to.equal(tokenFrom)
      expect(orderData.order.buyToken).to.equal(tokenTo)
      expect(orderData.order.sellAmount).to.equal(await token.balanceOf(subject))
      const buyAmountFromBalance = await stonks.estimateTradeOutputFromCurrentBalance()
      expect(orderData.order.buyAmount).to.equal(
        buyAmountFromBalance > expectedBuyAmount ? buyAmountFromBalance : expectedBuyAmount
      )
      expect(orderData.order.receiver).to.be.equal(mainnet.AGENT)
      expect(BigInt(orderData.order.feeAmount)).to.be.equal(BigInt(0))
      expect(BigInt(orderData.order.validTo)).to.be.equal(
        BigInt(orderData.timestamp) + orderDurationInSeconds
      )
    })
    it('should return correct params from getOrderDetails', async () => {
      const [tokenFromParam, tokenToParam, orderDurationInSeconds] =
        await stonks.getOrderParameters()
      const [orderHash, tokenFrom, tokenTo, sellAmount, buyAmount, validTo] =
        await subject.getOrderDetails()

      expect(orderHash).to.equal(orderData.hash)
      expect(tokenFrom).to.equal(tokenFromParam)
      expect(tokenTo).to.equal(tokenToParam)
      expect(sellAmount).to.equal(orderData.order.sellAmount)
      expect(buyAmount).to.equal(orderData.order.buyAmount)
      expect(validTo).to.equal(BigInt(orderData.timestamp) + BigInt(orderDurationInSeconds))
    })
  })

  describe('isValidSignature:', function () {
    let localSnapshotId: string

    this.beforeEach(async function () {
      localSnapshotId = await network.provider.send('evm_snapshot')
    })

    it('should return magic value if order hash is valid', async () => {
      expect(await subject.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)
    })
    it('should revert if order hash is invalid', async () => {
      await expect(subject.isValidSignature(ethers.ZeroHash, '0x')).to.be.revertedWithCustomError(
        subject,
        'InvalidOrderHash'
      )
    })
    it('should revert if order is expired', async () => {
      await network.provider.send('evm_increaseTime', [60 * 60 + 1])
      await network.provider.send('evm_mine')

      await expect(subject.isValidSignature(orderHash, '0x')).to.be.revertedWithCustomError(
        subject,
        'OrderExpired'
      )
    })
    it('should not revert if there was a price spike less than price tolerance allows', async () => {
      await amountConverterTest.multiplyAnswer(10000 + PRICE_TOLERANCE_IN_BP)
      expect(await subject.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)
    })
    it('should revert if there was a price spike', async () => {
      const orderDetails = await subject.getOrderDetails()
      const sellAmount = orderDetails[3]
      const buyAmount = orderDetails[4]
      const maxToleratedAmount = buyAmount + (buyAmount * BigInt(PRICE_TOLERANCE_IN_BP)) / 10000n

      await amountConverterTest.multiplyAnswer(10000 + PRICE_TOLERANCE_IN_BP + 1)
      await expect(subject.isValidSignature(orderHash, '0x'))
        .to.be.revertedWithCustomError(subject, 'PriceConditionChanged')
        .withArgs(maxToleratedAmount, await stonks.estimateTradeOutput(sellAmount))
    })

    this.afterEach(async function () {
      await network.provider.send('evm_revert', [localSnapshotId])
    })
  })

  describe('recoverTokenFrom:', function () {
    let localSnapshotId: string

    this.beforeEach(async function () {
      localSnapshotId = await network.provider.send('evm_snapshot')
    })
    it('should succesfully recover token from', async () => {
      const [tokenFrom] = await stonks.getOrderParameters()
      const subjectWithStranger = subject.connect((await ethers.getSigners())[4])

      await network.provider.send('evm_increaseTime', [60 * 60 + 1])

      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const stonksBalanceBefore = await token.balanceOf(await stonks.getAddress())
      const orderBalanceBefore = await token.balanceOf(await subjectWithStranger.getAddress())

      const cancelTx = await subjectWithStranger.recoverTokenFrom()
      await cancelTx.wait()

      const stonksBalanceAfter = await token.balanceOf(await stonks.getAddress())
      const orderBalanceAfter = await token.balanceOf(await subjectWithStranger.getAddress())

      expect(isClose(stonksBalanceBefore + orderBalanceBefore, stonksBalanceAfter, 1n)).to.be.true
      expect(isClose(orderBalanceAfter, BigInt(0), 1n)).to.be.true
    })
    it('should revert if order is not expired', async () => {
      const orderDetails = await subject.getOrderDetails()
      const block = await ethers.provider.getBlockNumber()
      const timestamp = (await ethers.provider.getBlock(block))?.timestamp!

      await expect(subject.recoverTokenFrom())
        .to.be.revertedWithCustomError(subject, 'OrderNotExpired')
        .withArgs(orderDetails[5], timestamp + 1)
    })
    it('should revert if nothing to recover', async () => {
      await network.provider.send('evm_increaseTime', [60 * 60 + 1])

      await subject.recoverTokenFrom()
      await expect(subject.recoverTokenFrom()).to.be.revertedWithCustomError(
        subject,
        'InvalidAmountToRecover'
      )
    })
    this.afterEach(async function () {
      await network.provider.send('evm_revert', [localSnapshotId])
    })
  })

  describe('recoverERC20:', async function () {
    it('should revert if recover a token from', async () => {
      const [tokenFrom] = await stonks.getOrderParameters()
      await expect(subject.recoverERC20(tokenFrom, BigInt(1)))
        .revertedWithCustomError(subject, 'CannotRecoverTokenFrom')
        .withArgs(tokenFrom)
    })
    it('should revert if called by stranger', async () => {
      const amount = ethers.parseEther('1')
      await fillUpERC20FromTreasury({
        token: mainnet.DAI,
        amount: amount,
        address: await subject.getAddress(),
      })
      const signer = (await ethers.getSigners())[4]
      const localSubject = subject.connect(signer)
      await expect(localSubject.recoverERC20(mainnet.DAI, BigInt(1)))
        .revertedWithCustomError(subject, 'NotAgentOrManager')
        .withArgs(await signer.getAddress())
    })
    it('should successfully recover a token', async () => {
      const amount = ethers.parseEther('1')
      const token = await ethers.getContractAt('IERC20', mainnet.DAI)
      const subjectAddress = await subject.getAddress()

      await fillUpERC20FromTreasury({
        token: mainnet.DAI,
        amount: amount,
        address: subjectAddress,
      })

      const balanceBefore = await token.balanceOf(subjectAddress)

      await expect(subject.recoverERC20(mainnet.DAI, amount))
        .to.emit(subject, 'ERC20Recovered')
        .withArgs(mainnet.DAI, mainnet.AGENT, amount)

      const balanceAfter = await token.balanceOf(subjectAddress)

      expect(balanceBefore - amount).to.equal(balanceAfter)
    })
  })

  this.afterAll(async function () {
    await network.provider.send('evm_revert', [snapshotId])
  })
})
