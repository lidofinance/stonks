import { ethers } from 'hardhat'
import { Signer } from 'ethers'
import { expect } from 'chai'
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs'
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
} from '../../typechain-types'
import { getContracts } from '../../utils/contracts'
import { fillUpERC20FromTreasury } from '../../utils/fill-up-balance'
import { MAX_BASIS_POINTS } from '../../utils/gpv2-helpers'
import { getExpectedOut } from '../../utils/chainlink-helpers'
import { deployAmountConverterFactory } from '../../scripts/deployments/amount-converter-factory'
import { getTokenConverterDeployment, getPlaceOrderData } from '../../utils/get-events'

const contracts = getContracts()

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

  before(async function () {
    signer = (await ethers.getSigners())[0]
    snapshot = await takeSnapshot()

    ContractFactory = await ethers.getContractFactory('Stonks')
    AssetRecovererFactory = await ethers.getContractFactory('AssetRecovererTest')
    managerAddress = await signer.getAddress()

    await refreshTestFeedData([contracts.STETH, contracts.DAI])

    const { stonks, amountConverter: tokenConverter } = await deployStonksWithTestOracle({
      factoryParams: {
        admin: contracts.ADMIN,
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
        allowedTokensToBuy: [contracts.DAI],
        useEthAnchor: false,
      },
    })

    subject = stonks
    subjectTokenConverter = tokenConverter
  })

  describe('initialization:', function () {
    const notZeroAddress = '0x0000000000000000000000000000000000000999'

    let validParams: {
      admin: string
      agent: string
      manager: string
      tokenFrom: string
      tokenTo: string
      amountConverter: string
      orderSample: string
      orderDurationInSeconds: number
      marginInBasisPoints: number
      priceToleranceInBasisPoints: number
      maxImprovementInBasisPoints: bigint
      allowPartialFill: boolean
    }

    before(async function () {
      validParams = {
        admin: contracts.ADMIN,
        agent: contracts.AGENT,
        manager: managerAddress,
        tokenFrom: contracts.STETH,
        tokenTo: contracts.DAI,
        amountConverter: await (subjectTokenConverter as AmountConverter).getAddress(),
        orderSample: notZeroAddress,
        orderDurationInSeconds: 60,
        marginInBasisPoints: 1000,
        priceToleranceInBasisPoints: 999,
        maxImprovementInBasisPoints: 0n,
        allowPartialFill: false,
      } as const
    })

    it('should set correct constructor params', async function () {
      const stonks = await ContractFactory.deploy(validParams)

      expect(await stonks.ADMIN()).to.equal(validParams.admin)
      expect(await stonks.AGENT()).to.equal(validParams.agent)
      const [tokenFrom, tokenTo, orderDurationInSeconds] = await stonks.getOrderParameters()
      const priceToleranceInBasisPoints = await stonks.getPriceTolerance()

      expect(tokenFrom).to.be.equal(validParams.tokenFrom)
      expect(tokenTo).to.be.equal(validParams.tokenTo)
      expect(orderDurationInSeconds).to.be.equal(validParams.orderDurationInSeconds)
      expect(priceToleranceInBasisPoints).to.be.equal(validParams.priceToleranceInBasisPoints)
    })

    it('should emit events for every parameter', async function () {
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
        .and.to.emit(stonksLocal, 'MaxImprovementInBasisPointsSet')
        .withArgs(validParams.maxImprovementInBasisPoints)
        .and.to.emit(stonksLocal, 'AllowPartialFillSet')
        .withArgs(validParams.allowPartialFill)
    })

    it('should emit MaxImprovementInBasisPointsSet event with correct value', async function () {
      const testParams = {
        ...validParams,
        maxImprovementInBasisPoints: 500n,
      }
      const stonksLocal = await ContractFactory.deploy(testParams)

      await expect(stonksLocal.deploymentTransaction())
        .to.emit(stonksLocal, 'MaxImprovementInBasisPointsSet')
        .withArgs(500n)
    })

    it('should emit MaxImprovementInBasisPointsSet event with type(uint256).max', async function () {
      const testParams = {
        ...validParams,
        maxImprovementInBasisPoints: ethers.MaxUint256,
      }
      const stonksLocal = await ContractFactory.deploy(testParams)

      await expect(stonksLocal.deploymentTransaction())
        .to.emit(stonksLocal, 'MaxImprovementInBasisPointsSet')
        .withArgs(ethers.MaxUint256)
    })

    it('should emit AllowPartialFillSet event with true', async function () {
      const testParams = {
        ...validParams,
        allowPartialFill: true,
      }
      const stonksLocal = await ContractFactory.deploy(testParams)

      await expect(stonksLocal.deploymentTransaction())
        .to.emit(stonksLocal, 'AllowPartialFillSet')
        .withArgs(true)
    })

    it('should emit AllowPartialFillSet event with false', async function () {
      const stonksLocal = await ContractFactory.deploy(validParams)

      await expect(stonksLocal.deploymentTransaction())
        .to.emit(stonksLocal, 'AllowPartialFillSet')
        .withArgs(false)
    })

    it('should not initialize with admin zero address', async function () {
      const invalidParams = { ...validParams, admin: ethers.ZeroAddress }
      await expect(ContractFactory.deploy(invalidParams))
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidAdminAddress')
        .withArgs(ethers.ZeroAddress)
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
        .to.be.revertedWithCustomError(ContractFactory, 'MaxImprovementOverflowsAllowedLimit')
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

    it('should revert when tokenFrom is not in allowedTokensToSell', async function () {
      const localSnapshot = await takeSnapshot()

      const oracleRouter = await getTestOracleRouter({
        tokens: [contracts.STETH, contracts.USDC, contracts.DAI],
      })

      const { amountConverterFactory } = await deployAmountConverterFactory(
        await oracleRouter.getAddress()
      )

      const deployTx = await amountConverterFactory.deployAmountConverter(
        [contracts.STETH],
        [contracts.DAI],
        false
      )
      const receipt = await deployTx.wait()
      if (!receipt) throw new Error('No transaction receipt')

      const { address: amountConverterAddress } = getTokenConverterDeployment(receipt)
      const amountConverter = await ethers.getContractAt('AmountConverter', amountConverterAddress)

      expect(await amountConverter.allowedTokensToSell(contracts.USDC)).to.equal(false)

      await expect(
        ContractFactory.deploy({
          ...validParams,
          tokenFrom: contracts.USDC,
          amountConverter: amountConverterAddress,
        })
      )
        .to.be.revertedWithCustomError(ContractFactory, 'TokenFromNotSupported')
        .withArgs(contracts.USDC)

      await localSnapshot.restore()
    })

    it('should revert when tokenTo is not in allowedTokensToBuy', async function () {
      const localSnapshot = await takeSnapshot()

      const oracleRouter = await getTestOracleRouter({
        tokens: [contracts.STETH, contracts.USDC, contracts.DAI],
      })

      const { amountConverterFactory } = await deployAmountConverterFactory(
        await oracleRouter.getAddress()
      )

      const deployTx = await amountConverterFactory.deployAmountConverter(
        [contracts.STETH],
        [contracts.DAI],
        false
      )
      const receipt = await deployTx.wait()
      if (!receipt) throw new Error('No transaction receipt')

      const { address: amountConverterAddress } = getTokenConverterDeployment(receipt)
      const amountConverter = await ethers.getContractAt('AmountConverter', amountConverterAddress)

      expect(await amountConverter.allowedTokensToBuy(contracts.USDC)).to.equal(false)

      await expect(
        ContractFactory.deploy({
          ...validParams,
          tokenTo: contracts.USDC,
          amountConverter: amountConverterAddress,
        })
      )
        .to.be.revertedWithCustomError(ContractFactory, 'TokenToNotSupported')
        .withArgs(contracts.USDC)

      await localSnapshot.restore()
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
    it('should revert if balance is zero', async function () {
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
      const oracleRouter = await ethers.getContractAt(
        'OracleRouter',
        await subjectTokenConverter.ORACLE_ROUTER()
      )
      const adminSigner = await ethers.getImpersonatedSigner(contracts.ADMIN)
      await ethers.provider.send('hardhat_setBalance', [contracts.ADMIN, '0x1000000000000000000'])

      const [tokenFrom, tokenTo] = await subject.getOrderParameters()
      await oracleRouter.connect(adminSigner).setTokenActive(tokenFrom, false)
      await oracleRouter.connect(adminSigner).setTokenActive(tokenTo, false)

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
      const receipt = await tx.wait()
      if (!receipt) throw new Error('No transaction receipt')

      const { address: orderAddress } = await getPlaceOrderData(receipt)
      const order = await ethers.getContractAt('Order', orderAddress)

      await expect(tx)
        .to.emit(subject, 'OrderContractCreated')
        .withArgs(orderAddress, expectedBuyAmount)
        .and.to.emit(order, 'ManagerSet')
        .withArgs(await signer.getAddress())
        .and.to.emit(order, 'OrderCreated')
        .withArgs(orderAddress, anyValue, anyValue)
    })

    it('placeOrderWithAmount sends only specified amount', async function () {
      const steth = await ethers.getContractAt('IERC20', contracts.STETH, signer)
      const stonksAddr = await subject.getAddress()

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
      if (!rc) throw new Error('No transaction receipt')
      expect(rc.status).to.equal(1)

      const { address: orderAddress } = await getPlaceOrderData(rc)
      const order = await ethers.getContractAt('Order', orderAddress)

      await expect(tx)
        .to.emit(subject, 'OrderContractCreated')
        .withArgs(orderAddress, minBuy)
        .and.to.emit(order, 'ManagerSet')
        .withArgs(await signer.getAddress())
        .and.to.emit(order, 'OrderCreated')
        .withArgs(orderAddress, anyValue, anyValue)

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

  describe('unconfigured tokens in oracle router:', function () {
    it('should revert placeOrder when tokenFrom is not configured in OracleRouter', async function () {
      const localSnapshot = await takeSnapshot()

      // Get the existing oracle router from the subject
      const amountConverterAddress = await subject.AMOUNT_CONVERTER()
      const amountConverter = await ethers.getContractAt('AmountConverter', amountConverterAddress)
      const oracleRouterAddress = await amountConverter.ORACLE_ROUTER()
      const oracleRouter = await ethers.getContractAt('OracleRouter', oracleRouterAddress)

      // Deactivate STETH in the existing router
      const adminSigner = await ethers.getImpersonatedSigner(contracts.ADMIN)
      await ethers.provider.send('hardhat_setBalance', [contracts.ADMIN, '0x1000000000000000000'])
      await oracleRouter.connect(adminSigner).setTokenActive(contracts.STETH, false)

      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await subject.getAddress(),
      })

      await expect(subject.placeOrder(100)).to.be.revertedWithCustomError(
        oracleRouter,
        'TokenNotConfigured'
      )

      await localSnapshot.restore()
    })

    it('should revert placeOrder when tokenTo is not configured in OracleRouter', async function () {
      const localSnapshot = await takeSnapshot()

      // Get the existing oracle router from the subject
      const amountConverterAddress = await subject.AMOUNT_CONVERTER()
      const amountConverter = await ethers.getContractAt('AmountConverter', amountConverterAddress)
      const oracleRouterAddress = await amountConverter.ORACLE_ROUTER()
      const oracleRouter = await ethers.getContractAt('OracleRouter', oracleRouterAddress)

      // Deactivate DAI in the existing router
      const adminSigner = await ethers.getImpersonatedSigner(contracts.ADMIN)
      await ethers.provider.send('hardhat_setBalance', [contracts.ADMIN, '0x1000000000000000000'])
      await oracleRouter.connect(adminSigner).setTokenActive(contracts.DAI, false)

      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await subject.getAddress(),
      })

      await expect(subject.placeOrder(100)).to.be.revertedWithCustomError(
        oracleRouter,
        'TokenNotConfigured'
      )

      await localSnapshot.restore()
    })

    it('should revert placeOrderWithAmount when tokenFrom is not configured in OracleRouter', async function () {
      const localSnapshot = await takeSnapshot()

      // Get the existing oracle router from the subject
      const amountConverterAddress = await subject.AMOUNT_CONVERTER()
      const amountConverter = await ethers.getContractAt('AmountConverter', amountConverterAddress)
      const oracleRouterAddress = await amountConverter.ORACLE_ROUTER()
      const oracleRouter = await ethers.getContractAt('OracleRouter', oracleRouterAddress)

      // Deactivate STETH in the existing router
      const adminSigner = await ethers.getImpersonatedSigner(contracts.ADMIN)
      await ethers.provider.send('hardhat_setBalance', [contracts.ADMIN, '0x1000000000000000000'])
      await oracleRouter.connect(adminSigner).setTokenActive(contracts.STETH, false)

      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await subject.getAddress(),
      })

      await expect(
        subject.placeOrderWithAmount(ethers.parseEther('0.5'), 100)
      ).to.be.revertedWithCustomError(oracleRouter, 'TokenNotConfigured')

      await localSnapshot.restore()
    })
  })

  describe('access control:', function () {
    let stranger: Signer

    before(async function () {
      stranger = (await ethers.getSigners())[3]
    })

    it('should revert placeOrder when called by non-admin/manager', async function () {
      const stonksAsStranger = subject.connect(stranger)
      await expect(stonksAsStranger.placeOrder(100))
        .to.be.revertedWithCustomError(subject, 'NotAdminOrManager')
        .withArgs(await stranger.getAddress())
    })

    it('should revert placeOrderWithAmount when called by non-admin/manager', async function () {
      const stonksAsStranger = subject.connect(stranger)
      await expect(stonksAsStranger.placeOrderWithAmount(ethers.parseEther('1'), 100))
        .to.be.revertedWithCustomError(subject, 'NotAdminOrManager')
        .withArgs(await stranger.getAddress())
    })

    it('should revert recoverERC20 when called by non-admin/manager', async function () {
      const stonksAsStranger = subject.connect(stranger)
      await expect(stonksAsStranger.recoverERC20(contracts.DAI, 1))
        .to.be.revertedWithCustomError(subject, 'NotAdminOrManager')
        .withArgs(await stranger.getAddress())
    })

    it('should revert recoverEther when called by non-admin/manager', async function () {
      const stonksAsStranger = subject.connect(stranger)
      await expect(stonksAsStranger.recoverEther())
        .to.be.revertedWithCustomError(subject, 'NotAdminOrManager')
        .withArgs(await stranger.getAddress())
    })

    it('should revert recoverERC721 when called by non-admin/manager', async function () {
      const stonksAsStranger = subject.connect(stranger)
      const mockNftAddress = '0x0000000000000000000000000000000000000001'
      await expect(stonksAsStranger.recoverERC721(mockNftAddress, 1))
        .to.be.revertedWithCustomError(subject, 'NotAdminOrManager')
        .withArgs(await stranger.getAddress())
    })

    it('should revert recoverERC1155 when called by non-admin/manager', async function () {
      const stonksAsStranger = subject.connect(stranger)
      const mockNftAddress = '0x0000000000000000000000000000000000000001'
      await expect(stonksAsStranger.recoverERC1155(mockNftAddress, 1))
        .to.be.revertedWithCustomError(subject, 'NotAdminOrManager')
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

  after(async function () {
    await snapshot.restore()
    resetTestOracleRouter()
  })
})
