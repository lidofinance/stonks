import { ethers, network } from 'hardhat'
import { expect } from 'chai'
import { Signer } from 'ethers'
import {
  Order,
  Stonks,
  HashHelper,
  AmountConverter,
  AmountConverterTest,
  Order__factory,
} from '../../typechain-types'
import { deployStonks } from '../../scripts/deployments/stonks'
import { mainnet } from '../../utils/contracts'
import {
  MAGIC_VALUE,
  formOrderHashFromTxReceipt,
} from '../../utils/gpv2-helpers'
import { fillUpERC20FromTreasury } from '../../utils/fill-up-balance'
import { getPlaceOrderData } from '../../utils/get-events'
import { isClose } from '../../utils/assert'

const PRICE_TOLERANCE_IN_BP = 1000

describe('Order', async function () {
  let operator: Signer
  let stonks: Stonks
  let hashHelper: HashHelper
  let amountConverter: AmountConverter
  let snapshotId: string
  let subject: Order
  let orderHash: string

  this.beforeAll(async function () {
    snapshotId = await network.provider.send('evm_snapshot')
    operator = (await ethers.getSigners())[0]

    const amountConverterTestFactory = await ethers.getContractFactory(
      'AmountConverterTest'
    )
    const amountConverterTest = await amountConverterTestFactory.deploy(
      mainnet.CHAINLINK_PRICE_FEED_REGISTRY,
      mainnet.CHAINLINK_USD_QUOTE,
      [mainnet.STETH],
      [mainnet.DAI]
    )
    await amountConverterTest.waitForDeployment()

    const { stonks: stonksInstance, amountConverter: amountConverterInstance } =
      await deployStonks({
        factoryParams: {
          agent: mainnet.AGENT,
          relayer: mainnet.VAULT_RELAYER,
          settlement: mainnet.SETTLEMENT,
          priceFeedRegistry: mainnet.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: mainnet.STETH,
          tokenTo: mainnet.DAI,
          manager: await operator.getAddress(),
          marginInBps: 500,
          orderDuration: 3600,
          priceToleranceInBps: PRICE_TOLERANCE_IN_BP,
          amountConverterAddress: await amountConverterTest.getAddress(),
        },
        amountConverterParams: {
          conversionTarget: mainnet.CHAINLINK_USD_QUOTE, // USD
          allowedTokensToSell: [mainnet.STETH],
          allowedStableTokensToBuy: [mainnet.DAI],
        },
      })
    const HashHelperFactory = await ethers.getContractFactory('HashHelper')

    hashHelper = await HashHelperFactory.deploy()
    await hashHelper.waitForDeployment()

    stonks = stonksInstance
    amountConverter = amountConverterInstance

    await fillUpERC20FromTreasury({
      token: mainnet.STETH,
      amount: ethers.parseEther('1'),
      address: await stonks.getAddress(),
    })

    const placeOrderTx = await stonks.placeOrder()
    const placeOrderTxReceipt = await placeOrderTx.wait()

    if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

    subject = await ethers.getContractAt(
      'Order',
      getPlaceOrderData(placeOrderTxReceipt).address,
      operator
    )

    orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt, stonks)
  })

  describe('initialization (direct):', function () {
    it('sample instance should be initialized by default', async () => {
      const subject = await ethers.getContractAt(
        'Order',
        await stonks.orderSample()
      )
      await expect(
        subject.initialize(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(subject, 'OrderAlreadyInitialized')
    })
  })

  describe('initialization (from Stonks):', function () {})

  describe('isValidSignature:', function () {
    let localSnapshotId: string

    this.beforeEach(async function () {
      localSnapshotId = await network.provider.send('evm_snapshot')
    })

    it('should return magic value if order hash is valid', async () => {
      expect(await subject.isValidSignature(orderHash, '0x')).to.equal(
        MAGIC_VALUE
      )
    })
    it('should revert if order hash is invalid', async () => {
      await expect(
        subject.isValidSignature(ethers.ZeroHash, '0x')
      ).to.be.revertedWithCustomError(subject, 'InvalidOrderHash')
    })
    it('should revert if order is expired', async () => {
      await network.provider.send('evm_increaseTime', [60 * 60 + 1])
      await network.provider.send('evm_mine')

      await expect(
        subject.isValidSignature(orderHash, '0x')
      ).to.be.revertedWithCustomError(subject, 'OrderExpired')
    })
    it('should not revert if there was a price spike less than price tolerance allows', async () => {
      const amountConverterTest = await ethers.getContractAt(
        'AmountConverterTest',
        await amountConverter.getAddress()
      )

      // await amountConverterTest.multiplyAnswer(10000 + PRICE_TOLERANCE_IN_BP + 112)
      const result = await subject.isValidSignature(orderHash, '0x')
    })
    it('should revert if there was a price spike', async () => {})

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
      const orderParams = await stonks.getOrderParameters()

      await network.provider.send('evm_increaseTime', [60 * 60 + 1])

      const token = await ethers.getContractAt(
        'IERC20',
        orderParams['tokenFrom']
      )
      const stonksBalanceBefore = await token.balanceOf(
        await stonks.getAddress()
      )
      const orderBalanceBefore = await token.balanceOf(
        await subject.getAddress()
      )

      const cancelTx = await subject.recoverTokenFrom()
      await cancelTx.wait()

      const stonksBalanceAfter = await token.balanceOf(
        await stonks.getAddress()
      )
      const orderBalanceAfter = await token.balanceOf(
        await subject.getAddress()
      )

      expect(
        isClose(stonksBalanceBefore + orderBalanceBefore, stonksBalanceAfter)
      ).to.be.true
      expect(isClose(orderBalanceAfter, BigInt(0))).to.be.true
    })
    it('should revert if order is not expired', async () => {
      await expect(subject.recoverTokenFrom()).to.be.revertedWithCustomError(
        subject,
        'OrderNotExpired'
      )
    })
    this.afterEach(async function () {
      await network.provider.send('evm_revert', [localSnapshotId])
    })
  })

  describe('recoverERC20:', async function () {
    it('should revert if recover a token from', async () => {
      const orderParams = await stonks.getOrderParameters()
      await expect(
        subject.recoverERC20(orderParams['tokenFrom'], BigInt(1))
      ).revertedWithCustomError(subject, 'CannotRecoverTokenFrom')
    })
    it('should successfully recover a token', async () => {
      const amount = ethers.parseEther('1')
      const token = await ethers.getContractAt('IERC20', mainnet.DAI)
      await fillUpERC20FromTreasury({
        token: mainnet.DAI,
        amount: ethers.parseEther('1'),
        address: await subject.getAddress(),
      })
      await expect(subject.recoverERC20(mainnet.DAI, amount))
        .to.emit(subject, 'ERC20Recovered')
        .withArgs(mainnet.DAI, mainnet.AGENT, amount)
    })
  })

  this.afterAll(async function () {
    await network.provider.send('evm_revert', [snapshotId])
  })
})
