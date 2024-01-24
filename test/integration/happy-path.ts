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

describe('Happy path', function () {
  let signer: Signer
  let subject: Stonks
  let orderReceipt: TransactionReceipt
  let subjectTokenConverter: AmountConverter
  let snapshotId: string
  let expectedBuyAmount: bigint

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
        orderDuration: 3600,
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
      expectedBuyAmount = await subject.estimateTradeOutputFromCurrentBalance()
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
      await expect(
        order.isValidSignature(ethers.ZeroHash, '0x')
      ).to.be.revertedWithCustomError(order, 'InvalidOrderHash')
    })

    it('should not be possible to cancel order due to expiration time', async () => {
      await expect(order.recoverTokenFrom()).to.be.revertedWithCustomError(
        order,
        'OrderNotExpired'
      )
    })

    it('should be possible to cancel order after expiration time', async () => {
      const localSnapshotId = await network.provider.send('evm_snapshot')

      await network.provider.send('evm_increaseTime', [3600])
      await order.recoverTokenFrom()

      const steth = await ethers.getContractAt('IERC20', mainnet.STETH)
      expect(
        isClose(await steth.balanceOf(await order.getAddress()), BigInt(0))
      ).to.be.true

      await network.provider.send('evm_revert', [localSnapshotId])
    })

    it('settlement should pull off assets from order contract', async () => {
      await network.provider.send('hardhat_setCode', [
        mainnet.VAULT_RELAYER,
        '0x',
      ])
      await fillUpBalance(mainnet.VAULT_RELAYER, ethers.parseEther('100'))
      await network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: [mainnet.VAULT_RELAYER],
      })
      const relayerSigner = await ethers.provider.getSigner(
        mainnet.VAULT_RELAYER
      )
      const stethRelayer = await ethers.getContractAt(
        'IERC20',
        mainnet.STETH,
        relayerSigner
      )
      const orderAddress = await order.getAddress()

      await stethRelayer.transferFrom(
        orderAddress,
        mainnet.VAULT_RELAYER,
        await stethRelayer.balanceOf(await order.getAddress())
      )

      expect(isClose(await stethRelayer.balanceOf(orderAddress), BigInt(0))).to
        .be.true
    })
  })

  this.afterAll(async () => {
    await network.provider.send('evm_revert', [snapshotId])
  })
})
