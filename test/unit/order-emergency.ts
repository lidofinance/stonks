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

describe('Order - Emergency Controls & Signature Pause', function () {
  const contracts = getContracts()
  const PRICE_TOLERANCE_IN_BP = 1000
  const MARGIN_IN_BPS = 500

  let manager: Signer
  let stranger: Signer
  let stonks: Stonks
  let order: Order
  let orderHash: string
  let oracleRouter: OracleRouter
  let amountConverterTest: AmountConverterTest
  let snapshot: SnapshotRestorer
  let setupSnapshot: SnapshotRestorer
  let admin: Signer
  let emergencyOperator: Signer

  before(async function () {
    snapshot = await takeSnapshot()
    const signers = await ethers.getSigners()
    manager = signers[0]
    stranger = signers[1]

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
        admin: contracts.ADMIN,
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
        allowedTokensToBuy: [contracts.DAI],
      },
    })

    stonks = stonksInstance
    admin = await ethers.getImpersonatedSigner(contracts.ADMIN)

    await ethers.provider.send('hardhat_setBalance', [contracts.ADMIN, '0x1000000000000000000'])
    await ethers.provider.send('hardhat_setBalance', [
      contracts.EMERGENCY_MULTISIG,
      '0x1000000000000000000',
    ])

    await fillUpERC20FromTreasury({
      token: contracts.STETH,
      amount: ethers.parseEther('1'),
      address: await stonks.getAddress(),
    })

    emergencyOperator = await ethers.getImpersonatedSigner(contracts.EMERGENCY_MULTISIG)

    setupSnapshot = await takeSnapshot()
  })

  beforeEach(async function () {
    await setupSnapshot.restore()

    const expectedBuyAmount = await stonks.estimateTradeOutputFromCurrentBalance()
    const tx = await stonks.placeOrder(expectedBuyAmount)
    const rc = await tx.wait()

    if (!rc) throw new Error('no rc')

    const evt = await getPlaceOrderData(rc)
    order = await ethers.getContractAt('Order', evt.address, manager)
    orderHash = await formOrderHashFromTxReceipt(rc)

    await order.connect(admin).setEmergencyOperator(contracts.EMERGENCY_MULTISIG)
  })

  it('baseline sanity: validation works', async function () {
    expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)
  })

  it('global signatures pause causes Order to revert with SignaturesGloballyPaused', async function () {
    await stonks.pauseSignatures()
    await expect(order.isValidSignature(orderHash, '0x')).to.be.revertedWithCustomError(
      order,
      'SignaturesGloballyPaused'
    )
    await stonks.unpauseSignatures()
  })

  it('per-order emergencyCancelAndReturn returns funds, zeroes allowance, and cancels validation', async function () {
    const tokenFrom = await stonks.TOKEN_FROM()
    const token = await ethers.getContractAt('IERC20', tokenFrom)

    // perform cancellation
    await order.emergencyCancelAndReturn()
    expect(await order.cancelled()).to.be.true

    // balance should move back to Stonks (allow small rounding)
    const balAfter = await token.balanceOf(order)
    expect(balAfter).to.be.closeTo(0n, 2n)

    // validation should now revert with OrderCancelled
    await expect(order.isValidSignature(orderHash, '0x')).to.be.revertedWithCustomError(
      order,
      'OrderIsCancelled'
    )

    // idempotent call
    await expect(order.emergencyCancelAndReturn()).to.not.be.reverted
  })

  it('per-order emergencyRevokeRelayer zeroes allowance without moving funds', async function () {
    await order.emergencyRevokeRelayer()
    expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)
  })

  it('allows manager to call emergency controls on Order', async function () {
    const tokenFrom = await stonks.TOKEN_FROM()
    const token = await ethers.getContractAt('IERC20', tokenFrom)
    const balBefore = await token.balanceOf(order)
    expect(balBefore).to.be.gt(0n)

    await order.connect(manager).emergencyRevokeRelayer()
    await order.connect(manager).emergencyCancelAndReturn()
    expect(await order.cancelled()).to.be.true

    const balAfter = await token.balanceOf(order)
    expect(balAfter).to.be.closeTo(0n, 2n)
  })

  it('allows admin to call emergency controls on Order', async function () {
    const tokenFrom = await stonks.TOKEN_FROM()
    const token = await ethers.getContractAt('IERC20', tokenFrom)
    const balBefore = await token.balanceOf(order)
    expect(balBefore).to.be.gt(0n)

    await order.connect(admin).emergencyRevokeRelayer()
    await order.connect(admin).emergencyCancelAndReturn()
    expect(await order.cancelled()).to.be.true

    const balAfter = await token.balanceOf(order)
    expect(balAfter).to.be.closeTo(0n, 2n)
  })

  it('allows emergency operator multisig to call emergency controls on Order', async function () {
    const tokenFrom = await stonks.TOKEN_FROM()
    const token = await ethers.getContractAt('IERC20', tokenFrom)
    const balBefore = await token.balanceOf(order)
    expect(balBefore).to.be.gt(0n)

    await order.connect(emergencyOperator).emergencyRevokeRelayer()
    await order.connect(emergencyOperator).emergencyCancelAndReturn()
    expect(await order.cancelled()).to.be.true

    const balAfter = await token.balanceOf(order)
    expect(balAfter).to.be.closeTo(0n, 2n)
  })

  it('rejects stranger for Order emergency controls', async function () {
    await expect(order.connect(stranger).emergencyCancelAndReturn())
      .to.be.revertedWithCustomError(order, 'NotEmergencyOperator')
      .withArgs(await stranger.getAddress())

    await expect(order.connect(stranger).emergencyRevokeRelayer())
      .to.be.revertedWithCustomError(order, 'NotEmergencyOperator')
      .withArgs(await stranger.getAddress())
  })

  after(async function () {
    await snapshot.restore()

    resetTestOracleRouter()
    resetTestFeedRegistryStub()
  })
})
