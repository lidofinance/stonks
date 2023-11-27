import { ethers, network } from 'hardhat'
import { expect } from 'chai'
import { Signer } from 'ethers'
import {
  Order,
  Stonks,
  HashHelper,
  AmountConverter,
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

describe('Order', async function () {
  let operator: Signer
  let stonks: Stonks
  let hashHelper: HashHelper
  let tokenConverter: AmountConverter
  let snapshotId: string
  let subject: Order
  let orderHash: string

  this.beforeAll(async function () {
    snapshotId = await network.provider.send('evm_snapshot')
    operator = (await ethers.getSigners())[0]

    const { stonks: stonksInstance, amountConverter: tokenConverterInstance } =
      await deployStonks({
        factoryParams: {
          agent: mainnet.TREASURY,
          relayer: mainnet.VAULT_RELAYER,
          settlement: mainnet.SETTLEMENT,
          priceFeedRegistry: mainnet.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: mainnet.STETH,
          tokenTo: mainnet.DAI,
          manager: await operator.getAddress(),
          marginInBps: 100,
          orderDuration: 3600,
          priceToleranceInBps: 100,
        },
        amountConverterParams: {
          conversionTarget: '0x0000000000000000000000000000000000000348', // USD
          allowedTokensToSell: [mainnet.STETH],
          allowedStableTokensToBuy: [mainnet.DAI],
        },
      })
    const HashHelperFactory = await ethers.getContractFactory('HashHelper')

    hashHelper = await HashHelperFactory.deploy()
    await hashHelper.waitForDeployment()

    stonks = stonksInstance
    tokenConverter = tokenConverterInstance

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
      expect(subject.initialize(ethers.ZeroAddress)).to.be.revertedWith(
        'OrderAlreadyInitialized'
      )
    })
  })

  describe('order validation:', function () {
    it('should return magic value if order hash is valid', async () => {
      expect(await subject.isValidSignature(orderHash, '0x')).to.equal(
        MAGIC_VALUE
      )
    })
    it('should revert if order hash is invalid', async () => {
      expect(subject.isValidSignature('0x', '0x')).to.be.revertedWith(
        'InvalidOrderHash'
      )
    })
    it('should revert if order is expired', async () => {
      await network.provider.send('evm_increaseTime', [60 * 60 + 1])

      expect(subject.isValidSignature('0x', '0x')).to.be.revertedWith(
        'InvalidOrderHash'
      )
      expect(subject.isValidSignature(orderHash, '0x')).to.be.revertedWith(
        'OrderExpired'
      )
    })
    it('should not revert if there was a price spike less than price tolerance allows', async () => {})
    it('should revert if there was a price spike', async () => {})
  })

  describe('recovering token from:', function () {
    it('should succesfully cancel the order', async () => {
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
      expect(subject.recoverTokenFrom()).to.be.revertedWith('OrderNotExpired')
    })
  })

  describe('asset recovering edge case:', async function () {
    it('should revert if recover a token from', async () => {
      const orderParams = await stonks.getOrderParameters()
      expect(
        subject.recoverERC20(orderParams['tokenFrom'], BigInt(1))
      ).to.be.revertedWith('CannotRecoverTokenFrom')
    })
  })

  this.afterAll(async function () {
    await network.provider.send('evm_revert', [snapshotId])
  })
})
