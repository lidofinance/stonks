import { ethers } from 'hardhat'
import { Signer } from 'ethers'
import { expect } from 'chai'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import {
  deployStonksWithTestOracle,
  resetTestOracleRouter,
  getTestOracleRouter,
} from '../../utils/test-oracle-router'
import { refreshTestFeedData } from '../../utils/test-feed-registry'
import {
  AmountConverter,
  AssetRecovererTest__factory,
  Stonks,
  Stonks__factory,
  OracleRouter__factory,
  Order,
} from '../../typechain-types'
import { getContracts } from '../../utils/contracts'
import { fillUpERC20FromTreasury } from '../../utils/fill-up-balance'
import { MAX_BASIS_POINTS, MAGIC_VALUE, formOrderHashFromTxReceipt } from '../../utils/gpv2-helpers'
import { getExpectedOut } from '../../utils/chainlink-helpers'
import { getPlaceOrderData } from '../../utils/get-events'
import { simulateNegativeRebase } from '../../utils/test-oracle-router'

const contracts = getContracts()

/**
 * Calculate requiredMinSell exactly as the contract does using Math.mulDiv
 * Math.mulDiv performs (a * b) / c with rounding toward zero (floor division for positive numbers)
 * This matches Solidity's Math.mulDiv behavior
 */
function calculateRequiredMinSell(sellAmount: bigint, minFillBps: bigint): bigint {
  // Math.mulDiv(sellAmount, minFillBps, MAX_BASIS_POINTS)
  // JavaScript floor division matches Solidity's rounding toward zero for positive numbers
  return (sellAmount * minFillBps) / MAX_BASIS_POINTS
}

