import { ethers, network } from 'hardhat'
import { expect } from 'chai'
import { Signer } from 'ethers'
import {
  Order,
  Stonks,
  HashHelper,
  TokenAmountConverter,
} from '../../typechain-types'
import { deployStonks } from '../../scripts/deployments/stonks'
import { mainnet } from '../../utils/contracts'
import {
  MAGIC_VALUE,
  formOrderHashFromTxReceipt,
} from '../../utils/gpv2-helpers'
import {
  fillUpBalance,
  fillUpERC20FromTreasury,
} from '../../utils/fill-up-balance'
import { getPlaceOrderData } from '../../utils/get-events'
import { isClose } from '../../utils/assert'

describe('Order', async function () {
  let operator: Signer
  let stonks: Stonks
  let hashHelper: HashHelper
  let tokenConverter: TokenAmountConverter
  let snapshotId: string
  let subject: Order
  let orderHash: string

  this.beforeAll(async function () {
    snapshotId = await network.provider.send('evm_snapshot')
    operator = (await ethers.getSigners())[0]

    const { stonks: stonksInstance, tokenConverter: tokenConverterInstance } =
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
        tokenConverterParams: {
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
      await network.provider.send('evm_increaseTime', [60 * 60 + 1])

      expect(subject.isValidSignature('0x', '0x')).to.be.revertedWith(
        'order: invalid hash'
      )
      expect(subject.isValidSignature(orderHash, '0x')).to.be.revertedWith(
        'order: invalid time'
      )
    })
    it('should not revert if there was a price spike less than price tolerance allows', async () => {})
    it('should revert if there was a price spike', async () => {})
  })

  describe('order canceling', function () {
    it('should succesfully cancel the order', async () => {
      await network.provider.send('evm_increaseTime', [60 * 60 + 1])

      const token = await ethers.getContractAt(
        'IERC20',
        await stonks.tokenFrom()
      )
      const stonksBalanceBefore = await token.balanceOf(
        await stonks.getAddress()
      )
      const orderBalanceBefore = await token.balanceOf(
        await subject.getAddress()
      )

      const cancelTx = await subject.cancel()
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
      expect(subject.cancel()).to.be.revertedWith('order: not expired')
    })
  })

  describe('asset recovery', async function () {
    const amount = BigInt(10 ** 18)
    const token = await ethers.getContractAt('IERC20', mainnet.DAI)
    const subjectAddress = await subject.getAddress()

    this.beforeAll(async function () {
      await fillUpBalance(await subject.getAddress(), amount)
      await fillUpERC20FromTreasury({
        amount,
        token: mainnet.DAI,
        address: await subject.getAddress(),
      })
    })

    it('should succesfully recover Ether', async () => {
      const subjectBalanceBefore =
        await ethers.provider.getBalance(subjectAddress)
      const treasuryBalanceBefore = await ethers.provider.getBalance(
        mainnet.TREASURY
      )

      expect(subjectBalanceBefore).to.be.equal(amount)

      const recoverTx = await subject.recoverEther()
      await recoverTx.wait()

      const subjectBalanceAfter =
        await ethers.provider.getBalance(subjectAddress)
      const treasuryBalanceAfter = await ethers.provider.getBalance(
        mainnet.TREASURY
      )

      expect(subjectBalanceAfter).to.be.equal(subjectBalanceBefore - amount)
      expect(treasuryBalanceAfter).to.be.equal(treasuryBalanceBefore + amount)
    })
    it('should succesfully recover ERC20', async () => {
      expect(await token.balanceOf(await subject.getAddress())).to.be.equal(
        amount
      )

      const recoverTx = await subject.recoverERC20(mainnet.DAI, amount)
      await recoverTx.wait()

      expect(await token.balanceOf(await subject.getAddress())).to.be.equal(
        BigInt(0)
      )
    })
    it('should succesfully recover ERC721', async () => {})
    it('should succesfully recover recoverERC1155', async () => {})
    it('should revert if recover a token from', async () => {
      expect(
        subject.recoverERC20(await stonks.tokenFrom(), BigInt(1))
      ).to.be.revertedWith('order: cannot recover tokenFrom')
    })
    it('should revert if it is called by stranger', async () => {
      const localSubject = await ethers.getContractAt(
        'Order',
        await subject.getAddress(),
        (await ethers.getSigners())[1]
      )

      expect(localSubject.recoverEther()).to.be.revertedWith(
        'asset recoverer: not operator'
      )
    })
    it('should succesfully recover by operator', async () => {
      const localSubject = await ethers.getContractAt(
        'Order',
        await subject.getAddress(),
        operator
      )

      localSubject.recoverERC20(mainnet.DAI, amount)
    })
    it('should succesfully recover by agent', async () => {
      network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: [mainnet.TREASURY],
      })
      const agent = await ethers.provider.getSigner(mainnet.TREASURY)
      const localSubject = await ethers.getContractAt(
        'Order',
        await subject.getAddress(),
        agent
      )
      localSubject.recoverERC20(mainnet.DAI, amount)
    })
  })

  this.afterAll(async function () {
    await network.provider.send('evm_revert', [snapshotId])
  })
})
