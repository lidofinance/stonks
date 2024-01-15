import { ethers, network } from 'hardhat'
import { Signer, TransactionReceipt } from 'ethers'
import { expect } from 'chai'
import { deployStonks } from '../../scripts/deployments/stonks'
import { AmountConverter, Stonks, Order } from '../../typechain-types'
import { mainnet } from '../../utils/contracts'
import { getPlaceOrderData } from '../../utils/get-events'
import { isClose } from '../../utils/assert'
import { fillUpBalance } from '../../utils/fill-up-balance'
import {
  MAGIC_VALUE,
  formOrderHashFromTxReceipt,
} from '../../utils/gpv2-helpers'

describe('Unsuccessful path', function () {
  let signer: Signer
  let subject: Stonks
  let orderReceipt: TransactionReceipt
  let subjectTokenConverter: AmountConverter
  let snapshotId: string
  let expectedBuyAmount: bigint
  let orderDuration: number = 600

  this.beforeAll(async function () {
    snapshotId = await network.provider.send('evm_snapshot')
    signer = (await ethers.getSigners())[0]

    const { stonks, amountConverter: tokenConverter } = await deployStonks({
      factoryParams: {
        agent: mainnet.AGENT,
        relayer: mainnet.VAULT_RELAYER,
        settlement: mainnet.SETTLEMENT,
        priceFeedRegistry: mainnet.CHAINLINK_PRICE_FEED_REGISTRY,
      },
      stonksParams: {
        tokenFrom: mainnet.STETH,
        tokenTo: mainnet.DAI,
        manager: await signer.getAddress(),
        marginInBps: 100,
        orderDuration: orderDuration,
        priceToleranceInBps: 100,
      },
      amountConverterParams: {
        conversionTarget: '0x0000000000000000000000000000000000000348', // USD
        allowedTokensToSell: [mainnet.STETH],
        allowedStableTokensToBuy: [mainnet.DAI],
        priceFeedsHeartbeatTimeouts: [3600],
      },
    })

    subject = stonks
    subjectTokenConverter = tokenConverter
  })

  describe('order creation:', async function () {
    const value = ethers.parseEther('100')
    let order: Order

    this.beforeAll(async () => {
      fillUpBalance(mainnet.AGENT, value)
    })

    it('should fill up stonks contract', async () => {
      await network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: [mainnet.AGENT],
      })
      const treasurySigner = await ethers.provider.getSigner(mainnet.AGENT)
      const stethTreasury = await ethers.getContractAt(
        'IERC20',
        mainnet.STETH,
        treasurySigner
      )
      const subjectAddress = await subject.getAddress()

      const transferTx = await stethTreasury.transfer(subjectAddress, value)
      await transferTx.wait()

      expect(isClose(await stethTreasury.balanceOf(subjectAddress), value)).to
        .be.true
    })

    it('should place order', async () => {
      expectedBuyAmount = await subject.estimateOutputFromCurrentBalance()
      const orderTx = await subject.placeOrder(expectedBuyAmount)

      orderReceipt = (await orderTx.wait())!
      if (!orderReceipt) throw new Error('No order receipt')

      const { address } = await getPlaceOrderData(orderReceipt)

      const steth = await ethers.getContractAt('IERC20', mainnet.STETH)
      order = await ethers.getContractAt('Order', address)

      expect(isClose(await steth.balanceOf(address), value)).to.be.true
      expect(isClose(await steth.balanceOf(subject.getAddress()), BigInt(0))).to
        .be.true
    })

    it('settlement should check hash', async () => {
      const orderHash = await formOrderHashFromTxReceipt(
        orderReceipt,
        subject,
        expectedBuyAmount
      )

      expect(await order.isValidSignature(orderHash, '0x')).to.equal(
        MAGIC_VALUE
      )
      expect(order.isValidSignature('0x', '0x')).to.be.revertedWith(
        'order: invalid hash'
      )
    })

    it('should not be possible to cancel order due to expiration time', () => {
      expect(order.recoverTokenFrom()).to.be.revertedWith(
        'Order: order is expired'
      )
    })

    it('should cancel the order after expiration time', async () => {
      await network.provider.send('evm_increaseTime', [orderDuration])
      await order.recoverTokenFrom()

      const steth = await ethers.getContractAt('IERC20', mainnet.STETH)
      expect(
        isClose(await steth.balanceOf(await order.getAddress()), BigInt(0))
      ).to.be.true
    })

    it('should re-place order', async () => {
      const expectedBuyAmount = await subject.estimateOutputFromCurrentBalance()
      const orderTx = await subject.placeOrder(expectedBuyAmount)

      orderReceipt = (await orderTx.wait())!
      if (!orderReceipt) throw new Error('No order receipt')

      const { address } = await getPlaceOrderData(orderReceipt)

      const steth = await ethers.getContractAt('IERC20', mainnet.STETH)
      order = await ethers.getContractAt('Order', address)

      expect(isClose(await steth.balanceOf(address), value)).to.be.true
      expect(isClose(await steth.balanceOf(subject.getAddress()), BigInt(0))).to
        .be.true
    })

    it('should not be possible to cancel order due to expiration time', () => {
      expect(order.recoverTokenFrom()).to.be.revertedWith(
        'Order: order is expired'
      )
    })

    it('should cancel the order after expiration time', async () => {
      await network.provider.send('evm_increaseTime', [orderDuration])
      await order.recoverTokenFrom()

      const steth = await ethers.getContractAt('IERC20', mainnet.STETH)
      expect(
        isClose(await steth.balanceOf(await order.getAddress()), BigInt(0))
      ).to.be.true
    })

    it('should successfully recover assets', async () => {
      const steth = await ethers.getContractAt('IERC20', mainnet.STETH)
      const stonksBalanceBefore = await steth.balanceOf(
        await subject.getAddress()
      )
      const agentBalanceBefore = await steth.balanceOf(mainnet.AGENT)

      const tx = await subject.recoverERC20(mainnet.STETH, stonksBalanceBefore)
      await tx.wait()

      const stonksBalanceAfter = await steth.balanceOf(
        await subject.getAddress()
      )
      const agentBalanceAfter = await steth.balanceOf(mainnet.AGENT)

      expect(isClose(stonksBalanceAfter, BigInt(0))).to.be.true
      expect(
        isClose(agentBalanceAfter, agentBalanceBefore + stonksBalanceBefore)
      ).to.be.true
    })
  })

  this.afterAll(async () => {
    await network.provider.send('evm_revert', [snapshotId])
  })
})