describe('Stonks', function () {
  let signer: Signer
  let subject: Stonks
  let subjectTokenConverter: AmountConverter
  let snapshot: SnapshotRestorer

  const amount = ethers.parseEther('1')
  const marginInBps = 100

  let ContractFactory: Stonks__factory
  let AssetRecovererFactory: AssetRecovererTest__factory
  let managerAddress: string

  this.beforeAll(async function () {
    signer = (await ethers.getSigners())[0]
    snapshot = await takeSnapshot()

    ContractFactory = await ethers.getContractFactory('Stonks')
    AssetRecovererFactory = await ethers.getContractFactory('AssetRecovererTest')
    managerAddress = await signer.getAddress()

    await refreshTestFeedData([contracts.STETH, contracts.DAI])

    const { stonks, amountConverter: tokenConverter } = await deployStonksWithTestOracle({
      factoryParams: {
        agent: contracts.AGENT,
        relayer: contracts.VAULT_RELAYER,
        settlement: contracts.SETTLEMENT,
        priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
      },
      stonksParams: {
        tokenFrom: contracts.STETH,
        tokenTo: contracts.DAI,
        manager: await signer.getAddress(),
        marginInBps: marginInBps,
        orderDuration: 3600,
        priceToleranceInBps: 100,
        amountConverterAddress: undefined,
      },
      amountConverterParams: {
        allowedTokensToSell: [contracts.STETH],
        allowedStableTokensToBuy: [contracts.DAI],
        useEthAnchor: false,
      },
    })

    subject = stonks
    subjectTokenConverter = tokenConverter
  })

  describe('initialization:', function () {
    const notZeroAddress = '0x0000000000000000000000000000000000000999'

    let validParams: {
      agent: string
      manager: string
      tokenFrom: string
      tokenTo: string
      amountConverter: string
      orderSample: string
      oracleRouter: string
      orderDurationInSeconds: number
      marginInBasisPoints: number
      priceToleranceInBasisPoints: number
      maxImprovementInBasisPoints: bigint
      minFillBps: number
      allowPartialFill: boolean
    }

    this.beforeAll(async function () {
      const oracleRouterFactory = (await ethers.getContractFactory(
        'OracleRouter'
      )) as OracleRouter__factory
      const oracleRouter = await (
        await oracleRouterFactory.deploy(
          contracts.AGENT,
          18,
          contracts.CHAINLINK_PRICE_FEED_REGISTRY
        )
      ).getAddress()

      validParams = {
        agent: contracts.AGENT,
        manager: managerAddress,
        tokenFrom: contracts.STETH,
        tokenTo: contracts.DAI,
        amountConverter: await (subjectTokenConverter as AmountConverter).getAddress(),
        orderSample: notZeroAddress,
        oracleRouter,
        orderDurationInSeconds: 60,
        marginInBasisPoints: 1000,
        priceToleranceInBasisPoints: 999,
        maxImprovementInBasisPoints: 0n,
        minFillBps: 0,
        allowPartialFill: false,
      } as const
    })

    it('should set correct constructor params', async () => {
      const stonks = await ContractFactory.deploy(validParams)

      const [tokenFrom, tokenTo, orderDurationInSeconds] = await stonks.getOrderParameters()
      const priceToleranceInBasisPoints = await stonks.getPriceTolerance()
      const minFillBps = await stonks.MIN_FILL_BPS()

      expect(tokenFrom).to.be.equal(validParams.tokenFrom)
      expect(tokenTo).to.be.equal(validParams.tokenTo)
      expect(orderDurationInSeconds).to.be.equal(validParams.orderDurationInSeconds)
      expect(priceToleranceInBasisPoints).to.be.equal(validParams.priceToleranceInBasisPoints)
      expect(minFillBps).to.be.equal(validParams.minFillBps)
    })

    it('should emit events for every parameter', async () => {
      const stonksLocal = await ContractFactory.deploy(validParams)

      await expect(stonksLocal.deploymentTransaction())
        .to.emit(stonksLocal, 'ManagerSet')
        .withArgs(validParams.manager)
        .and.to.emit(stonksLocal, 'AmountConverterSet')
        .withArgs(validParams.amountConverter)
        .and.to.emit(stonksLocal, 'OrderSampleSet')
        .withArgs(validParams.orderSample)
        .and.to.emit(stonksLocal, 'TokenFromSet')
        .withArgs(validParams.tokenFrom)
        .and.to.emit(stonksLocal, 'TokenToSet')
        .withArgs(validParams.tokenTo)
        .and.to.emit(stonksLocal, 'OrderDurationInSecondsSet')
        .withArgs(validParams.orderDurationInSeconds)
        .and.to.emit(stonksLocal, 'MarginInBasisPointsSet')
        .withArgs(validParams.marginInBasisPoints)
        .and.to.emit(stonksLocal, 'PriceToleranceInBasisPointsSet')
        .withArgs(validParams.priceToleranceInBasisPoints)
    })

    it('should not initialize with agent zero address', async function () {
      await expect(
        ContractFactory.deploy({
          ...validParams,
          agent: ethers.ZeroAddress,
        })
      )
        .to.be.revertedWithCustomError(AssetRecovererFactory, 'InvalidAgentAddress')
        .withArgs(ethers.ZeroAddress)
    })
    it('should not initialize with manager zero address', async function () {
      await expect(
        ContractFactory.deploy({
          ...validParams,
          manager: ethers.ZeroAddress,
        })
      )
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidManagerAddress')
        .withArgs(ethers.ZeroAddress)
    })
    it('should not initialize with tokenFrom zero address', async function () {
      await expect(
        ContractFactory.deploy({
          ...validParams,
          tokenFrom: ethers.ZeroAddress,
        })
      )
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidTokenFromAddress')
        .withArgs(ethers.ZeroAddress)
    })
    it('should not initialize with tokenTo zero address', async function () {
      await expect(
        ContractFactory.deploy({
          ...validParams,
          tokenTo: ethers.ZeroAddress,
        })
      )
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidTokenToAddress')
        .withArgs(ethers.ZeroAddress)
    })
    it('should not initialize with same tokens address', async function () {
      await expect(
        ContractFactory.deploy({
          ...validParams,
          tokenFrom: contracts.STETH,
          tokenTo: contracts.STETH,
        })
      ).to.be.revertedWithCustomError(ContractFactory, 'TokensCannotBeSame')
    })
    it('should not initialize with amountConverter zero address', async function () {
      await expect(
        ContractFactory.deploy({
          ...validParams,
          amountConverter: ethers.ZeroAddress,
        })
      )
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidAmountConverterAddress')
        .withArgs(ethers.ZeroAddress)
    })
    it('should not initialize with orderSample zero address', async function () {
      await expect(
        ContractFactory.deploy({
          ...validParams,
          orderSample: ethers.ZeroAddress,
        })
      )
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidOrderSampleAddress')
        .withArgs(ethers.ZeroAddress)
    })
    it('should not initialize with orderDurationInSeconds less than 60', async function () {
      await expect(
        ContractFactory.deploy({
          ...validParams,
          orderDurationInSeconds: 59,
        })
      )
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidOrderDuration')
        .withArgs(60, 86400, 59)
    })
    it('should not initialize with orderDurationInSeconds more than day', async function () {
      await expect(
        ContractFactory.deploy({
          ...validParams,
          orderDurationInSeconds: 60 * 60 * 24 + 1,
        })
      )
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidOrderDuration')
        .withArgs(60, 86400, 86401)
    })
    it('should not initialize with marginInBasisPoints_ less or equal 1000', async function () {
      await expect(
        ContractFactory.deploy({
          ...validParams,
          marginInBasisPoints: 1001,
        })
      )
        .to.be.revertedWithCustomError(ContractFactory, 'MarginOverflowsAllowedLimit')
        .withArgs(1000, 1001)
    })
    it('should not initialize with priceToleranceInBasisPoints_ less or equal 1000', async function () {
      await expect(
        ContractFactory.deploy({
          ...validParams,
          priceToleranceInBasisPoints: 1001,
        })
      )
        .to.be.revertedWithCustomError(ContractFactory, 'PriceToleranceOverflowsAllowedLimit')
        .withArgs(1000, 1001)
    })
    it('should not initialize with maxImprovementInBasisPoints_ over limit (when not type(uint256).max)', async function () {
      await expect(
        ContractFactory.deploy({
          ...validParams,
          maxImprovementInBasisPoints: 1001n,
        })
      )
        .to.be.revertedWithCustomError(ContractFactory, 'MarginOverflowsAllowedLimit')
        .withArgs(1000, 1001)
    })
    it('should allow maxImprovementInBasisPoints_ equal to type(uint256).max', async function () {
      const stonks = await ContractFactory.deploy({
        ...validParams,
        maxImprovementInBasisPoints: ethers.MaxUint256,
      })
      await stonks.waitForDeployment()
      expect(await stonks.getMaxImprovementBps()).to.equal(ethers.MaxUint256)
    })
    it('should not initialize with oracleRouter zero address', async function () {
      await expect(
        ContractFactory.deploy({
          ...validParams,
          oracleRouter: ethers.ZeroAddress,
        })
      )
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidOracleRouterAddress')
        .withArgs(ethers.ZeroAddress)
    })

    it('should not initialize with minFillBps_ greater than MAX_BASIS_POINTS', async function () {
      await expect(
        ContractFactory.deploy({
          ...validParams,
          minFillBps: 10001,
        })
      )
        .to.be.revertedWithCustomError(ContractFactory, 'MinFillOverflowsAllowedLimit')
        .withArgs(10000, 10001)
    })

    it('should allow minFillBps_ equal to MAX_BASIS_POINTS', async function () {
      const stonks = await ContractFactory.deploy({
        ...validParams,
        minFillBps: 10000,
      })
      await stonks.waitForDeployment()
      expect(await stonks.MIN_FILL_BPS()).to.equal(10000)
    })

    it('should allow minFillBps_ equal to 0', async function () {
      const stonks = await ContractFactory.deploy({
        ...validParams,
        minFillBps: 0,
      })
      await stonks.waitForDeployment()
      expect(await stonks.MIN_FILL_BPS()).to.equal(0)
    })

    it('should return correct minFillBps via MIN_FILL_BPS getter', async function () {
      const testMinFillBps = 5000
      const stonks = await ContractFactory.deploy({
        ...validParams,
        minFillBps: testMinFillBps,
      })
      await stonks.waitForDeployment()
      expect(await stonks.MIN_FILL_BPS()).to.equal(testMinFillBps)
    })

    it('should allow minFillBps_ equal to 1 (minimum non-zero)', async function () {
      const stonks = await ContractFactory.deploy({
        ...validParams,
        minFillBps: 1,
      })
      await stonks.waitForDeployment()
      expect(await stonks.MIN_FILL_BPS()).to.equal(1)
    })

    it('should allow minFillBps_ equal to 9999 (just below max)', async function () {
      const stonks = await ContractFactory.deploy({
        ...validParams,
        minFillBps: 9999,
      })
      await stonks.waitForDeployment()
      expect(await stonks.MIN_FILL_BPS()).to.equal(9999)
    })
  })

  describe('estimateTradeOutput:', function () {
    it('should revert if amount is zero', async function () {
      await expect(subject.estimateTradeOutput(0)).to.be.revertedWithCustomError(
        subject,
        'InvalidAmount'
      )
    })
    it('should return correct amount with margin included', async function () {
      const amount = ethers.parseEther('1')
      const expectedOut = await getExpectedOut(contracts.STETH, contracts.DAI, amount)
      const expectedOutWithMargin =
        (expectedOut * (MAX_BASIS_POINTS - BigInt(marginInBps))) / MAX_BASIS_POINTS

      expect(await subject.estimateTradeOutput(amount)).to.equal(expectedOutWithMargin)
    })
  })

  describe('estimateTradeOutputFromCurrentBalance:', function () {
    it('should return correct amount with margin included', async function () {
      const localSnapshot = await takeSnapshot()
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await subject.getAddress(),
      })
      const amount = await (
        await ethers.getContractAt('IERC20', contracts.STETH, signer)
      ).balanceOf(subject)
      const expectedOut = await getExpectedOut(contracts.STETH, contracts.DAI, amount)
      const expectedOutWithMargin =
        (expectedOut * (MAX_BASIS_POINTS - BigInt(marginInBps))) / MAX_BASIS_POINTS

      expect(await subject.estimateTradeOutputFromCurrentBalance()).to.equal(expectedOutWithMargin)
      await localSnapshot.restore()
    })
    it('should revert if balance is zero', async () => {
      await expect(subject.estimateTradeOutputFromCurrentBalance()).to.be.revertedWithCustomError(
        subject,
        'InvalidAmount'
      )
    })
  })

  describe('order placement:', function () {
    it('should revert when balance is zero', async function () {
      await expect(subject.placeOrder(100)).to.be.revertedWithCustomError(
        subject,
        'MinimumPossibleBalanceNotMet'
      )
    })

    it('should revert when tokens are not quotable', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks with tokens first (before deactivating)
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await subject.getAddress(),
      })

      // Get expected buy amount before deactivating tokens
      const expectedBuyAmount = await subject.estimateTradeOutputFromCurrentBalance()

      // Deactivate tokens in router to make them unquotable
      const oracleRouter = await ethers.getContractAt('OracleRouter', await subject.ORACLE_ROUTER())
      const agentSigner = await ethers.getImpersonatedSigner(contracts.AGENT)
      await ethers.provider.send('hardhat_setBalance', [contracts.AGENT, '0x1000000000000000000'])

      const [tokenFrom, tokenTo] = await subject.getOrderParameters()
      await oracleRouter.connect(agentSigner).setTokenActive(tokenFrom, false)
      await oracleRouter.connect(agentSigner).setTokenActive(tokenTo, false)

      // Should revert when trying to place order because assertQuotable fails
      // The revert happens during Order.initialize when it calls assertQuotable
      // which calls router.getUsdPrices, which reverts with TokenNotConfigured
      await expect(subject.placeOrder(expectedBuyAmount)).to.be.reverted

      await localSnapshot.restore()
    })

    it('should place order', async function () {
      const steth = await ethers.getContractAt('IERC20', contracts.STETH, signer)

      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount,
        address: await subject.getAddress(),
      })
      expect(await steth.balanceOf(subject)).to.be.closeTo(amount, 2n)

      const expectedBuyAmount = await subject.estimateTradeOutputFromCurrentBalance()
      const tx = await subject.placeOrder(expectedBuyAmount)
      await tx.wait()
    })

    it('placeOrderWithAmount sends only specified amount', async function () {
      const steth = await ethers.getContractAt('IERC20', contracts.STETH, signer)
      const stonksAddr = await subject.getAddress()

      // fund 3 ETH
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('3'),
        address: stonksAddr,
      })

      const beforeBalance = await steth.balanceOf(stonksAddr)
      const sellAmount = ethers.parseEther('1')
      const minBuy = await subject.estimateTradeOutput(sellAmount)

      const tx = await subject.placeOrderWithAmount(sellAmount, minBuy)
      const rc = await tx.wait()
      expect(rc?.status).to.equal(1)

      const afterBalance = await steth.balanceOf(stonksAddr)
      const diff = beforeBalance - afterBalance
      expect(diff).to.be.closeTo(sellAmount, 1n)
    })

    it('placeOrderWithAmount reverts when amount below MIN_POSSIBLE_BALANCE', async function () {
      const tooSmall = 9n // MIN_POSSIBLE_BALANCE = 10
      await expect(subject.placeOrderWithAmount(tooSmall, 1)).to.be.revertedWithCustomError(
        subject,
        'MinimumPossibleBalanceNotMet'
      )
    })

    it('placeOrderWithAmount reverts when requested exceeds balance', async function () {
      const steth = await ethers.getContractAt('IERC20', contracts.STETH, signer)
      const bal = await steth.balanceOf(subject)
      const requested = bal + 1n
      await expect(subject.placeOrderWithAmount(requested, 1)).to.be.revertedWithCustomError(
        subject,
        'SellAmountExceedsBalance'
      )
    })

    it('placeOrderWithAmount reverts when minBuyAmount is zero', async function () {
      await expect(
        subject.placeOrderWithAmount(ethers.parseEther('1'), 0)
      ).to.be.revertedWithCustomError(subject, 'InvalidAmount')
    })

    it('placeOrderWithAmount with exact balance should succeed', async function () {
      const localSnapshot = await takeSnapshot()

      const steth = await ethers.getContractAt('IERC20', contracts.STETH, signer)
      const exactBalance = ethers.parseEther('1')

      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: exactBalance,
        address: await subject.getAddress(),
      })

      const balance = await steth.balanceOf(await subject.getAddress())
      const minBuy = await subject.estimateTradeOutput(balance)

      const tx = await subject.placeOrderWithAmount(balance, minBuy)
      const rc = await tx.wait()
      expect(rc?.status).to.equal(1)

      const afterBalance = await steth.balanceOf(await subject.getAddress())
      // Allow small tolerance for stETH rounding (shares-based accounting)
      expect(afterBalance).to.be.lte(4n)

      await localSnapshot.restore()
    })

    it('placeOrderWithAmount with minBuyAmount exceeding estimated output should use Math.max', async function () {
      const localSnapshot = await takeSnapshot()

      const sellAmount = ethers.parseEther('1')
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: sellAmount,
        address: await subject.getAddress(),
      })

      const estimatedOutput = await subject.estimateTradeOutput(sellAmount)
      const veryHighMinBuy = estimatedOutput * 2n

      // Should succeed because Order.initialize uses Math.max(estimated, minBuyAmount)
      // So it will use estimatedOutput, not the veryHighMinBuy
      const tx = await subject.placeOrderWithAmount(sellAmount, veryHighMinBuy)
      const rc = await tx.wait()
      expect(rc?.status).to.equal(1)

      await localSnapshot.restore()
    })
  })

  describe('MIN_FILL_BPS with ALLOW_PARTIAL_FILL = false:', function () {
    let stonksNoPartialFillMinFill0: Stonks
    let stonksNoPartialFillMinFill50: Stonks
    let snapshot: SnapshotRestorer

    this.beforeAll(async function () {
      snapshot = await takeSnapshot()
      await refreshTestFeedData([contracts.STETH, contracts.DAI])

      // Deploy Stonks with ALLOW_PARTIAL_FILL = false and minFillBps = 0
      const { stonks: stonks0 } = await deployStonksWithTestOracle({
        factoryParams: {
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: contracts.STETH,
          tokenTo: contracts.DAI,
          manager: await signer.getAddress(),
          marginInBps: marginInBps,
          orderDuration: 3600,
          priceToleranceInBps: 100,
          minFillBps: 0,
          allowPartialFill: false,
          amountConverterAddress: undefined,
        },
        amountConverterParams: {
          allowedTokensToSell: [contracts.STETH],
          allowedStableTokensToBuy: [contracts.DAI],
          useEthAnchor: false,
        },
      })

      // Deploy Stonks with ALLOW_PARTIAL_FILL = false and minFillBps = 5000 (50%)
      const { stonks: stonks50 } = await deployStonksWithTestOracle({
        factoryParams: {
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: contracts.STETH,
          tokenTo: contracts.DAI,
          manager: await signer.getAddress(),
          marginInBps: marginInBps,
          orderDuration: 3600,
          priceToleranceInBps: 100,
          minFillBps: 5000,
          allowPartialFill: false,
          amountConverterAddress: undefined,
        },
        amountConverterParams: {
          allowedTokensToSell: [contracts.STETH],
          allowedStableTokensToBuy: [contracts.DAI],
          useEthAnchor: false,
        },
      })

      stonksNoPartialFillMinFill0 = stonks0
      stonksNoPartialFillMinFill50 = stonks50
    })

    it('should require full fill when partial fills disabled and minFillBps = 0', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksNoPartialFillMinFill0.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksNoPartialFillMinFill0.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksNoPartialFillMinFill0.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)

      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      const [tokenFrom] = await stonksNoPartialFillMinFill0.getOrderParameters()
      const orderAddress = await order.getAddress()
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = initialBalance / 10n

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const newBalance = await token.balanceOf(orderAddress)
      const expectedBalanceAfterRebase = initialBalance - rebaseAmount
      // Account for stETH shares rounding (within 2 wei tolerance)
      expect(newBalance).to.be.closeTo(expectedBalanceAfterRebase, 2n)

      // Since newBalance < sellAmount, it should revert with InsufficientSellBalance
      // Contract passes sellAmount (not calculated from minFillBps) as the required parameter
      const contractRequiredAmount = sellAmount
      expect(newBalance).to.be.lessThan(contractRequiredAmount)

      // minFillBps should be ignored when ALLOW_PARTIAL_FILL = false
      await expect(order.isValidSignature(orderHash, '0x'))
        .to.be.revertedWithCustomError(order, 'InsufficientSellBalance')
        .withArgs(sellAmount, newBalance)

      await localSnapshot.restore()
    })

    it('should require full fill when partial fills disabled and minFillBps > 0 (minFillBps ignored)', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksNoPartialFillMinFill50.getAddress(),
      })

      expect(await stonksNoPartialFillMinFill50.MIN_FILL_BPS()).to.equal(5000)
      expect(await stonksNoPartialFillMinFill50.ALLOW_PARTIAL_FILL()).to.equal(false)

      // Place order
      const expectedBuyAmount =
        await stonksNoPartialFillMinFill50.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksNoPartialFillMinFill50.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)

      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      // Get order details and token balances
      const [tokenFrom] = await stonksNoPartialFillMinFill50.getOrderParameters()
      const orderAddress = await order.getAddress()
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]
      const token = await ethers.getContractAt('IERC20', tokenFrom)

      // Get current balance (might differ slightly from sellAmount due to stETH shares)
      const initialBalance = await token.balanceOf(orderAddress)

      // Use initialBalance to ensure we don't transfer more than available
      const rebaseAmount = initialBalance / 10n

      // Ensure we have enough balance to transfer
      expect(initialBalance).to.be.greaterThan(rebaseAmount)

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const newBalance = await token.balanceOf(orderAddress)
      const expectedBalanceAfterRebase = initialBalance - rebaseAmount

      // Allow small tolerance for stETH shares rounding (within 2 wei)
      expect(newBalance).to.be.closeTo(expectedBalanceAfterRebase, 2n)

      const minFillRequirement = calculateRequiredMinSell(sellAmount, 5000n)
      expect(newBalance).to.be.greaterThan(minFillRequirement)
      expect(newBalance).to.be.lessThan(sellAmount)

      await expect(order.isValidSignature(orderHash, '0x'))
        .to.be.revertedWithCustomError(order, 'InsufficientSellBalance')
        .withArgs(sellAmount, newBalance)

      await localSnapshot.restore()
    })

    it('should accept order with full balance when partial fills disabled regardless of minFillBps', async function () {
      const localSnapshot = await takeSnapshot()

      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksNoPartialFillMinFill50.getAddress(),
      })

      const expectedBuyAmount =
        await stonksNoPartialFillMinFill50.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksNoPartialFillMinFill50.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)

      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      await localSnapshot.restore()
    })

    this.afterAll(async function () {
      await snapshot.restore()
    })
  })

  describe('MIN_FILL_BPS with ALLOW_PARTIAL_FILL = true and minFillBps = 0:', function () {
    let stonksPartialFillMinFill0: Stonks
    let snapshot: SnapshotRestorer

    this.beforeAll(async function () {
      snapshot = await takeSnapshot()
      await refreshTestFeedData([contracts.STETH, contracts.DAI])

      // Deploy Stonks with ALLOW_PARTIAL_FILL = true and minFillBps = 0
      const { stonks } = await deployStonksWithTestOracle({
        factoryParams: {
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: contracts.STETH,
          tokenTo: contracts.DAI,
          manager: await signer.getAddress(),
          marginInBps: marginInBps,
          orderDuration: 3600,
          priceToleranceInBps: 100,
          minFillBps: 0,
          allowPartialFill: true,
          amountConverterAddress: undefined,
        },
        amountConverterParams: {
          allowedTokensToSell: [contracts.STETH],
          allowedStableTokensToBuy: [contracts.DAI],
          useEthAnchor: false,
        },
      })

      stonksPartialFillMinFill0 = stonks
    })

    it('should accept any partial fill when minFillBps = 0 (no minimum requirement)', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill0.getAddress(),
      })

      expect(await stonksPartialFillMinFill0.MIN_FILL_BPS()).to.equal(0)
      expect(await stonksPartialFillMinFill0.ALLOW_PARTIAL_FILL()).to.equal(true)

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill0.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill0.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)

      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      const [tokenFrom] = await stonksPartialFillMinFill0.getOrderParameters()
      const orderAddress = await order.getAddress()
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)

      const rebaseAmount = (initialBalance * 9000n) / 10000n

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const newBalance = await token.balanceOf(orderAddress)
      const expectedBalanceAfterRebase = initialBalance - rebaseAmount
      expect(newBalance).to.be.closeTo(expectedBalanceAfterRebase, 2n)
      expect(newBalance).to.be.lessThan(sellAmount)

      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      await localSnapshot.restore()
    })

    it('should accept very small partial fill when minFillBps = 0', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill0.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill0.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill0.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)

      const [tokenFrom] = await stonksPartialFillMinFill0.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)

      const rebaseAmount = (initialBalance * 9900n) / 10000n

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const expectedBalanceAfterRebase = initialBalance - rebaseAmount
      const newBalance = await token.balanceOf(orderAddress)
      expect(newBalance).to.be.closeTo(expectedBalanceAfterRebase, 2n)
      expect(newBalance).to.be.lessThan(initialBalance / 50n)

      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      await localSnapshot.restore()
    })

    it('should accept exact sellAmount fill when minFillBps = 0', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill0.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill0.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill0.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const [tokenFrom] = await stonksPartialFillMinFill0.getOrderParameters()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const orderAddress = await order.getAddress()
      const balance = await token.balanceOf(orderAddress)

      // Balance should be close to sellAmount (within tolerance for stETH shares)
      expect(balance).to.be.closeTo(sellAmount, 2n)

      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      await localSnapshot.restore()
    })

    it('should accept fill above sellAmount when minFillBps = 0', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks with more than needed
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill0.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill0.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill0.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)

      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      await localSnapshot.restore()
    })

    it('should have no minimum fill requirement when minFillBps = 0', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill0.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill0.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill0.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const [tokenFrom] = await stonksPartialFillMinFill0.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)

      let rebaseAmount = initialBalance / 2n
      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)
      const expectedBalance50 = initialBalance - rebaseAmount
      let balance50 = await token.balanceOf(orderAddress)
      expect(balance50).to.be.closeTo(expectedBalance50, 2n)
      expect(balance50).to.be.lessThan(sellAmount)
      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      const balanceBefore10 = await token.balanceOf(orderAddress)
      rebaseAmount = (balanceBefore10 * 9000n) / 10000n
      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)
      const expectedBalance10 = balanceBefore10 - rebaseAmount
      let balance10 = await token.balanceOf(orderAddress)
      expect(balance10).to.be.closeTo(expectedBalance10, 2n)
      expect(balance10).to.be.lessThan(sellAmount)
      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      await localSnapshot.restore()
    })

    this.afterAll(async function () {
      await snapshot.restore()
    })
  })

  describe('MIN_FILL_BPS with ALLOW_PARTIAL_FILL = true and minFillBps > 0:', function () {
    let stonksPartialFillMinFill50: Stonks
    let stonksPartialFillMinFill10: Stonks
    let stonksPartialFillMinFill99: Stonks
    let snapshot: SnapshotRestorer

    this.beforeAll(async function () {
      snapshot = await takeSnapshot()
      await refreshTestFeedData([contracts.STETH, contracts.DAI])

      // Deploy Stonks with ALLOW_PARTIAL_FILL = true and minFillBps = 5000 (50%)
      const { stonks: stonks50 } = await deployStonksWithTestOracle({
        factoryParams: {
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: contracts.STETH,
          tokenTo: contracts.DAI,
          manager: await signer.getAddress(),
          marginInBps: marginInBps,
          orderDuration: 3600,
          priceToleranceInBps: 100,
          minFillBps: 5000,
          allowPartialFill: true,
          amountConverterAddress: undefined,
        },
        amountConverterParams: {
          allowedTokensToSell: [contracts.STETH],
          allowedStableTokensToBuy: [contracts.DAI],
          useEthAnchor: false,
        },
      })

      // Deploy Stonks with ALLOW_PARTIAL_FILL = true and minFillBps = 1000 (10%)
      const { stonks: stonks10 } = await deployStonksWithTestOracle({
        factoryParams: {
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: contracts.STETH,
          tokenTo: contracts.DAI,
          manager: await signer.getAddress(),
          marginInBps: marginInBps,
          orderDuration: 3600,
          priceToleranceInBps: 100,
          minFillBps: 1000,
          allowPartialFill: true,
          amountConverterAddress: undefined,
        },
        amountConverterParams: {
          allowedTokensToSell: [contracts.STETH],
          allowedStableTokensToBuy: [contracts.DAI],
          useEthAnchor: false,
        },
      })

      // Deploy Stonks with ALLOW_PARTIAL_FILL = true and minFillBps = 9900 (99%)
      const { stonks: stonks99 } = await deployStonksWithTestOracle({
        factoryParams: {
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: contracts.STETH,
          tokenTo: contracts.DAI,
          manager: await signer.getAddress(),
          marginInBps: marginInBps,
          orderDuration: 3600,
          priceToleranceInBps: 100,
          minFillBps: 9900,
          allowPartialFill: true,
          amountConverterAddress: undefined,
        },
        amountConverterParams: {
          allowedTokensToSell: [contracts.STETH],
          allowedStableTokensToBuy: [contracts.DAI],
          useEthAnchor: false,
        },
      })

      stonksPartialFillMinFill50 = stonks50
      stonksPartialFillMinFill10 = stonks10
      stonksPartialFillMinFill99 = stonks99
    })

    it('should accept order when balance exactly meets minFillBps requirement (50%)', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill50.getAddress(),
      })

      expect(await stonksPartialFillMinFill50.MIN_FILL_BPS()).to.equal(5000)
      expect(await stonksPartialFillMinFill50.ALLOW_PARTIAL_FILL()).to.equal(true)

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill50.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill50.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const requiredMinSell = calculateRequiredMinSell(sellAmount, 5000n)

      const [tokenFrom] = await stonksPartialFillMinFill50.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = initialBalance / 2n

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const expectedBalanceAfterRebase = initialBalance - rebaseAmount
      const newBalance = await token.balanceOf(orderAddress)
      expect(newBalance).to.be.closeTo(expectedBalanceAfterRebase, 2n)
      expect(newBalance).to.be.closeTo(requiredMinSell, 2n) // Should be at required minimum

      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      await localSnapshot.restore()
    })

    it('should accept order when balance exceeds minFillBps requirement (50%)', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill50.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill50.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill50.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const requiredMinSell = calculateRequiredMinSell(sellAmount, 5000n)

      const [tokenFrom] = await stonksPartialFillMinFill50.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = (initialBalance * 4000n) / 10000n

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const expectedBalanceAfterRebase = initialBalance - rebaseAmount
      const newBalance = await token.balanceOf(orderAddress)
      expect(newBalance).to.be.closeTo(expectedBalanceAfterRebase, 2n)

      const balancePercentageBps = (newBalance * MAX_BASIS_POINTS) / sellAmount
      const expectedBalancePercentageBps =
        (expectedBalanceAfterRebase * MAX_BASIS_POINTS) / sellAmount
      expect(balancePercentageBps).to.be.closeTo(expectedBalancePercentageBps, 2n)
      expect(balancePercentageBps).to.be.greaterThan(5000n)

      const excessOverRequired = newBalance - requiredMinSell
      const expectedExcess = expectedBalanceAfterRebase - requiredMinSell
      expect(excessOverRequired).to.be.closeTo(expectedExcess, 2n)
      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      await localSnapshot.restore()
    })

    it('should revert when balance is below minFillBps requirement (50%)', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill50.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill50.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill50.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const requiredMinSell = calculateRequiredMinSell(sellAmount, 5000n)

      const [tokenFrom] = await stonksPartialFillMinFill50.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = (initialBalance * 6000n) / 10000n

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const expectedBalanceAfterRebase = initialBalance - rebaseAmount
      const newBalance = await token.balanceOf(orderAddress)
      expect(newBalance).to.be.closeTo(expectedBalanceAfterRebase, 2n)

      const balancePercentageBps = (newBalance * MAX_BASIS_POINTS) / sellAmount
      const expectedBalancePercentageBps =
        (expectedBalanceAfterRebase * MAX_BASIS_POINTS) / sellAmount
      expect(balancePercentageBps).to.be.closeTo(expectedBalancePercentageBps, 2n)
      expect(balancePercentageBps).to.be.lessThan(5000n)

      const shortfall = requiredMinSell - newBalance
      const expectedShortfall = requiredMinSell - expectedBalanceAfterRebase
      expect(shortfall).to.be.closeTo(expectedShortfall, 2n)
      await expect(order.isValidSignature(orderHash, '0x'))
        .to.be.revertedWithCustomError(order, 'InsufficientSellBalance')
        .withArgs(requiredMinSell, newBalance)

      await localSnapshot.restore()
    })

    it('should accept order with minFillBps = 10% when balance meets requirement', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill10.getAddress(),
      })

      expect(await stonksPartialFillMinFill10.MIN_FILL_BPS()).to.equal(1000)
      expect(await stonksPartialFillMinFill10.ALLOW_PARTIAL_FILL()).to.equal(true)

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill10.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill10.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const requiredMinSell = calculateRequiredMinSell(sellAmount, 1000n)

      const [tokenFrom] = await stonksPartialFillMinFill10.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = (initialBalance * 8000n) / 10000n

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const expectedBalanceAfterRebase = initialBalance - rebaseAmount
      const newBalance = await token.balanceOf(orderAddress)
      expect(newBalance).to.be.closeTo(expectedBalanceAfterRebase, 2n)
      const balancePercentageBps = (newBalance * MAX_BASIS_POINTS) / sellAmount
      const expectedBalancePercentageBps =
        (expectedBalanceAfterRebase * MAX_BASIS_POINTS) / sellAmount
      expect(balancePercentageBps).to.be.closeTo(expectedBalancePercentageBps, 2n)
      expect(balancePercentageBps).to.be.greaterThan(1000n)
      const excessOverRequired = newBalance - requiredMinSell
      const expectedExcess = expectedBalanceAfterRebase - requiredMinSell
      expect(excessOverRequired).to.be.closeTo(expectedExcess, 2n)

      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      await localSnapshot.restore()
    })

    it('should revert with minFillBps = 10% when balance is below requirement', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill10.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill10.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill10.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const requiredMinSell = calculateRequiredMinSell(sellAmount, 1000n)

      const [tokenFrom] = await stonksPartialFillMinFill10.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = (initialBalance * 9500n) / 10000n

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const expectedBalanceAfterRebase = initialBalance - rebaseAmount
      const newBalance = await token.balanceOf(orderAddress)
      expect(newBalance).to.be.closeTo(expectedBalanceAfterRebase, 2n)
      const balancePercentageBps = (newBalance * MAX_BASIS_POINTS) / sellAmount
      const expectedBalancePercentageBps =
        (expectedBalanceAfterRebase * MAX_BASIS_POINTS) / sellAmount
      expect(balancePercentageBps).to.be.closeTo(expectedBalancePercentageBps, 2n)
      expect(balancePercentageBps).to.be.lessThan(1000n)
      const shortfall = requiredMinSell - newBalance
      const expectedShortfall = requiredMinSell - expectedBalanceAfterRebase
      expect(shortfall).to.be.closeTo(expectedShortfall, 2n)

      await expect(order.isValidSignature(orderHash, '0x'))
        .to.be.revertedWithCustomError(order, 'InsufficientSellBalance')
        .withArgs(requiredMinSell, newBalance)

      await localSnapshot.restore()
    })

    it('should accept order with minFillBps = 99% when balance meets requirement', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill99.getAddress(),
      })

      expect(await stonksPartialFillMinFill99.MIN_FILL_BPS()).to.equal(9900)
      expect(await stonksPartialFillMinFill99.ALLOW_PARTIAL_FILL()).to.equal(true)

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill99.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill99.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const requiredMinSell = calculateRequiredMinSell(sellAmount, 9900n)

      const [tokenFrom] = await stonksPartialFillMinFill99.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = (initialBalance * 50n) / 10000n

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const expectedBalanceAfterRebase = initialBalance - rebaseAmount
      const newBalance = await token.balanceOf(orderAddress)
      expect(newBalance).to.be.closeTo(expectedBalanceAfterRebase, 2n)
      const balancePercentageBps = (newBalance * MAX_BASIS_POINTS) / sellAmount
      const expectedBalancePercentageBps =
        (expectedBalanceAfterRebase * MAX_BASIS_POINTS) / sellAmount
      expect(balancePercentageBps).to.be.closeTo(expectedBalancePercentageBps, 2n)
      expect(balancePercentageBps).to.be.greaterThan(9900n)
      const excessOverRequired = newBalance - requiredMinSell
      const expectedExcess = expectedBalanceAfterRebase - requiredMinSell
      expect(excessOverRequired).to.be.closeTo(expectedExcess, 2n)
      expect(newBalance).to.be.lessThan(sellAmount)

      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      await localSnapshot.restore()
    })

    it('should revert with minFillBps = 99% when balance is below requirement', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill99.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill99.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill99.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const requiredMinSell = calculateRequiredMinSell(sellAmount, 9900n)

      const [tokenFrom] = await stonksPartialFillMinFill99.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = (initialBalance * 200n) / 10000n

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const expectedBalanceAfterRebase = initialBalance - rebaseAmount
      const newBalance = await token.balanceOf(orderAddress)
      expect(newBalance).to.be.closeTo(expectedBalanceAfterRebase, 2n)
      const balancePercentageBps = (newBalance * MAX_BASIS_POINTS) / sellAmount
      const expectedBalancePercentageBps =
        (expectedBalanceAfterRebase * MAX_BASIS_POINTS) / sellAmount
      expect(balancePercentageBps).to.be.closeTo(expectedBalancePercentageBps, 2n)
      expect(balancePercentageBps).to.be.lessThan(9900n)
      expect(balancePercentageBps).to.be.greaterThan(9700n)
      const shortfall = requiredMinSell - newBalance
      const expectedShortfall = requiredMinSell - expectedBalanceAfterRebase
      expect(shortfall).to.be.closeTo(expectedShortfall, 2n)
      const requiredMinSell97 = calculateRequiredMinSell(sellAmount, 9700n)
      expect(newBalance).to.be.greaterThan(requiredMinSell97)

      await expect(order.isValidSignature(orderHash, '0x'))
        .to.be.revertedWithCustomError(order, 'InsufficientSellBalance')
        .withArgs(requiredMinSell, newBalance)

      await localSnapshot.restore()
    })

    it('should handle boundary condition: balance just above minFillBps requirement', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill50.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill50.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill50.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const requiredMinSell = calculateRequiredMinSell(sellAmount, 5000n)

      const [tokenFrom] = await stonksPartialFillMinFill50.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = (initialBalance * 4990n) / 10000n

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const expectedBalanceAfterRebase = initialBalance - rebaseAmount
      const newBalance = await token.balanceOf(orderAddress)
      expect(newBalance).to.be.closeTo(expectedBalanceAfterRebase, 2n)
      const balancePercentageBps = (newBalance * MAX_BASIS_POINTS) / sellAmount
      const expectedBalancePercentageBps =
        (expectedBalanceAfterRebase * MAX_BASIS_POINTS) / sellAmount
      expect(balancePercentageBps).to.be.closeTo(expectedBalancePercentageBps, 2n)
      expect(balancePercentageBps).to.be.greaterThan(5000n)
      const excessOverRequired = newBalance - requiredMinSell
      const expectedExcess = expectedBalanceAfterRebase - requiredMinSell
      expect(excessOverRequired).to.be.closeTo(expectedExcess, 2n)

      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      await localSnapshot.restore()
    })

    it('should handle boundary condition: balance exactly at minFillBps requirement (with rounding)', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill50.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill50.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill50.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const requiredMinSell = calculateRequiredMinSell(sellAmount, 5000n)

      const [tokenFrom] = await stonksPartialFillMinFill50.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = initialBalance / 2n

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const expectedBalanceAfterRebase = initialBalance - rebaseAmount
      const newBalance = await token.balanceOf(orderAddress)
      expect(newBalance).to.be.closeTo(expectedBalanceAfterRebase, 2n)
      expect(newBalance).to.be.closeTo(requiredMinSell, 2n)

      // (Math.mulDiv rounding may cause slight variations, but >= requiredMinSell should pass)
      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      await localSnapshot.restore()
    })

    this.afterAll(async function () {
      await snapshot.restore()
    })
  })

  describe('MIN_FILL_BPS with Rebasable Tokens (stETH):', function () {
    let stonksPartialFillMinFill0: Stonks
    let stonksPartialFillMinFill50: Stonks
    let stonksPartialFillMinFill90: Stonks
    let snapshot: SnapshotRestorer

    this.beforeAll(async function () {
      snapshot = await takeSnapshot()
      await refreshTestFeedData([contracts.STETH, contracts.DAI])

      // Deploy Stonks with ALLOW_PARTIAL_FILL = true and minFillBps = 0
      const { stonks: stonks0 } = await deployStonksWithTestOracle({
        factoryParams: {
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: contracts.STETH,
          tokenTo: contracts.DAI,
          manager: await signer.getAddress(),
          marginInBps: marginInBps,
          orderDuration: 3600,
          priceToleranceInBps: 100,
          minFillBps: 0,
          allowPartialFill: true,
          amountConverterAddress: undefined,
        },
        amountConverterParams: {
          allowedTokensToSell: [contracts.STETH],
          allowedStableTokensToBuy: [contracts.DAI],
          useEthAnchor: false,
        },
      })

      // Deploy Stonks with ALLOW_PARTIAL_FILL = true and minFillBps = 5000 (50%)
      const { stonks: stonks50 } = await deployStonksWithTestOracle({
        factoryParams: {
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: contracts.STETH,
          tokenTo: contracts.DAI,
          manager: await signer.getAddress(),
          marginInBps: marginInBps,
          orderDuration: 3600,
          priceToleranceInBps: 100,
          minFillBps: 5000,
          allowPartialFill: true,
          amountConverterAddress: undefined,
        },
        amountConverterParams: {
          allowedTokensToSell: [contracts.STETH],
          allowedStableTokensToBuy: [contracts.DAI],
          useEthAnchor: false,
        },
      })

      // Deploy Stonks with ALLOW_PARTIAL_FILL = true and minFillBps = 9000 (90%)
      const { stonks: stonks90 } = await deployStonksWithTestOracle({
        factoryParams: {
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: contracts.STETH,
          tokenTo: contracts.DAI,
          manager: await signer.getAddress(),
          marginInBps: marginInBps,
          orderDuration: 3600,
          priceToleranceInBps: 100,
          minFillBps: 9000,
          allowPartialFill: true,
          amountConverterAddress: undefined,
        },
        amountConverterParams: {
          allowedTokensToSell: [contracts.STETH],
          allowedStableTokensToBuy: [contracts.DAI],
          useEthAnchor: false,
        },
      })

      stonksPartialFillMinFill0 = stonks0
      stonksPartialFillMinFill50 = stonks50
      stonksPartialFillMinFill90 = stonks90
    })

    it('should accept order after negative rebase if balance >= minFillBps requirement (50%)', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill50.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill50.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill50.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const requiredMinSell = calculateRequiredMinSell(sellAmount, 5000n)

      const [tokenFrom] = await stonksPartialFillMinFill50.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = (initialBalance * 4000n) / 10000n

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const expectedBalanceAfterRebase = initialBalance - rebaseAmount
      const newBalance = await token.balanceOf(orderAddress)
      expect(newBalance).to.be.closeTo(expectedBalanceAfterRebase, 2n)
      const balancePercentageBps = (newBalance * MAX_BASIS_POINTS) / sellAmount
      const expectedBalancePercentageBps =
        (expectedBalanceAfterRebase * MAX_BASIS_POINTS) / sellAmount
      expect(balancePercentageBps).to.be.closeTo(expectedBalancePercentageBps, 2n)
      expect(balancePercentageBps).to.be.greaterThan(5000n)
      const excessOverRequired = newBalance - requiredMinSell
      const expectedExcess = expectedBalanceAfterRebase - requiredMinSell
      expect(excessOverRequired).to.be.closeTo(expectedExcess, 2n)

      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      await localSnapshot.restore()
    })

    it('should revert after negative rebase if balance < minFillBps requirement (50%)', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill50.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill50.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill50.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const requiredMinSell = calculateRequiredMinSell(sellAmount, 5000n)

      const [tokenFrom] = await stonksPartialFillMinFill50.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = (initialBalance * 6000n) / 10000n

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const expectedBalanceAfterRebase = initialBalance - rebaseAmount
      const newBalance = await token.balanceOf(orderAddress)
      expect(newBalance).to.be.closeTo(expectedBalanceAfterRebase, 2n)
      const balancePercentageBps = (newBalance * MAX_BASIS_POINTS) / sellAmount
      const expectedBalancePercentageBps =
        (expectedBalanceAfterRebase * MAX_BASIS_POINTS) / sellAmount
      expect(balancePercentageBps).to.be.closeTo(expectedBalancePercentageBps, 2n)
      expect(balancePercentageBps).to.be.lessThan(5000n)
      const shortfall = requiredMinSell - newBalance
      const expectedShortfall = requiredMinSell - expectedBalanceAfterRebase
      expect(shortfall).to.be.closeTo(expectedShortfall, 2n)

      await expect(order.isValidSignature(orderHash, '0x'))
        .to.be.revertedWithCustomError(order, 'InsufficientSellBalance')
        .withArgs(requiredMinSell, newBalance)

      await localSnapshot.restore()
    })

    it('should handle 50% negative rebase with minFillBps = 50% (boundary case)', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill50.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill50.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill50.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const requiredMinSell = calculateRequiredMinSell(sellAmount, 5000n)

      const [tokenFrom] = await stonksPartialFillMinFill50.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = initialBalance / 2n

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const expectedBalanceAfterRebase = initialBalance - rebaseAmount
      const newBalance = await token.balanceOf(orderAddress)
      expect(newBalance).to.be.closeTo(expectedBalanceAfterRebase, 2n)
      expect(newBalance).to.be.closeTo(requiredMinSell, 2n)

      // (stETH shares rounding may cause slight variations, but >= requiredMinSell should pass)
      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      await localSnapshot.restore()
    })

    it('should handle 10% negative rebase with minFillBps = 90% (balance still above requirement)', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill90.getAddress(),
      })

      expect(await stonksPartialFillMinFill90.MIN_FILL_BPS()).to.equal(9000)
      expect(await stonksPartialFillMinFill90.ALLOW_PARTIAL_FILL()).to.equal(true)

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill90.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill90.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const requiredMinSell = calculateRequiredMinSell(sellAmount, 9000n)

      const [tokenFrom] = await stonksPartialFillMinFill90.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = initialBalance / 10n

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const newBalance = await token.balanceOf(orderAddress)
      const expectedBalanceAfterRebase = initialBalance - rebaseAmount
      expect(newBalance).to.be.closeTo(expectedBalanceAfterRebase, 2n)
      expect(newBalance).to.be.closeTo(requiredMinSell, 2n) // At or very close to 90%

      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      await localSnapshot.restore()
    })

    it('should revert after 15% negative rebase with minFillBps = 90% (balance below requirement)', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill90.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill90.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill90.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const requiredMinSell = calculateRequiredMinSell(sellAmount, 9000n)

      const [tokenFrom] = await stonksPartialFillMinFill90.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = (initialBalance * 1500n) / 10000n

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const expectedBalanceAfterRebase = initialBalance - rebaseAmount
      const newBalance = await token.balanceOf(orderAddress)
      expect(newBalance).to.be.closeTo(expectedBalanceAfterRebase, 2n)
      const balancePercentageBps = (newBalance * MAX_BASIS_POINTS) / sellAmount
      const expectedBalancePercentageBps =
        (expectedBalanceAfterRebase * MAX_BASIS_POINTS) / sellAmount
      expect(balancePercentageBps).to.be.closeTo(expectedBalancePercentageBps, 2n)
      expect(balancePercentageBps).to.be.lessThan(9000n) // 85% < 90%
      expect(balancePercentageBps).to.be.greaterThan(8400n)
      const shortfall = requiredMinSell - newBalance
      const expectedShortfall = requiredMinSell - expectedBalanceAfterRebase
      expect(shortfall).to.be.closeTo(expectedShortfall, 2n)

      await expect(order.isValidSignature(orderHash, '0x'))
        .to.be.revertedWithCustomError(order, 'InsufficientSellBalance')
        .withArgs(requiredMinSell, newBalance)

      await localSnapshot.restore()
    })

    it('should accept any rebase with minFillBps = 0 (no minimum requirement)', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill0.getAddress(),
      })

      expect(await stonksPartialFillMinFill0.MIN_FILL_BPS()).to.equal(0)
      expect(await stonksPartialFillMinFill0.ALLOW_PARTIAL_FILL()).to.equal(true)

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill0.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill0.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)

      const [tokenFrom] = await stonksPartialFillMinFill0.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = (initialBalance * 6000n) / 10000n

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const newBalance = await token.balanceOf(orderAddress)
      const expectedBalanceAfterRebase = initialBalance - rebaseAmount
      expect(newBalance).to.be.closeTo(expectedBalanceAfterRebase, 2n)

      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      await localSnapshot.restore()
    })

    it('should handle small negative rebase (1%) with minFillBps = 50% (balance well above requirement)', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill50.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill50.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill50.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const requiredMinSell = calculateRequiredMinSell(sellAmount, 5000n)

      const [tokenFrom] = await stonksPartialFillMinFill50.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = initialBalance / 100n

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const expectedBalanceAfterRebase = initialBalance - rebaseAmount
      const newBalance = await token.balanceOf(orderAddress)
      expect(newBalance).to.be.closeTo(expectedBalanceAfterRebase, 2n)
      const balancePercentageBps = (newBalance * MAX_BASIS_POINTS) / sellAmount
      const expectedBalancePercentageBps =
        (expectedBalanceAfterRebase * MAX_BASIS_POINTS) / sellAmount
      expect(balancePercentageBps).to.be.closeTo(expectedBalancePercentageBps, 2n)
      expect(balancePercentageBps).to.be.greaterThan(5000n)
      const excessOverRequired = newBalance - requiredMinSell
      const expectedExcess = expectedBalanceAfterRebase - requiredMinSell
      expect(excessOverRequired).to.be.closeTo(expectedExcess, 2n)

      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      await localSnapshot.restore()
    })

    it('should handle multiple cumulative rebases with minFillBps = 50%', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill50.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill50.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill50.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const requiredMinSell = calculateRequiredMinSell(sellAmount, 5000n)

      const [tokenFrom] = await stonksPartialFillMinFill50.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      let currentBalance = await token.balanceOf(orderAddress)
      let rebaseAmount = (currentBalance * 2000n) / 10000n
      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)
      let expectedBalance = currentBalance - rebaseAmount
      currentBalance = await token.balanceOf(orderAddress)
      expect(currentBalance).to.be.closeTo(expectedBalance, 2n)
      const balancePercentageBps1 = (currentBalance * MAX_BASIS_POINTS) / sellAmount
      expect(balancePercentageBps1).to.be.greaterThan(5000n)
      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      rebaseAmount = (currentBalance * 1500n) / 10000n
      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)
      expectedBalance = currentBalance - rebaseAmount
      currentBalance = await token.balanceOf(orderAddress)
      expect(currentBalance).to.be.closeTo(expectedBalance, 2n)
      const balancePercentageBps2 = (currentBalance * MAX_BASIS_POINTS) / sellAmount
      expect(balancePercentageBps2).to.be.greaterThan(5000n)
      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      rebaseAmount = (currentBalance * 1000n) / 10000n
      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)
      expectedBalance = currentBalance - rebaseAmount
      currentBalance = await token.balanceOf(orderAddress)
      expect(currentBalance).to.be.closeTo(expectedBalance, 2n)
      const balancePercentageBps3 = (currentBalance * MAX_BASIS_POINTS) / sellAmount
      expect(balancePercentageBps3).to.be.greaterThan(5000n)
      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      rebaseAmount = (currentBalance * 1200n) / 10000n
      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)
      expectedBalance = currentBalance - rebaseAmount
      currentBalance = await token.balanceOf(orderAddress)
      expect(currentBalance).to.be.closeTo(expectedBalance, 2n)
      const balancePercentageBps4 = (currentBalance * MAX_BASIS_POINTS) / sellAmount
      expect(balancePercentageBps4).to.be.greaterThan(5000n)
      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      rebaseAmount = (currentBalance * 800n) / 10000n
      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)
      const expectedFinalBalance = currentBalance - rebaseAmount
      const finalBalance = await token.balanceOf(orderAddress)
      expect(finalBalance).to.be.closeTo(expectedFinalBalance, 2n) // Account for stETH rounding

      if (finalBalance < requiredMinSell) {
        await expect(order.isValidSignature(orderHash, '0x')).to.be.revertedWithCustomError(
          order,
          'InsufficientSellBalance'
        )
      } else {
        expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)
      }

      await localSnapshot.restore()
    })

    this.afterAll(async function () {
      await snapshot.restore()
    })
  })

  describe('MIN_FILL_BPS Integration with Order Placement:', function () {
    let stonksPartialFillMinFill50: Stonks
    let snapshot: SnapshotRestorer

    this.beforeAll(async function () {
      snapshot = await takeSnapshot()
      await refreshTestFeedData([contracts.STETH, contracts.DAI])

      // Deploy Stonks with ALLOW_PARTIAL_FILL = true and minFillBps = 5000 (50%)
      const { stonks } = await deployStonksWithTestOracle({
        factoryParams: {
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: contracts.STETH,
          tokenTo: contracts.DAI,
          manager: await signer.getAddress(),
          marginInBps: marginInBps,
          orderDuration: 3600,
          priceToleranceInBps: 100,
          minFillBps: 5000,
          allowPartialFill: true,
          amountConverterAddress: undefined,
        },
        amountConverterParams: {
          allowedTokensToSell: [contracts.STETH],
          allowedStableTokensToBuy: [contracts.DAI],
          useEthAnchor: false,
        },
      })

      stonksPartialFillMinFill50 = stonks
    })

    it('should successfully place order with correct minFillBps from Stonks', async function () {
      const localSnapshot = await takeSnapshot()

      expect(await stonksPartialFillMinFill50.MIN_FILL_BPS()).to.equal(5000)
      expect(await stonksPartialFillMinFill50.ALLOW_PARTIAL_FILL()).to.equal(true)

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill50.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill50.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill50.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)

      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      await localSnapshot.restore()
    })

    it('should have multiple orders from same Stonks inherit same minFillBps', async function () {
      const localSnapshot = await takeSnapshot()

      const expectedMinFillBps = 5000

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('2'),
        address: await stonksPartialFillMinFill50.getAddress(),
      })

      // Place first order
      const expectedBuyAmount1 = await stonksPartialFillMinFill50.estimateTradeOutput(
        ethers.parseEther('1')
      )
      const placeOrderTx1 = await stonksPartialFillMinFill50.placeOrderWithAmount(
        ethers.parseEther('1'),
        expectedBuyAmount1
      )
      const placeOrderTxReceipt1 = await placeOrderTx1.wait()
      if (!placeOrderTxReceipt1) throw Error('placeOrderTxReceipt1 is null')

      const orderData1 = await getPlaceOrderData(placeOrderTxReceipt1)
      const order1 = await ethers.getContractAt('Order', orderData1.address, signer)
      const orderHash1 = await formOrderHashFromTxReceipt(placeOrderTxReceipt1)

      // Check balance after first order (accounting for stETH shares rounding)
      const [tokenFrom] = await stonksPartialFillMinFill50.getOrderParameters()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const stonksAddress = await stonksPartialFillMinFill50.getAddress()
      const remainingBalance = await token.balanceOf(stonksAddress)

      // Place second order with remaining balance (might be slightly less than 1 ETH due to rounding)
      const expectedBuyAmount2 =
        await stonksPartialFillMinFill50.estimateTradeOutput(remainingBalance)
      const placeOrderTx2 = await stonksPartialFillMinFill50.placeOrderWithAmount(
        remainingBalance,
        expectedBuyAmount2
      )
      const placeOrderTxReceipt2 = await placeOrderTx2.wait()
      if (!placeOrderTxReceipt2) throw Error('placeOrderTxReceipt2 is null')

      const orderData2 = await getPlaceOrderData(placeOrderTxReceipt2)
      const order2 = await ethers.getContractAt('Order', orderData2.address, signer)
      const orderHash2 = await formOrderHashFromTxReceipt(placeOrderTxReceipt2)

      // Both orders should be valid with full balance
      expect(await order1.isValidSignature(orderHash1, '0x')).to.equal(MAGIC_VALUE)
      expect(await order2.isValidSignature(orderHash2, '0x')).to.equal(MAGIC_VALUE)

      // Both orders should enforce the same minFillBps (50%)
      // tokenFrom and token already declared above
      const orderDetails1 = await order1.getOrderDetails()
      const orderDetails2 = await order2.getOrderDetails()
      const sellAmount1 = orderDetails1[3]
      const sellAmount2 = orderDetails2[3]
      const requiredMinSell1 = calculateRequiredMinSell(sellAmount1, BigInt(expectedMinFillBps))
      const requiredMinSell2 = calculateRequiredMinSell(sellAmount2, BigInt(expectedMinFillBps))

      const orderAddress1 = await order1.getAddress()
      const initialBalance1 = await token.balanceOf(orderAddress1)
      const rebaseAmount1 = (initialBalance1 * 6000n) / 10000n
      await ethers.provider.send('hardhat_impersonateAccount', [orderAddress1])
      await ethers.provider.send('hardhat_setBalance', [orderAddress1, '0x1000000000000000000'])
      const orderSigner1 = await ethers.getSigner(orderAddress1)
      const [, recipient] = await ethers.getSigners()
      await token.connect(orderSigner1).transfer(await recipient.getAddress(), rebaseAmount1)

      // First order should revert (balance below 50% requirement)
      await expect(order1.isValidSignature(orderHash1, '0x'))
        .to.be.revertedWithCustomError(order1, 'InsufficientSellBalance')
        .withArgs(requiredMinSell1, await token.balanceOf(orderAddress1))

      // Second order should still be valid (full balance)
      expect(await order2.isValidSignature(orderHash2, '0x')).to.equal(MAGIC_VALUE)

      await localSnapshot.restore()
    })

    it('should use minFillBps value captured during order initialization (immutable)', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill50.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill50.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill50.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const expectedRequiredMinSell = calculateRequiredMinSell(sellAmount, 5000n)

      const [tokenFrom] = await stonksPartialFillMinFill50.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = (initialBalance * 6000n) / 10000n
      await ethers.provider.send('hardhat_impersonateAccount', [orderAddress])
      await ethers.provider.send('hardhat_setBalance', [orderAddress, '0x1000000000000000000'])
      const orderSigner = await ethers.getSigner(orderAddress)
      const [, recipient] = await ethers.getSigners()
      await token.connect(orderSigner).transfer(await recipient.getAddress(), rebaseAmount)

      const finalBalance = await token.balanceOf(orderAddress)

      await expect(order.isValidSignature(orderHash, '0x'))
        .to.be.revertedWithCustomError(order, 'InsufficientSellBalance')
        .withArgs(expectedRequiredMinSell, finalBalance)

      expect(expectedRequiredMinSell).to.equal(calculateRequiredMinSell(sellAmount, 5000n))

      await localSnapshot.restore()
    })

    it('should place orders successfully with different sellAmount values but same minFillBps', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks with multiple amounts
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('3'),
        address: await stonksPartialFillMinFill50.getAddress(),
      })

      // Place order with 0.5 ETH
      const sellAmount1 = ethers.parseEther('0.5')
      const expectedBuyAmount1 = await stonksPartialFillMinFill50.estimateTradeOutput(sellAmount1)
      const placeOrderTx1 = await stonksPartialFillMinFill50.placeOrderWithAmount(
        sellAmount1,
        expectedBuyAmount1
      )
      const placeOrderTxReceipt1 = await placeOrderTx1.wait()
      if (!placeOrderTxReceipt1) throw Error('placeOrderTxReceipt1 is null')

      // Place order with 1 ETH
      const sellAmount2 = ethers.parseEther('1')
      const expectedBuyAmount2 = await stonksPartialFillMinFill50.estimateTradeOutput(sellAmount2)
      const placeOrderTx2 = await stonksPartialFillMinFill50.placeOrderWithAmount(
        sellAmount2,
        expectedBuyAmount2
      )
      const placeOrderTxReceipt2 = await placeOrderTx2.wait()
      if (!placeOrderTxReceipt2) throw Error('placeOrderTxReceipt2 is null')

      // Place order with 1.5 ETH
      const sellAmount3 = ethers.parseEther('1.5')
      const expectedBuyAmount3 = await stonksPartialFillMinFill50.estimateTradeOutput(sellAmount3)
      const placeOrderTx3 = await stonksPartialFillMinFill50.placeOrderWithAmount(
        sellAmount3,
        expectedBuyAmount3
      )
      const placeOrderTxReceipt3 = await placeOrderTx3.wait()
      if (!placeOrderTxReceipt3) throw Error('placeOrderTxReceipt3 is null')

      // Get order instances
      const orderData1 = await getPlaceOrderData(placeOrderTxReceipt1)
      const order1 = await ethers.getContractAt('Order', orderData1.address, signer)
      const orderHash1 = await formOrderHashFromTxReceipt(placeOrderTxReceipt1)

      const orderData2 = await getPlaceOrderData(placeOrderTxReceipt2)
      const order2 = await ethers.getContractAt('Order', orderData2.address, signer)
      const orderHash2 = await formOrderHashFromTxReceipt(placeOrderTxReceipt2)

      const orderData3 = await getPlaceOrderData(placeOrderTxReceipt3)
      const order3 = await ethers.getContractAt('Order', orderData3.address, signer)
      const orderHash3 = await formOrderHashFromTxReceipt(placeOrderTxReceipt3)

      // All orders should be valid
      expect(await order1.isValidSignature(orderHash1, '0x')).to.equal(MAGIC_VALUE)
      expect(await order2.isValidSignature(orderHash2, '0x')).to.equal(MAGIC_VALUE)
      expect(await order3.isValidSignature(orderHash3, '0x')).to.equal(MAGIC_VALUE)

      // All should enforce 50% minFillBps
      const [tokenFrom] = await stonksPartialFillMinFill50.getOrderParameters()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const orderDetails1 = await order1.getOrderDetails()
      const orderDetails2 = await order2.getOrderDetails()
      const orderDetails3 = await order3.getOrderDetails()

      const requiredMinSell1 = calculateRequiredMinSell(orderDetails1[3], 5000n)
      const requiredMinSell2 = calculateRequiredMinSell(orderDetails2[3], 5000n)
      const requiredMinSell3 = calculateRequiredMinSell(orderDetails3[3], 5000n)

      const orderAddress1 = await order1.getAddress()
      const orderAddress2 = await order2.getAddress()
      const orderAddress3 = await order3.getAddress()

      const balance1 = await token.balanceOf(orderAddress1)
      await ethers.provider.send('hardhat_impersonateAccount', [orderAddress1])
      await ethers.provider.send('hardhat_setBalance', [orderAddress1, '0x1000000000000000000'])
      const orderSigner1 = await ethers.getSigner(orderAddress1)
      const [, recipient] = await ethers.getSigners()
      await token
        .connect(orderSigner1)
        .transfer(await recipient.getAddress(), (balance1 * 6000n) / 10000n)

      // Rebase order 2 (remove 60%)
      const balance2 = await token.balanceOf(orderAddress2)
      await ethers.provider.send('hardhat_impersonateAccount', [orderAddress2])
      await ethers.provider.send('hardhat_setBalance', [orderAddress2, '0x1000000000000000000'])
      const orderSigner2 = await ethers.getSigner(orderAddress2)
      await token
        .connect(orderSigner2)
        .transfer(await recipient.getAddress(), (balance2 * 6000n) / 10000n)

      // Rebase order 3 (remove 60%)
      const balance3 = await token.balanceOf(orderAddress3)
      await ethers.provider.send('hardhat_impersonateAccount', [orderAddress3])
      await ethers.provider.send('hardhat_setBalance', [orderAddress3, '0x1000000000000000000'])
      const orderSigner3 = await ethers.getSigner(orderAddress3)
      await token
        .connect(orderSigner3)
        .transfer(await recipient.getAddress(), (balance3 * 6000n) / 10000n)

      // All orders should revert with correct requiredMinSell values
      await expect(order1.isValidSignature(orderHash1, '0x'))
        .to.be.revertedWithCustomError(order1, 'InsufficientSellBalance')
        .withArgs(requiredMinSell1, await token.balanceOf(orderAddress1))

      await expect(order2.isValidSignature(orderHash2, '0x'))
        .to.be.revertedWithCustomError(order2, 'InsufficientSellBalance')
        .withArgs(requiredMinSell2, await token.balanceOf(orderAddress2))

      await expect(order3.isValidSignature(orderHash3, '0x'))
        .to.be.revertedWithCustomError(order3, 'InsufficientSellBalance')
        .withArgs(requiredMinSell3, await token.balanceOf(orderAddress3))

      await localSnapshot.restore()
    })

    this.afterAll(async function () {
      await snapshot.restore()
    })
  })

  describe('MIN_FILL_BPS Error Messages & Revert Data:', function () {
    let stonksPartialFillMinFill50: Stonks
    let stonksPartialFillMinFill10: Stonks
    let stonksPartialFillMinFill99: Stonks
    let snapshot: SnapshotRestorer

    this.beforeAll(async function () {
      snapshot = await takeSnapshot()
      await refreshTestFeedData([contracts.STETH, contracts.DAI])

      // Deploy Stonks instances with different minFillBps values
      const { stonks: stonks50 } = await deployStonksWithTestOracle({
        factoryParams: {
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: contracts.STETH,
          tokenTo: contracts.DAI,
          manager: await signer.getAddress(),
          marginInBps: marginInBps,
          orderDuration: 3600,
          priceToleranceInBps: 100,
          minFillBps: 5000,
          allowPartialFill: true,
          amountConverterAddress: undefined,
        },
        amountConverterParams: {
          allowedTokensToSell: [contracts.STETH],
          allowedStableTokensToBuy: [contracts.DAI],
          useEthAnchor: false,
        },
      })

      const { stonks: stonks10 } = await deployStonksWithTestOracle({
        factoryParams: {
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: contracts.STETH,
          tokenTo: contracts.DAI,
          manager: await signer.getAddress(),
          marginInBps: marginInBps,
          orderDuration: 3600,
          priceToleranceInBps: 100,
          minFillBps: 1000,
          allowPartialFill: true,
          amountConverterAddress: undefined,
        },
        amountConverterParams: {
          allowedTokensToSell: [contracts.STETH],
          allowedStableTokensToBuy: [contracts.DAI],
          useEthAnchor: false,
        },
      })

      const { stonks: stonks99 } = await deployStonksWithTestOracle({
        factoryParams: {
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: contracts.STETH,
          tokenTo: contracts.DAI,
          manager: await signer.getAddress(),
          marginInBps: marginInBps,
          orderDuration: 3600,
          priceToleranceInBps: 100,
          minFillBps: 9900,
          allowPartialFill: true,
          amountConverterAddress: undefined,
        },
        amountConverterParams: {
          allowedTokensToSell: [contracts.STETH],
          allowedStableTokensToBuy: [contracts.DAI],
          useEthAnchor: false,
        },
      })

      stonksPartialFillMinFill50 = stonks50
      stonksPartialFillMinFill10 = stonks10
      stonksPartialFillMinFill99 = stonks99
    })

    it('should include correct requiredMinSell (calculated from minFillBps) in InsufficientSellBalance error', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill50.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill50.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill50.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const expectedRequiredMinSell = calculateRequiredMinSell(sellAmount, 5000n)

      const [tokenFrom] = await stonksPartialFillMinFill50.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = (initialBalance * 6000n) / 10000n
      await ethers.provider.send('hardhat_impersonateAccount', [orderAddress])
      await ethers.provider.send('hardhat_setBalance', [orderAddress, '0x1000000000000000000'])
      const orderSigner = await ethers.getSigner(orderAddress)
      const [, recipient] = await ethers.getSigners()
      await token.connect(orderSigner).transfer(await recipient.getAddress(), rebaseAmount)

      const actualBalance = await token.balanceOf(orderAddress)

      await expect(order.isValidSignature(orderHash, '0x'))
        .to.be.revertedWithCustomError(order, 'InsufficientSellBalance')
        .withArgs(expectedRequiredMinSell, actualBalance)

      await localSnapshot.restore()
    })

    it('should include correct available balance in InsufficientSellBalance error', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill50.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill50.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill50.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const requiredMinSell = calculateRequiredMinSell(sellAmount, 5000n)

      const [tokenFrom] = await stonksPartialFillMinFill50.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = (initialBalance * 5500n) / 10000n

      await ethers.provider.send('hardhat_impersonateAccount', [orderAddress])
      await ethers.provider.send('hardhat_setBalance', [orderAddress, '0x1000000000000000000'])
      const orderSigner = await ethers.getSigner(orderAddress)
      const [, recipient] = await ethers.getSigners()
      await token.connect(orderSigner).transfer(await recipient.getAddress(), rebaseAmount)

      const actualBalance = await token.balanceOf(orderAddress)
      const expectedBalance = initialBalance - rebaseAmount

      expect(actualBalance).to.be.closeTo(expectedBalance, 2n)

      await expect(order.isValidSignature(orderHash, '0x'))
        .to.be.revertedWithCustomError(order, 'InsufficientSellBalance')
        .withArgs(requiredMinSell, actualBalance)

      await localSnapshot.restore()
    })

    it('should have correct error format for different minFillBps values', async function () {
      const localSnapshot = await takeSnapshot()

      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill10.getAddress(),
      })

      const expectedBuyAmount10 =
        await stonksPartialFillMinFill10.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx10 = await stonksPartialFillMinFill10.placeOrder(expectedBuyAmount10)
      const placeOrderTxReceipt10 = await placeOrderTx10.wait()
      if (!placeOrderTxReceipt10) throw Error('placeOrderTxReceipt10 is null')

      const orderData10 = await getPlaceOrderData(placeOrderTxReceipt10)
      const order10 = await ethers.getContractAt('Order', orderData10.address, signer)
      const orderHash10 = await formOrderHashFromTxReceipt(placeOrderTxReceipt10)
      const orderDetails10 = await order10.getOrderDetails()
      const sellAmount10 = orderDetails10[3]
      const requiredMinSell10 = calculateRequiredMinSell(sellAmount10, 1000n) // 10%

      const [tokenFrom] = await stonksPartialFillMinFill10.getOrderParameters()
      const orderAddress10 = await order10.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance10 = await token.balanceOf(orderAddress10)

      // Rebase to 5% (below 10% requirement)
      await ethers.provider.send('hardhat_impersonateAccount', [orderAddress10])
      await ethers.provider.send('hardhat_setBalance', [orderAddress10, '0x1000000000000000000'])
      const orderSigner10 = await ethers.getSigner(orderAddress10)
      const [, recipient] = await ethers.getSigners()
      await token
        .connect(orderSigner10)
        .transfer(await recipient.getAddress(), (initialBalance10 * 9500n) / 10000n)

      const balance10 = await token.balanceOf(orderAddress10)

      await expect(order10.isValidSignature(orderHash10, '0x'))
        .to.be.revertedWithCustomError(order10, 'InsufficientSellBalance')
        .withArgs(requiredMinSell10, balance10)

      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill99.getAddress(),
      })

      const expectedBuyAmount99 =
        await stonksPartialFillMinFill99.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx99 = await stonksPartialFillMinFill99.placeOrder(expectedBuyAmount99)
      const placeOrderTxReceipt99 = await placeOrderTx99.wait()
      if (!placeOrderTxReceipt99) throw Error('placeOrderTxReceipt99 is null')

      const orderData99 = await getPlaceOrderData(placeOrderTxReceipt99)
      const order99 = await ethers.getContractAt('Order', orderData99.address, signer)
      const orderHash99 = await formOrderHashFromTxReceipt(placeOrderTxReceipt99)
      const orderDetails99 = await order99.getOrderDetails()
      const sellAmount99 = orderDetails99[3]
      const requiredMinSell99 = calculateRequiredMinSell(sellAmount99, 9900n) // 99%

      const orderAddress99 = await order99.getAddress()
      const initialBalance99 = await token.balanceOf(orderAddress99)

      // Rebase to 98% (below 99% requirement)
      await ethers.provider.send('hardhat_impersonateAccount', [orderAddress99])
      await ethers.provider.send('hardhat_setBalance', [orderAddress99, '0x1000000000000000000'])
      const orderSigner99 = await ethers.getSigner(orderAddress99)
      await token
        .connect(orderSigner99)
        .transfer(await recipient.getAddress(), (initialBalance99 * 200n) / 10000n)

      const balance99 = await token.balanceOf(orderAddress99)

      await expect(order99.isValidSignature(orderHash99, '0x'))
        .to.be.revertedWithCustomError(order99, 'InsufficientSellBalance')
        .withArgs(requiredMinSell99, balance99)

      await localSnapshot.restore()
    })

    it('should verify revert data format matches Order contract expectations', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill50.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill50.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill50.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const requiredMinSell = calculateRequiredMinSell(sellAmount, 5000n)

      // Simulate rebase
      const [tokenFrom] = await stonksPartialFillMinFill50.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = (initialBalance * 6000n) / 10000n

      await ethers.provider.send('hardhat_impersonateAccount', [orderAddress])
      await ethers.provider.send('hardhat_setBalance', [orderAddress, '0x1000000000000000000'])
      const orderSigner = await ethers.getSigner(orderAddress)
      const [, recipient] = await ethers.getSigners()
      await token.connect(orderSigner).transfer(await recipient.getAddress(), rebaseAmount)

      const available = await token.balanceOf(orderAddress)

      await expect(order.isValidSignature(orderHash, '0x'))
        .to.be.revertedWithCustomError(order, 'InsufficientSellBalance')
        .withArgs(requiredMinSell, available)

      expect(requiredMinSell).to.be.greaterThan(0n)
      expect(available).to.be.greaterThan(0n)

      expect(available).to.be.lessThan(requiredMinSell)

      await localSnapshot.restore()
    })

    it('should handle edge case where requiredMinSell calculation results in rounding', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks with an amount that might cause rounding issues
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill50.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill50.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill50.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const requiredMinSell = calculateRequiredMinSell(sellAmount, 5000n)

      const [tokenFrom] = await stonksPartialFillMinFill50.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)

      const rebaseAmount = (initialBalance * 5100n) / 10000n

      await ethers.provider.send('hardhat_impersonateAccount', [orderAddress])
      await ethers.provider.send('hardhat_setBalance', [orderAddress, '0x1000000000000000000'])
      const orderSigner = await ethers.getSigner(orderAddress)
      const [, recipient] = await ethers.getSigners()
      await token.connect(orderSigner).transfer(await recipient.getAddress(), rebaseAmount)

      const available = await token.balanceOf(orderAddress)

      await expect(order.isValidSignature(orderHash, '0x'))
        .to.be.revertedWithCustomError(order, 'InsufficientSellBalance')
        .withArgs(requiredMinSell, available)

      expect(available).to.be.lessThan(requiredMinSell)

      await localSnapshot.restore()
    })

    this.afterAll(async function () {
      await snapshot.restore()
    })
  })

  describe('MIN_FILL_BPS Edge Cases & Combinations:', function () {
    let stonksPartialFillMinFill100: Stonks
    let stonksNoPartialFillMinFill100: Stonks
    let stonksPartialFillMinFill1: Stonks
    let stonksPartialFillMinFill2500: Stonks
    let stonksPartialFillMinFill7500: Stonks
    let stonksPartialFillMinFill50: Stonks
    let snapshot: SnapshotRestorer

    this.beforeAll(async function () {
      snapshot = await takeSnapshot()
      await refreshTestFeedData([contracts.STETH, contracts.DAI])

      // Deploy Stonks with ALLOW_PARTIAL_FILL = true and minFillBps = 10000 (100%)
      const { stonks: stonks100Partial } = await deployStonksWithTestOracle({
        factoryParams: {
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: contracts.STETH,
          tokenTo: contracts.DAI,
          manager: await signer.getAddress(),
          marginInBps: marginInBps,
          orderDuration: 3600,
          priceToleranceInBps: 100,
          minFillBps: 10000,
          allowPartialFill: true,
          amountConverterAddress: undefined,
        },
        amountConverterParams: {
          allowedTokensToSell: [contracts.STETH],
          allowedStableTokensToBuy: [contracts.DAI],
          useEthAnchor: false,
        },
      })

      // Deploy Stonks with ALLOW_PARTIAL_FILL = false and minFillBps = 10000 (100%)
      const { stonks: stonks100NoPartial } = await deployStonksWithTestOracle({
        factoryParams: {
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: contracts.STETH,
          tokenTo: contracts.DAI,
          manager: await signer.getAddress(),
          marginInBps: marginInBps,
          orderDuration: 3600,
          priceToleranceInBps: 100,
          minFillBps: 10000,
          allowPartialFill: false,
          amountConverterAddress: undefined,
        },
        amountConverterParams: {
          allowedTokensToSell: [contracts.STETH],
          allowedStableTokensToBuy: [contracts.DAI],
          useEthAnchor: false,
        },
      })

      // Deploy Stonks with ALLOW_PARTIAL_FILL = true and minFillBps = 1 (0.01%)
      const { stonks: stonks1 } = await deployStonksWithTestOracle({
        factoryParams: {
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: contracts.STETH,
          tokenTo: contracts.DAI,
          manager: await signer.getAddress(),
          marginInBps: marginInBps,
          orderDuration: 3600,
          priceToleranceInBps: 100,
          minFillBps: 1,
          allowPartialFill: true,
          amountConverterAddress: undefined,
        },
        amountConverterParams: {
          allowedTokensToSell: [contracts.STETH],
          allowedStableTokensToBuy: [contracts.DAI],
          useEthAnchor: false,
        },
      })

      // Deploy Stonks with ALLOW_PARTIAL_FILL = true and minFillBps = 2500 (25%)
      const { stonks: stonks25 } = await deployStonksWithTestOracle({
        factoryParams: {
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: contracts.STETH,
          tokenTo: contracts.DAI,
          manager: await signer.getAddress(),
          marginInBps: marginInBps,
          orderDuration: 3600,
          priceToleranceInBps: 100,
          minFillBps: 2500,
          allowPartialFill: true,
          amountConverterAddress: undefined,
        },
        amountConverterParams: {
          allowedTokensToSell: [contracts.STETH],
          allowedStableTokensToBuy: [contracts.DAI],
          useEthAnchor: false,
        },
      })

      // Deploy Stonks with ALLOW_PARTIAL_FILL = true and minFillBps = 7500 (75%)
      const { stonks: stonks75 } = await deployStonksWithTestOracle({
        factoryParams: {
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: contracts.STETH,
          tokenTo: contracts.DAI,
          manager: await signer.getAddress(),
          marginInBps: marginInBps,
          orderDuration: 3600,
          priceToleranceInBps: 100,
          minFillBps: 7500,
          allowPartialFill: true,
          amountConverterAddress: undefined,
        },
        amountConverterParams: {
          allowedTokensToSell: [contracts.STETH],
          allowedStableTokensToBuy: [contracts.DAI],
          useEthAnchor: false,
        },
      })

      // Deploy Stonks with ALLOW_PARTIAL_FILL = true and minFillBps = 5000 (50%) for some tests
      const { stonks: stonks50 } = await deployStonksWithTestOracle({
        factoryParams: {
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: contracts.STETH,
          tokenTo: contracts.DAI,
          manager: await signer.getAddress(),
          marginInBps: marginInBps,
          orderDuration: 3600,
          priceToleranceInBps: 100,
          minFillBps: 5000,
          allowPartialFill: true,
          amountConverterAddress: undefined,
        },
        amountConverterParams: {
          allowedTokensToSell: [contracts.STETH],
          allowedStableTokensToBuy: [contracts.DAI],
          useEthAnchor: false,
        },
      })

      stonksPartialFillMinFill100 = stonks100Partial
      stonksNoPartialFillMinFill100 = stonks100NoPartial
      stonksPartialFillMinFill1 = stonks1
      stonksPartialFillMinFill2500 = stonks25
      stonksPartialFillMinFill7500 = stonks75
      stonksPartialFillMinFill50 = stonks50
    })

    it('should require full fill when minFillBps = 10000 with ALLOW_PARTIAL_FILL = true', async function () {
      const localSnapshot = await takeSnapshot()

      expect(await stonksPartialFillMinFill100.MIN_FILL_BPS()).to.equal(10000)
      expect(await stonksPartialFillMinFill100.ALLOW_PARTIAL_FILL()).to.equal(true)

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill100.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill100.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill100.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const requiredMinSell = calculateRequiredMinSell(sellAmount, 10000n)
      expect(requiredMinSell).to.equal(sellAmount)

      const [tokenFrom] = await stonksPartialFillMinFill100.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = initialBalance / 100n
      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const expectedBalanceAfterRebase = initialBalance - rebaseAmount
      const newBalance = await token.balanceOf(orderAddress)
      expect(newBalance).to.be.closeTo(expectedBalanceAfterRebase, 2n)
      expect(newBalance).to.be.lessThan(sellAmount)

      await expect(order.isValidSignature(orderHash, '0x'))
        .to.be.revertedWithCustomError(order, 'InsufficientSellBalance')
        .withArgs(requiredMinSell, newBalance)

      await localSnapshot.restore()
    })

    it('should require full fill when minFillBps = 10000 with ALLOW_PARTIAL_FILL = false (both paths converge)', async function () {
      const localSnapshot = await takeSnapshot()

      expect(await stonksNoPartialFillMinFill100.MIN_FILL_BPS()).to.equal(10000)
      expect(await stonksNoPartialFillMinFill100.ALLOW_PARTIAL_FILL()).to.equal(false)

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksNoPartialFillMinFill100.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksNoPartialFillMinFill100.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksNoPartialFillMinFill100.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const [tokenFrom] = await stonksNoPartialFillMinFill100.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = initialBalance / 100n
      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const expectedBalanceAfterRebase = initialBalance - rebaseAmount
      const newBalance = await token.balanceOf(orderAddress)
      expect(newBalance).to.be.closeTo(expectedBalanceAfterRebase, 2n)
      expect(newBalance).to.be.lessThan(sellAmount)

      await expect(order.isValidSignature(orderHash, '0x'))
        .to.be.revertedWithCustomError(order, 'InsufficientSellBalance')
        .withArgs(sellAmount, newBalance)

      await localSnapshot.restore()
    })

    it('should validate correct percentage calculation for minFillBps = 1 (0.01%)', async function () {
      const localSnapshot = await takeSnapshot()

      expect(await stonksPartialFillMinFill1.MIN_FILL_BPS()).to.equal(1)
      expect(await stonksPartialFillMinFill1.ALLOW_PARTIAL_FILL()).to.equal(true)

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill1.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill1.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill1.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const requiredMinSell = calculateRequiredMinSell(sellAmount, 1n)

      const [tokenFrom] = await stonksPartialFillMinFill1.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = (initialBalance * 1n) / 10000n

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const newBalance = await token.balanceOf(orderAddress)
      expect(newBalance).to.be.greaterThan(requiredMinSell)

      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      const balanceBeforeSecondRebase = await token.balanceOf(orderAddress)
      const secondRebaseAmount = (balanceBeforeSecondRebase * 9999n) / 10000n

      await simulateNegativeRebase(tokenFrom, orderAddress, secondRebaseAmount)

      const finalBalance = await token.balanceOf(orderAddress)

      if (finalBalance < requiredMinSell) {
        await expect(order.isValidSignature(orderHash, '0x'))
          .to.be.revertedWithCustomError(order, 'InsufficientSellBalance')
          .withArgs(requiredMinSell, finalBalance)
      }

      await localSnapshot.restore()
    })

    it('should validate correct percentage calculation for minFillBps = 2500 (25%)', async function () {
      const localSnapshot = await takeSnapshot()

      expect(await stonksPartialFillMinFill2500.MIN_FILL_BPS()).to.equal(2500)
      expect(await stonksPartialFillMinFill2500.ALLOW_PARTIAL_FILL()).to.equal(true)

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill2500.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill2500.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill2500.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const requiredMinSell = calculateRequiredMinSell(sellAmount, 2500n)

      const [tokenFrom] = await stonksPartialFillMinFill2500.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = (initialBalance * 7000n) / 10000n

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const expectedBalance30 = initialBalance - rebaseAmount
      const balance30 = await token.balanceOf(orderAddress)
      expect(balance30).to.be.closeTo(expectedBalance30, 2n) // Account for stETH rounding
      expect(balance30).to.be.greaterThan(requiredMinSell) // 30% > 25%
      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      const balanceBeforeSecondRebase = await token.balanceOf(orderAddress)
      const secondRebaseAmount = (balanceBeforeSecondRebase * 3333n) / 10000n

      await simulateNegativeRebase(tokenFrom, orderAddress, secondRebaseAmount)

      const expectedBalance20 = balanceBeforeSecondRebase - secondRebaseAmount
      const balance20 = await token.balanceOf(orderAddress)
      expect(balance20).to.be.closeTo(expectedBalance20, 2n)
      expect(balance20).to.be.lessThan(requiredMinSell)

      await expect(order.isValidSignature(orderHash, '0x'))
        .to.be.revertedWithCustomError(order, 'InsufficientSellBalance')
        .withArgs(requiredMinSell, balance20)

      await localSnapshot.restore()
    })

    it('should validate correct percentage calculation for minFillBps = 7500 (75%)', async function () {
      const localSnapshot = await takeSnapshot()

      expect(await stonksPartialFillMinFill7500.MIN_FILL_BPS()).to.equal(7500)
      expect(await stonksPartialFillMinFill7500.ALLOW_PARTIAL_FILL()).to.equal(true)

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill7500.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill7500.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill7500.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const requiredMinSell = calculateRequiredMinSell(sellAmount, 7500n)

      const [tokenFrom] = await stonksPartialFillMinFill7500.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = (initialBalance * 2000n) / 10000n

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const expectedBalance80 = initialBalance - rebaseAmount
      const balance80 = await token.balanceOf(orderAddress)
      expect(balance80).to.be.closeTo(expectedBalance80, 2n) // Account for stETH rounding
      expect(balance80).to.be.greaterThan(requiredMinSell) // 80% > 75%
      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      const balanceBeforeSecondRebase = await token.balanceOf(orderAddress)
      const secondRebaseAmount = (balanceBeforeSecondRebase * 1250n) / 10000n

      await simulateNegativeRebase(tokenFrom, orderAddress, secondRebaseAmount)

      const expectedBalance70 = balanceBeforeSecondRebase - secondRebaseAmount
      const balance70 = await token.balanceOf(orderAddress)
      expect(balance70).to.be.closeTo(expectedBalance70, 2n)
      expect(balance70).to.be.lessThan(requiredMinSell)

      await expect(order.isValidSignature(orderHash, '0x'))
        .to.be.revertedWithCustomError(order, 'InsufficientSellBalance')
        .withArgs(requiredMinSell, balance70)

      await localSnapshot.restore()
    })

    it('should handle isValidSignature with different sellAmount values and same minFillBps', async function () {
      const localSnapshot = await takeSnapshot()

      const minFillBps = 5000 // 50%

      // Fund stonks with multiple amounts
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('3'),
        address: await stonksPartialFillMinFill2500.getAddress(), // Reuse existing instance, but we'll test different sellAmounts
      })

      // Deploy a new Stonks instance with 50% minFillBps for this test
      const { stonks: testStonks } = await deployStonksWithTestOracle({
        factoryParams: {
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: contracts.STETH,
          tokenTo: contracts.DAI,
          manager: await signer.getAddress(),
          marginInBps: marginInBps,
          orderDuration: 3600,
          priceToleranceInBps: 100,
          minFillBps: minFillBps,
          allowPartialFill: true,
          amountConverterAddress: undefined,
        },
        amountConverterParams: {
          allowedTokensToSell: [contracts.STETH],
          allowedStableTokensToBuy: [contracts.DAI],
          useEthAnchor: false,
        },
      })

      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('3'),
        address: await testStonks.getAddress(),
      })

      // Place order with 0.5 ETH
      const sellAmount1 = ethers.parseEther('0.5')
      const expectedBuyAmount1 = await testStonks.estimateTradeOutput(sellAmount1)
      const placeOrderTx1 = await testStonks.placeOrderWithAmount(sellAmount1, expectedBuyAmount1)
      const placeOrderTxReceipt1 = await placeOrderTx1.wait()
      if (!placeOrderTxReceipt1) throw Error('placeOrderTxReceipt1 is null')

      const orderData1 = await getPlaceOrderData(placeOrderTxReceipt1)
      const order1 = await ethers.getContractAt('Order', orderData1.address, signer)
      const orderHash1 = await formOrderHashFromTxReceipt(placeOrderTxReceipt1)
      const orderDetails1 = await order1.getOrderDetails()
      const sellAmount1_actual = orderDetails1[3]
      const requiredMinSell1 = (sellAmount1_actual * BigInt(minFillBps)) / 10000n

      // Place order with 1 ETH
      const sellAmount2 = ethers.parseEther('1')
      const expectedBuyAmount2 = await testStonks.estimateTradeOutput(sellAmount2)
      const placeOrderTx2 = await testStonks.placeOrderWithAmount(sellAmount2, expectedBuyAmount2)
      const placeOrderTxReceipt2 = await placeOrderTx2.wait()
      if (!placeOrderTxReceipt2) throw Error('placeOrderTxReceipt2 is null')

      const orderData2 = await getPlaceOrderData(placeOrderTxReceipt2)
      const order2 = await ethers.getContractAt('Order', orderData2.address, signer)
      const orderHash2 = await formOrderHashFromTxReceipt(placeOrderTxReceipt2)
      const orderDetails2 = await order2.getOrderDetails()
      const sellAmount2_actual = orderDetails2[3]
      const requiredMinSell2 = (sellAmount2_actual * BigInt(minFillBps)) / 10000n

      expect(requiredMinSell1).to.equal(sellAmount1_actual / 2n)
      expect(requiredMinSell2).to.equal(sellAmount2_actual / 2n)

      expect(await order1.isValidSignature(orderHash1, '0x')).to.equal(MAGIC_VALUE)
      expect(await order2.isValidSignature(orderHash2, '0x')).to.equal(MAGIC_VALUE)

      const [tokenFrom] = await testStonks.getOrderParameters()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const orderAddress1 = await order1.getAddress()
      const orderAddress2 = await order2.getAddress()

      const balance1 = await token.balanceOf(orderAddress1)
      const balance2 = await token.balanceOf(orderAddress2)

      await ethers.provider.send('hardhat_impersonateAccount', [orderAddress1])
      await ethers.provider.send('hardhat_setBalance', [orderAddress1, '0x1000000000000000000'])
      const orderSigner1 = await ethers.getSigner(orderAddress1)
      const [, recipient] = await ethers.getSigners()
      await token
        .connect(orderSigner1)
        .transfer(await recipient.getAddress(), (balance1 * 6000n) / 10000n)

      await ethers.provider.send('hardhat_impersonateAccount', [orderAddress2])
      await ethers.provider.send('hardhat_setBalance', [orderAddress2, '0x1000000000000000000'])
      const orderSigner2 = await ethers.getSigner(orderAddress2)
      await token
        .connect(orderSigner2)
        .transfer(await recipient.getAddress(), (balance2 * 6000n) / 10000n)

      // Both should revert with their respective requiredMinSell values
      await expect(order1.isValidSignature(orderHash1, '0x'))
        .to.be.revertedWithCustomError(order1, 'InsufficientSellBalance')
        .withArgs(requiredMinSell1, await token.balanceOf(orderAddress1))

      await expect(order2.isValidSignature(orderHash2, '0x'))
        .to.be.revertedWithCustomError(order2, 'InsufficientSellBalance')
        .withArgs(requiredMinSell2, await token.balanceOf(orderAddress2))

      expect(requiredMinSell2).to.be.closeTo(requiredMinSell1 * 2n, 2n)

      await localSnapshot.restore()
    })

    it('should handle isValidSignature with same sellAmount but different minFillBps values', async function () {
      const localSnapshot = await takeSnapshot()

      const sellAmount = ethers.parseEther('1')
      const minFillBps25 = 2500 // 25%
      const minFillBps50 = 5000 // 50%
      const minFillBps75 = 7500 // 75%

      // Deploy Stonks with 25% minFillBps
      const { stonks: stonks25 } = await deployStonksWithTestOracle({
        factoryParams: {
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: contracts.STETH,
          tokenTo: contracts.DAI,
          manager: await signer.getAddress(),
          marginInBps: marginInBps,
          orderDuration: 3600,
          priceToleranceInBps: 100,
          minFillBps: minFillBps25,
          allowPartialFill: true,
          amountConverterAddress: undefined,
        },
        amountConverterParams: {
          allowedTokensToSell: [contracts.STETH],
          allowedStableTokensToBuy: [contracts.DAI],
          useEthAnchor: false,
        },
      })

      // Deploy Stonks with 50% minFillBps
      const { stonks: stonks50 } = await deployStonksWithTestOracle({
        factoryParams: {
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: contracts.STETH,
          tokenTo: contracts.DAI,
          manager: await signer.getAddress(),
          marginInBps: marginInBps,
          orderDuration: 3600,
          priceToleranceInBps: 100,
          minFillBps: minFillBps50,
          allowPartialFill: true,
          amountConverterAddress: undefined,
        },
        amountConverterParams: {
          allowedTokensToSell: [contracts.STETH],
          allowedStableTokensToBuy: [contracts.DAI],
          useEthAnchor: false,
        },
      })

      // Deploy Stonks with 75% minFillBps
      const { stonks: stonks75 } = await deployStonksWithTestOracle({
        factoryParams: {
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: contracts.STETH,
          tokenTo: contracts.DAI,
          manager: await signer.getAddress(),
          marginInBps: marginInBps,
          orderDuration: 3600,
          priceToleranceInBps: 100,
          minFillBps: minFillBps75,
          allowPartialFill: true,
          amountConverterAddress: undefined,
        },
        amountConverterParams: {
          allowedTokensToSell: [contracts.STETH],
          allowedStableTokensToBuy: [contracts.DAI],
          useEthAnchor: false,
        },
      })

      // Fund all stonks instances with the same amount
      const fundAmount = sellAmount // Use the intended sellAmount
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: fundAmount,
        address: await stonks25.getAddress(),
      })
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: fundAmount,
        address: await stonks50.getAddress(),
      })
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: fundAmount,
        address: await stonks75.getAddress(),
      })

      // Get actual balances after funding (might differ slightly due to stETH shares rounding)
      const [tokenFrom] = await stonks25.getOrderParameters()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const balance25 = await token.balanceOf(await stonks25.getAddress())
      const balance50 = await token.balanceOf(await stonks50.getAddress())
      const balance75 = await token.balanceOf(await stonks75.getAddress())

      // Find minimum balance to use as sellAmount for all orders
      const minBalance =
        balance25 < balance50
          ? balance25 < balance75
            ? balance25
            : balance75
          : balance50 < balance75
            ? balance50
            : balance75

      // Place orders using placeOrderWithAmount with the minimum balance to ensure all succeed
      // We'll use the same sellAmount (minBalance) for all three orders to test same sellAmount with different minFillBps
      const expectedBuyAmount25 = await stonks25.estimateTradeOutput(minBalance)
      const placeOrderTx25 = await stonks25.placeOrderWithAmount(minBalance, expectedBuyAmount25)
      const placeOrderTxReceipt25 = await placeOrderTx25.wait()
      if (!placeOrderTxReceipt25) throw Error('placeOrderTxReceipt25 is null')

      const expectedBuyAmount50 = await stonks50.estimateTradeOutput(minBalance)
      const placeOrderTx50 = await stonks50.placeOrderWithAmount(minBalance, expectedBuyAmount50)
      const placeOrderTxReceipt50 = await placeOrderTx50.wait()
      if (!placeOrderTxReceipt50) throw Error('placeOrderTxReceipt50 is null')

      const expectedBuyAmount75 = await stonks75.estimateTradeOutput(minBalance)
      const placeOrderTx75 = await stonks75.placeOrderWithAmount(minBalance, expectedBuyAmount75)
      const placeOrderTxReceipt75 = await placeOrderTx75.wait()
      if (!placeOrderTxReceipt75) throw Error('placeOrderTxReceipt75 is null')

      const orderData25 = await getPlaceOrderData(placeOrderTxReceipt25)
      const order25 = await ethers.getContractAt('Order', orderData25.address, signer)
      const orderHash25 = await formOrderHashFromTxReceipt(placeOrderTxReceipt25)

      const orderData50 = await getPlaceOrderData(placeOrderTxReceipt50)
      const order50 = await ethers.getContractAt('Order', orderData50.address, signer)
      const orderHash50 = await formOrderHashFromTxReceipt(placeOrderTxReceipt50)

      const orderData75 = await getPlaceOrderData(placeOrderTxReceipt75)
      const order75 = await ethers.getContractAt('Order', orderData75.address, signer)
      const orderHash75 = await formOrderHashFromTxReceipt(placeOrderTxReceipt75)

      // Get order details
      const orderDetails25 = await order25.getOrderDetails()
      const orderDetails50 = await order50.getOrderDetails()
      const orderDetails75 = await order75.getOrderDetails()

      const sellAmount25 = orderDetails25[3]
      const sellAmount50 = orderDetails50[3]
      const sellAmount75 = orderDetails75[3]
      expect(sellAmount25).to.be.closeTo(sellAmount50, 2n)
      expect(sellAmount50).to.be.closeTo(sellAmount75, 2n)

      const requiredMinSell25 = calculateRequiredMinSell(sellAmount25, BigInt(minFillBps25))
      const requiredMinSell50 = calculateRequiredMinSell(sellAmount50, BigInt(minFillBps50))
      const requiredMinSell75 = calculateRequiredMinSell(sellAmount75, BigInt(minFillBps75))

      expect(requiredMinSell25).to.be.lessThan(requiredMinSell50)
      expect(requiredMinSell50).to.be.lessThan(requiredMinSell75)
      expect(requiredMinSell50).to.be.closeTo(requiredMinSell25 * 2n, 2n)
      expect(requiredMinSell75).to.be.closeTo(requiredMinSell25 * 3n, 2n)

      // tokenFrom and token already declared above
      const orderAddress25 = await order25.getAddress()
      const orderAddress50 = await order50.getAddress()
      const orderAddress75 = await order75.getAddress()

      const rebaseBalance25 = await token.balanceOf(orderAddress25)
      const rebaseBalance50 = await token.balanceOf(orderAddress50)
      const rebaseBalance75 = await token.balanceOf(orderAddress75)

      await ethers.provider.send('hardhat_impersonateAccount', [orderAddress25])
      await ethers.provider.send('hardhat_setBalance', [orderAddress25, '0x1000000000000000000'])
      const orderSigner25 = await ethers.getSigner(orderAddress25)
      const [, recipient] = await ethers.getSigners()
      const expectedBalance25AfterRebase = rebaseBalance25 - (rebaseBalance25 * 4000n) / 10000n
      const expectedBalance50AfterRebase = rebaseBalance50 - (rebaseBalance50 * 4000n) / 10000n
      const expectedBalance75AfterRebase = rebaseBalance75 - (rebaseBalance75 * 4000n) / 10000n

      await token
        .connect(orderSigner25)
        .transfer(await recipient.getAddress(), (rebaseBalance25 * 4000n) / 10000n)

      await ethers.provider.send('hardhat_impersonateAccount', [orderAddress50])
      await ethers.provider.send('hardhat_setBalance', [orderAddress50, '0x1000000000000000000'])
      const orderSigner50 = await ethers.getSigner(orderAddress50)
      await token
        .connect(orderSigner50)
        .transfer(await recipient.getAddress(), (rebaseBalance50 * 4000n) / 10000n)

      await ethers.provider.send('hardhat_impersonateAccount', [orderAddress75])
      await ethers.provider.send('hardhat_setBalance', [orderAddress75, '0x1000000000000000000'])
      const orderSigner75 = await ethers.getSigner(orderAddress75)
      await token
        .connect(orderSigner75)
        .transfer(await recipient.getAddress(), (rebaseBalance75 * 4000n) / 10000n)

      const finalBalance25 = await token.balanceOf(orderAddress25)
      const finalBalance50 = await token.balanceOf(orderAddress50)
      const finalBalance75 = await token.balanceOf(orderAddress75)

      expect(finalBalance25).to.be.closeTo(expectedBalance25AfterRebase, 2n)
      expect(finalBalance50).to.be.closeTo(expectedBalance50AfterRebase, 2n)
      expect(finalBalance75).to.be.closeTo(expectedBalance75AfterRebase, 2n)

      expect(finalBalance25).to.be.greaterThan(requiredMinSell25)
      expect(await order25.isValidSignature(orderHash25, '0x')).to.equal(MAGIC_VALUE)

      expect(finalBalance50).to.be.greaterThan(requiredMinSell50)
      expect(await order50.isValidSignature(orderHash50, '0x')).to.equal(MAGIC_VALUE)

      expect(finalBalance75).to.be.lessThan(requiredMinSell75)
      await expect(order75.isValidSignature(orderHash75, '0x'))
        .to.be.revertedWithCustomError(order75, 'InsufficientSellBalance')
        .withArgs(requiredMinSell75, finalBalance75)

      await localSnapshot.restore()
    })

    it('should verify MIN_FILL_BPS check happens before price validation checks', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill50.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill50.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill50.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      const requiredMinSell = calculateRequiredMinSell(sellAmount, 5000n)

      const [tokenFrom] = await stonksPartialFillMinFill50.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = (initialBalance * 6000n) / 10000n

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const expectedBalanceAfterRebase = initialBalance - rebaseAmount
      const finalBalance = await token.balanceOf(orderAddress)
      expect(finalBalance).to.be.closeTo(expectedBalanceAfterRebase, 2n)
      expect(finalBalance).to.be.lessThan(requiredMinSell)

      await expect(order.isValidSignature(orderHash, '0x'))
        .to.be.revertedWithCustomError(order, 'InsufficientSellBalance')
        .withArgs(requiredMinSell, finalBalance)

      await localSnapshot.restore()
    })

    it('should verify MIN_FILL_BPS check happens after balance availability check when partial fills enabled', async function () {
      const localSnapshot = await takeSnapshot()

      // Fund stonks
      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksPartialFillMinFill50.getAddress(),
      })

      // Place order
      const expectedBuyAmount =
        await stonksPartialFillMinFill50.estimateTradeOutputFromCurrentBalance()
      const placeOrderTx = await stonksPartialFillMinFill50.placeOrder(expectedBuyAmount)
      const placeOrderTxReceipt = await placeOrderTx.wait()
      if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

      const orderData = await getPlaceOrderData(placeOrderTxReceipt)
      const order = await ethers.getContractAt('Order', orderData.address, signer)
      const orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
      const orderDetails = await order.getOrderDetails()
      const sellAmount = orderDetails[3]

      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      const requiredMinSell = calculateRequiredMinSell(sellAmount, 5000n)

      const [tokenFrom] = await stonksPartialFillMinFill50.getOrderParameters()
      const orderAddress = await order.getAddress()
      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const initialBalance = await token.balanceOf(orderAddress)
      const rebaseAmount = initialBalance / 2n

      await simulateNegativeRebase(tokenFrom, orderAddress, rebaseAmount)

      const expectedBalanceAtMin = initialBalance - rebaseAmount
      const balanceAtMin = await token.balanceOf(orderAddress)
      expect(balanceAtMin).to.be.closeTo(expectedBalanceAtMin, 2n)
      expect(balanceAtMin).to.be.closeTo(requiredMinSell, 2n)
      expect(await order.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)

      await localSnapshot.restore()
    })

    this.afterAll(async function () {
      await snapshot.restore()
    })
  })

  describe('access control:', function () {
    let stranger: Signer

    this.beforeAll(async function () {
      stranger = (await ethers.getSigners())[3]
    })

    it('should revert placeOrder when called by non-agent/manager', async function () {
      const stonksAsStranger = subject.connect(stranger)
      await expect(stonksAsStranger.placeOrder(100))
        .to.be.revertedWithCustomError(subject, 'NotAgentOrManager')
        .withArgs(await stranger.getAddress())
    })

    it('should revert placeOrderWithAmount when called by non-agent/manager', async function () {
      const stonksAsStranger = subject.connect(stranger)
      await expect(stonksAsStranger.placeOrderWithAmount(ethers.parseEther('1'), 100))
        .to.be.revertedWithCustomError(subject, 'NotAgentOrManager')
        .withArgs(await stranger.getAddress())
    })

    it('should revert recoverERC20 when called by non-agent/manager', async function () {
      const stonksAsStranger = subject.connect(stranger)
      await expect(stonksAsStranger.recoverERC20(contracts.DAI, 1))
        .to.be.revertedWithCustomError(subject, 'NotAgentOrManager')
        .withArgs(await stranger.getAddress())
    })

    it('should revert recoverEther when called by non-agent/manager', async function () {
      const stonksAsStranger = subject.connect(stranger)
      await expect(stonksAsStranger.recoverEther())
        .to.be.revertedWithCustomError(subject, 'NotAgentOrManager')
        .withArgs(await stranger.getAddress())
    })

    it('should revert recoverERC721 when called by non-agent/manager', async function () {
      const stonksAsStranger = subject.connect(stranger)
      const mockNftAddress = '0x0000000000000000000000000000000000000001'
      await expect(stonksAsStranger.recoverERC721(mockNftAddress, 1))
        .to.be.revertedWithCustomError(subject, 'NotAgentOrManager')
        .withArgs(await stranger.getAddress())
    })

    it('should revert recoverERC1155 when called by non-agent/manager', async function () {
      const stonksAsStranger = subject.connect(stranger)
      const mockNftAddress = '0x0000000000000000000000000000000000000001'
      await expect(stonksAsStranger.recoverERC1155(mockNftAddress, 1))
        .to.be.revertedWithCustomError(subject, 'NotAgentOrManager')
        .withArgs(await stranger.getAddress())
    })
  })

  describe('recovery functions:', function () {
    it('should successfully recover ERC20 tokens', async function () {
      const daiToken = await ethers.getContractAt('IERC20', contracts.DAI)
      const recoverAmount = ethers.parseEther('100')

      await fillUpERC20FromTreasury({
        token: contracts.DAI,
        amount: recoverAmount,
        address: await subject.getAddress(),
      })

      const stonksBalanceBefore = await daiToken.balanceOf(await subject.getAddress())
      const agentBalanceBefore = await daiToken.balanceOf(contracts.AGENT)

      await subject.recoverERC20(contracts.DAI, recoverAmount)

      const stonksBalanceAfter = await daiToken.balanceOf(await subject.getAddress())
      const agentBalanceAfter = await daiToken.balanceOf(contracts.AGENT)

      expect(stonksBalanceBefore - stonksBalanceAfter).to.equal(recoverAmount)
      expect(agentBalanceAfter - agentBalanceBefore).to.equal(recoverAmount)
    })
  })

  this.afterAll(async function () {
    await snapshot.restore()
    resetTestOracleRouter() // Clean up global state
  })
})
