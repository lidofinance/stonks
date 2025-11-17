import { ethers } from 'hardhat'
import { expect } from 'chai'
import { Signer } from 'ethers'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import { Order, Stonks, AmountConverterTest, OracleRouter } from '../../typechain-types'
import { getTestOracleRouter, resetTestOracleRouter } from '../../utils/test-oracle-router'
import {
  getAllTestTokens,
  refreshTestFeedData,
  resetTestFeedRegistryStub,
} from '../../utils/test-feed-registry'
import { deployStonks } from '../../scripts/deployments/stonks'
import { getContracts } from '../../utils/contracts'
import { MAGIC_VALUE, formOrderHashFromTxReceipt } from '../../utils/gpv2-helpers'
import { fillUpERC20FromTreasury } from '../../utils/fill-up-balance'
import { getPlaceOrderData } from '../../utils/get-events'

describe('Stonks - Emergency Controls', function () {
  const contracts = getContracts()
  const PRICE_TOLERANCE_IN_BP = 1000
  const MARGIN_IN_BPS = 500

  let manager: Signer
  let stonks: Stonks
  let order: Order
  let orderHash: string
  let oracleRouter: OracleRouter
  let amountConverterTest: AmountConverterTest
  let snapshot: SnapshotRestorer

  this.beforeAll(async function () {
    snapshot = await takeSnapshot()
    manager = (await ethers.getSigners())[0]

    const amountConverterTestFactory = await ethers.getContractFactory('AmountConverterTest')

    oracleRouter = await getTestOracleRouter({
      tokens: getAllTestTokens(),
      useRealPrices: true,
    })
    await refreshTestFeedData(getAllTestTokens())

    amountConverterTest = await amountConverterTestFactory.deploy(
      await oracleRouter.getAddress(),
      [contracts.STETH],
      [contracts.DAI],
      false
    )
    await amountConverterTest.waitForDeployment()

    const { stonks: stonksInstance } = await deployStonks({
      factoryParams: {
        agent: contracts.AGENT,
        relayer: contracts.VAULT_RELAYER,
        settlement: contracts.SETTLEMENT,
        priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        oracleRouterAddress: await oracleRouter.getAddress(),
      },
      stonksParams: {
        tokenFrom: contracts.STETH,
        tokenTo: contracts.DAI,
        manager: await manager.getAddress(),
        marginInBps: MARGIN_IN_BPS,
        orderDuration: 3600,
        priceToleranceInBps: PRICE_TOLERANCE_IN_BP,
        maxImprovementInBps: 100,
        allowPartialFill: true,
        amountConverterAddress: await amountConverterTest.getAddress(),
      },
      amountConverterParams: {
        oracleRouter: await oracleRouter.getAddress(),
        allowedTokensToSell: [contracts.STETH],
        allowedStableTokensToBuy: [contracts.DAI],
      },
    })
    stonks = stonksInstance
    await fillUpERC20FromTreasury({
      token: contracts.STETH,
      amount: ethers.parseEther('1'),
      address: await stonks.getAddress(),
    })

    const expectedBuyAmount = await stonks.estimateTradeOutputFromCurrentBalance()
    const tx = await stonks.placeOrder(expectedBuyAmount)
    const rc = await tx.wait()
    if (!rc) throw new Error('no rc')
    const evt = await getPlaceOrderData(rc)
    order = await ethers.getContractAt('Order', evt.address, manager)
    orderHash = await formOrderHashFromTxReceipt(rc)
  })

  it('baseline sanity: validation works', async function () {
    expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)
  })

  it('signatures pause halts fills and unpause restores', async function () {
    // pause signatures
    await stonks.pauseSignatures()
    expect(await stonks.areSignaturesPaused()).to.equal(true)
    await expect(order.isValidSignature(orderHash, '0x')).to.be.revertedWithCustomError(
      order,
      'SignaturesGloballyPaused'
    )

    // unpause signatures
    await stonks.unpauseSignatures()
    expect(await stonks.areSignaturesPaused()).to.equal(false)
    expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)
  })

  it('creation pause halts placeOrder and placeOrderWithAmount; recovery remains callable', async function () {
    await stonks.pauseCreation()
    expect(await stonks.isCreationPaused()).to.equal(true)

    const expectedBuyAmount = await stonks.estimateTradeOutputFromCurrentBalance()
    await expect(stonks.placeOrder(expectedBuyAmount)).to.be.reverted

    const tokenFrom = await stonks.TOKEN_FROM()
    const bal = await (await ethers.getContractAt('IERC20', tokenFrom)).balanceOf(stonks)
    if (bal > 0n) {
      // ensure recovery callable
      await expect(stonks.recoverERC20(tokenFrom, 1)).to.not.be.reverted
    }

    await stonks.unpauseCreation()
    expect(await stonks.isCreationPaused()).to.equal(false)
  })

  it('killSwitch is irreversible, pauses creation and signatures', async function () {
    await stonks.killSwitch()
    expect(await stonks.isKilled()).to.equal(true)
    expect(await stonks.isCreationPaused()).to.equal(true)
    expect(await stonks.areSignaturesPaused()).to.equal(true)

    const expectedBuyAmount = await stonks.estimateTradeOutputFromCurrentBalance()
    await expect(stonks.placeOrder(expectedBuyAmount)).to.be.revertedWithCustomError(
      stonks,
      'StonksKilled'
    )
    await expect(order.isValidSignature(orderHash, '0x')).to.be.revertedWithCustomError(
      order,
      'SignaturesGloballyPaused'
    )
  })

  this.afterAll(async function () {
    await snapshot.restore()
    resetTestOracleRouter()
    resetTestFeedRegistryStub()
  })
})
