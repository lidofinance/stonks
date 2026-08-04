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
  let admin: Signer
  let stranger: Signer
  let stonks: Stonks
  let order: Order
  let orderHash: string
  let oracleRouter: OracleRouter
  let amountConverterTest: AmountConverterTest
  let snapshot: SnapshotRestorer
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

    // Configure emergency operator to use the dedicated multisig in tests
    admin = await ethers.getImpersonatedSigner(contracts.ADMIN)
    await ethers.provider.send('hardhat_setBalance', [contracts.ADMIN, '0x1000000000000000000'])
    await ethers.provider.send('hardhat_setBalance', [
      contracts.EMERGENCY_MULTISIG,
      '0x1000000000000000000',
    ])
    await stonks.connect(admin).setEmergencyOperator(contracts.EMERGENCY_MULTISIG)
    emergencyOperator = await ethers.getImpersonatedSigner(contracts.EMERGENCY_MULTISIG)
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

  describe('emergency operator configuration', function () {
    it('allows admin to set emergency operator', async function () {
      const [, , newEmergency] = await ethers.getSigners()
      const newEmergencyAddress = await newEmergency.getAddress()

      await stonks.connect(admin).setEmergencyOperator(newEmergencyAddress)
      expect(await stonks.emergencyOperator()).to.equal(newEmergencyAddress)

      // restore original emergency multisig for other tests
      await stonks.connect(admin).setEmergencyOperator(contracts.EMERGENCY_MULTISIG)
      expect(await stonks.emergencyOperator()).to.equal(contracts.EMERGENCY_MULTISIG)
    })

    it('rejects manager attempting to set emergency operator', async function () {
      const [, , newEmergency] = await ethers.getSigners()
      await expect(stonks.connect(manager).setEmergencyOperator(await newEmergency.getAddress()))
        .to.be.revertedWithCustomError(stonks, 'NotAdmin')
        .withArgs(await manager.getAddress())
    })

    it('rejects stranger attempting to set emergency operator', async function () {
      const [, , newEmergency] = await ethers.getSigners()
      await expect(stonks.connect(stranger).setEmergencyOperator(await newEmergency.getAddress()))
        .to.be.revertedWithCustomError(stonks, 'NotAdmin')
        .withArgs(await stranger.getAddress())
    })
  })

  it('signatures pause halts fills and unpause restores', async function () {
    // pause signatures (manager is allowed emergency operator)
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

  describe('emergency operator access control', function () {
    it('allows manager to pause and unpause creation and signatures', async function () {
      if (await stonks.isCreationPaused()) {
        await stonks.connect(admin).unpauseCreation()
      }
      if (await stonks.areSignaturesPaused()) {
        await stonks.connect(admin).unpauseSignatures()
      }

      await stonks.connect(manager).pauseCreation()
      expect(await stonks.isCreationPaused()).to.equal(true)

      await stonks.connect(manager).unpauseCreation()
      expect(await stonks.isCreationPaused()).to.equal(false)

      await stonks.connect(manager).pauseSignatures()
      expect(await stonks.areSignaturesPaused()).to.equal(true)

      await stonks.connect(manager).unpauseSignatures()
      expect(await stonks.areSignaturesPaused()).to.equal(false)
    })

    it('allows admin to pause and unpause creation and signatures', async function () {
      if (await stonks.isCreationPaused()) {
        await stonks.connect(admin).unpauseCreation()
      }
      if (await stonks.areSignaturesPaused()) {
        await stonks.connect(admin).unpauseSignatures()
      }

      await stonks.connect(admin).pauseCreation()
      expect(await stonks.isCreationPaused()).to.equal(true)

      await stonks.connect(admin).unpauseCreation()
      expect(await stonks.isCreationPaused()).to.equal(false)

      await stonks.connect(admin).pauseSignatures()
      expect(await stonks.areSignaturesPaused()).to.equal(true)

      await stonks.connect(admin).unpauseSignatures()
      expect(await stonks.areSignaturesPaused()).to.equal(false)
    })

    it('allows emergency operator multisig to pause and unpause creation and signatures', async function () {
      if (await stonks.isCreationPaused()) {
        await stonks.connect(admin).unpauseCreation()
      }
      if (await stonks.areSignaturesPaused()) {
        await stonks.connect(admin).unpauseSignatures()
      }

      await stonks.connect(emergencyOperator).pauseCreation()
      expect(await stonks.isCreationPaused()).to.equal(true)

      await stonks.connect(emergencyOperator).unpauseCreation()
      expect(await stonks.isCreationPaused()).to.equal(false)

      await stonks.connect(emergencyOperator).pauseSignatures()
      expect(await stonks.areSignaturesPaused()).to.equal(true)

      await stonks.connect(emergencyOperator).unpauseSignatures()
      expect(await stonks.areSignaturesPaused()).to.equal(false)
    })

    it('rejects stranger calling pause or kill controls', async function () {
      await expect(stonks.connect(stranger).pauseCreation())
        .to.be.revertedWithCustomError(stonks, 'NotEmergencyOperator')
        .withArgs(await stranger.getAddress())

      await expect(stonks.connect(stranger).pauseSignatures())
        .to.be.revertedWithCustomError(stonks, 'NotEmergencyOperator')
        .withArgs(await stranger.getAddress())

      await expect(stonks.connect(stranger).killSwitch())
        .to.be.revertedWithCustomError(stonks, 'NotEmergencyOperator')
        .withArgs(await stranger.getAddress())
    })
  })

  describe('killSwitch', function () {
    let killSwitchStonks: Stonks
    let killSwitchOrder: Order
    let killSwitchOrderHash: string
    let killSwitchEmergencyOperator: Signer

    before(async function () {
      const amountConverterTestFactory = await ethers.getContractFactory('AmountConverterTest')

      const killSwitchOracleRouter = await getTestOracleRouter({
        tokens: getAllTestTokens(),
        useRealPrices: true,
      })
      await refreshTestFeedData(getAllTestTokens())

      const killSwitchAmountConverterTest = await amountConverterTestFactory.deploy(
        await killSwitchOracleRouter.getAddress(),
        [contracts.STETH],
        [contracts.DAI],
        false
      )
      await killSwitchAmountConverterTest.waitForDeployment()

      const { stonks: killSwitchStonksInstance } = await deployStonks({
        factoryParams: {
          admin: contracts.ADMIN,
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
          oracleRouterAddress: await killSwitchOracleRouter.getAddress(),
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
          amountConverterAddress: await killSwitchAmountConverterTest.getAddress(),
        },
        amountConverterParams: {
          oracleRouter: await killSwitchOracleRouter.getAddress(),
          allowedTokensToSell: [contracts.STETH],
          allowedTokensToBuy: [contracts.DAI],
        },
      })
      killSwitchStonks = killSwitchStonksInstance

      const killSwitchAdmin = await ethers.getImpersonatedSigner(contracts.ADMIN)
      await ethers.provider.send('hardhat_setBalance', [contracts.ADMIN, '0x1000000000000000000'])
      await ethers.provider.send('hardhat_setBalance', [
        contracts.EMERGENCY_MULTISIG,
        '0x1000000000000000000',
      ])
      await killSwitchStonks
        .connect(killSwitchAdmin)
        .setEmergencyOperator(contracts.EMERGENCY_MULTISIG)
      killSwitchEmergencyOperator = await ethers.getImpersonatedSigner(contracts.EMERGENCY_MULTISIG)

      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await killSwitchStonks.getAddress(),
      })

      const expectedBuyAmount = await killSwitchStonks.estimateTradeOutputFromCurrentBalance()
      const tx = await killSwitchStonks.placeOrder(expectedBuyAmount)
      const rc = await tx.wait()
      if (!rc) throw new Error('no rc')
      const evt = await getPlaceOrderData(rc)
      killSwitchOrder = await ethers.getContractAt('Order', evt.address, manager)
      killSwitchOrderHash = await formOrderHashFromTxReceipt(rc)
    })

    it('killSwitch is irreversible, pauses creation and signatures', async function () {
      await killSwitchStonks.connect(killSwitchEmergencyOperator).killSwitch()
      expect(await killSwitchStonks.isKilled()).to.equal(true)
      expect(await killSwitchStonks.isCreationPaused()).to.equal(true)
      expect(await killSwitchStonks.areSignaturesPaused()).to.equal(true)

      const expectedBuyAmount = await killSwitchStonks.estimateTradeOutputFromCurrentBalance()
      await expect(killSwitchStonks.placeOrder(expectedBuyAmount)).to.be.revertedWithCustomError(
        killSwitchStonks,
        'StonksKilled'
      )
      await expect(
        killSwitchOrder.isValidSignature(killSwitchOrderHash, '0x')
      ).to.be.revertedWithCustomError(killSwitchOrder, 'SignaturesGloballyPaused')
    })
  })

  after(async function () {
    await snapshot.restore()
    resetTestOracleRouter()
    resetTestFeedRegistryStub()
  })
})
