import { ethers, network } from 'hardhat'
import { expect } from 'chai'
import { Signer } from 'ethers'
import {
  Order,
  Stonks,
  HashHelper,
  ChainLinkTokenConverter,
} from '../../typechain-types'
import { deployStonks } from '../../scripts/deployments/stonks'
import { mainnet } from '../../utils/contracts'
import {
  MAGIC_VALUE,
  formOrderHashFromTxReceipt,
} from '../../utils/gpv2-helpers'
import { fillUpERC20FromTreasury } from '../../utils/fill-up-balance'

describe('Order', async function () {
  let signer: Signer
  let stonks: Stonks
  let hashHelper: HashHelper
  let tokenConverter: ChainLinkTokenConverter
  let snapshotId: string

  this.beforeAll(async function () {
    snapshotId = await network.provider.send('evm_snapshot')
    signer = (await ethers.getSigners())[0]

    const { stonks: stonksInstance, tokenConverter: tokenConverterInstance } =
      await deployStonks({
        stonksParams: {
          tokenFrom: mainnet.STETH,
          tokenTo: mainnet.DAI,
          operator: await signer.getAddress(),
          marginInBps: 100,
          priceToleranceInBps: 100,
        },
        tokenConverterParams: {
          priceFeedRegistry: mainnet.CHAINLINK_PRICE_FEED_REGISTRY,
          allowedTokensToSell: [mainnet.STETH],
          allowedStableTokensToBuy: [mainnet.DAI],
        },
      })
    const HashHelperFactory = await ethers.getContractFactory('HashHelper')

    hashHelper = await HashHelperFactory.deploy()
    await hashHelper.waitForDeployment()

    stonks = stonksInstance
    tokenConverter = tokenConverterInstance
  })

  describe('initialization (direct)', function () {
    it('sample instance should be initialized by default', async () => {
      const subject = await ethers.getContractAt(
        'Order',
        await stonks.orderSample()
      )
      expect(subject.initialize(ethers.ZeroAddress)).to.be.revertedWith(
        'order: already initialized'
      )
    })
  })

  describe('order validation', function () {
    let subject: Order
    let orderHash: string

    this.beforeAll(async function () {
      await fillUpERC20FromTreasury({
        token: mainnet.STETH,
        amount: ethers.parseEther('1'),
        address: await stonks.getAddress(),
      })

      const placeOrderTx = await stonks.placeOrder()
      const placeOrderTxReceipt = await placeOrderTx.wait()

      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt, stonks)
    })

    it('should return magic value if order hash is valid', async () => {
      expect(await subject.isValidSignature(orderHash, '0x')).to.equal(
        MAGIC_VALUE
      )
    })
    it('should revert if order hash is invalid', async () => {
      expect(subject.isValidSignature('0x', '0x')).to.be.revertedWith(
        'order: invalid hash'
      )
    })
    it('should revert if order is expired', async () => {
      await network.provider.send('evm_increaseTime', [60 * 60 * 24 * 7])

      expect(subject.isValidSignature(orderHash, '0x')).to.be.revertedWith(
        'order: invalid time'
      )
    })
    it('should not revert if there was a price spike less than price tolerance allows', async () => {})
    it('should revert if there was a price spike', async () => {})
  })

  describe('order canceling', function () {
    it('should succesfully cancel the order', async () => {})
    it('should revert if order is not expired', async () => {})
  })

  describe('asset recovery', function () {
    it('should succesfully recover Ether', async () => {})
    it('should succesfully recover ERC20', async () => {})
    it('should succesfully recover ERC721', async () => {})
    it('should succesfully recover recoverERC1155', async () => {})
    it('should revert if recover a token from', async () => {})
    it('should revert if it is called by stranger', async () => {})
    it('should succesfully recover by operator', async () => {})
    it('should succesfully recover by agent', async () => {})
  })

  this.afterAll(async function () {
    await network.provider.send('evm_revert', [snapshotId])
  })
})
