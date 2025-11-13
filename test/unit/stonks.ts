import { ethers } from 'hardhat'
import { Signer } from 'ethers'
import { expect } from 'chai'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import { isClose } from '../../utils/assert'
import { deployStonksWithTestOracle, resetTestOracleRouter } from '../../utils/test-oracle-router'
import { refreshTestFeedData } from '../../utils/test-feed-registry'
import {
  AmountConverter,
  AssetRecovererTest__factory,
  Stonks,
  Stonks__factory,
  OracleRouter__factory,
} from '../../typechain-types'
import { getContracts } from '../../utils/contracts'
import { fillUpERC20FromTreasury } from '../../utils/fill-up-balance'
import { MAX_BASIS_POINTS } from '../../utils/gpv2-helpers'
import { getExpectedOut } from '../../utils/chainlink-helpers'

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
    type ContractFactory = Parameters<typeof ContractFactory.deploy>

    let validParams: {
      agent: ContractFactory[0]
      manager: ContractFactory[1]
      tokenFrom: ContractFactory[2]
      tokenTo: ContractFactory[3]
      amountConverter: ContractFactory[4]
      orderSample: ContractFactory[5]
      oracleRouter: ContractFactory[6]
      orderDurationInSeconds: ContractFactory[7]
      marginInBasisPoints: ContractFactory[8]
      priceToleranceInBasisPoints: ContractFactory[9]
      maxImprovementInBasisPoints: ContractFactory[10]
      allowPartialFill: ContractFactory[11]
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
        amountConverter: subjectTokenConverter,
        orderSample: notZeroAddress,
        orderDurationInSeconds: 60,
        marginInBasisPoints: 1000,
        priceToleranceInBasisPoints: 999,
        maxImprovementInBasisPoints: 0,
        allowPartialFill: false,
        oracleRouter,
      } as const
    })

    it('should set correct constructor params', async () => {
      const stonks = await ContractFactory.deploy(
        validParams.agent,
        validParams.manager,
        validParams.tokenFrom,
        validParams.tokenTo,
        validParams.amountConverter,
        validParams.orderSample,
        validParams.oracleRouter,
        validParams.orderDurationInSeconds,
        validParams.marginInBasisPoints,
        validParams.priceToleranceInBasisPoints,
        validParams.maxImprovementInBasisPoints,
        validParams.allowPartialFill
      )

      const [tokenFrom, tokenTo, orderDurationInSeconds] = await stonks.getOrderParameters()
      const priceToleranceInBasisPoints = await stonks.getPriceTolerance()

      expect(tokenFrom).to.be.equal(validParams.tokenFrom)
      expect(tokenTo).to.be.equal(validParams.tokenTo)
      expect(orderDurationInSeconds).to.be.equal(validParams.orderDurationInSeconds)
      expect(priceToleranceInBasisPoints).to.be.equal(validParams.priceToleranceInBasisPoints)
    })

    it('should emit events for every parameter', async () => {
      const stonksLocal = await ContractFactory.deploy(
        validParams.agent,
        validParams.manager,
        validParams.tokenFrom,
        validParams.tokenTo,
        validParams.amountConverter,
        validParams.orderSample,
        validParams.oracleRouter,
        validParams.orderDurationInSeconds,
        validParams.marginInBasisPoints,
        validParams.priceToleranceInBasisPoints,
        validParams.maxImprovementInBasisPoints,
        validParams.allowPartialFill
      )

      await expect(stonksLocal.deploymentTransaction())
        .to.emit(stonksLocal, 'ManagerSet')
        .withArgs(validParams.manager)
        .and.to.emit(stonksLocal, 'AmountConverterSet')
        .withArgs(await (validParams.amountConverter as AmountConverter).getAddress())
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
        ContractFactory.deploy(
          ethers.ZeroAddress,
          validParams.manager,
          validParams.tokenFrom,
          validParams.tokenTo,
          validParams.amountConverter,
          validParams.orderSample,
          validParams.oracleRouter,
          validParams.orderDurationInSeconds,
          validParams.marginInBasisPoints,
          validParams.priceToleranceInBasisPoints,
          validParams.maxImprovementInBasisPoints,
          validParams.allowPartialFill
        )
      )
        .to.be.revertedWithCustomError(AssetRecovererFactory, 'InvalidAgentAddress')
        .withArgs(ethers.ZeroAddress)
    })
    it('should not initialize with manager zero address', async function () {
      await expect(
        ContractFactory.deploy(
          validParams.agent,
          ethers.ZeroAddress,
          validParams.tokenFrom,
          validParams.tokenTo,
          validParams.amountConverter,
          validParams.orderSample,
          validParams.oracleRouter,
          validParams.orderDurationInSeconds,
          validParams.marginInBasisPoints,
          validParams.priceToleranceInBasisPoints,
          validParams.maxImprovementInBasisPoints,
          validParams.allowPartialFill
        )
      )
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidManagerAddress')
        .withArgs(ethers.ZeroAddress)
    })
    it('should not initialize with tokenFrom zero address', async function () {
      await expect(
        ContractFactory.deploy(
          validParams.agent,
          validParams.manager,
          ethers.ZeroAddress,
          validParams.tokenTo,
          validParams.amountConverter,
          validParams.orderSample,
          validParams.oracleRouter,
          validParams.orderDurationInSeconds,
          validParams.marginInBasisPoints,
          validParams.priceToleranceInBasisPoints,
          validParams.maxImprovementInBasisPoints,
          validParams.allowPartialFill
        )
      )
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidTokenFromAddress')
        .withArgs(ethers.ZeroAddress)
    })
    it('should not initialize with tokenTo zero address', async function () {
      await expect(
        ContractFactory.deploy(
          validParams.agent,
          validParams.manager,
          validParams.tokenFrom,
          ethers.ZeroAddress,
          validParams.amountConverter,
          validParams.orderSample,
          validParams.oracleRouter,
          validParams.orderDurationInSeconds,
          validParams.marginInBasisPoints,
          validParams.priceToleranceInBasisPoints,
          validParams.maxImprovementInBasisPoints,
          validParams.allowPartialFill
        )
      )
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidTokenToAddress')
        .withArgs(ethers.ZeroAddress)
    })
    it('should not initialize with same tokens address', async function () {
      await expect(
        ContractFactory.deploy(
          validParams.agent,
          validParams.manager,
          contracts.STETH,
          contracts.STETH,
          validParams.amountConverter,
          validParams.orderSample,
          validParams.oracleRouter,
          validParams.orderDurationInSeconds,
          validParams.marginInBasisPoints,
          validParams.priceToleranceInBasisPoints,
          validParams.maxImprovementInBasisPoints,
          validParams.allowPartialFill
        )
      ).to.be.revertedWithCustomError(ContractFactory, 'TokensCannotBeSame')
    })
    it('should not initialize with amountConverter zero address', async function () {
      await expect(
        ContractFactory.deploy(
          validParams.agent,
          validParams.manager,
          validParams.tokenFrom,
          validParams.tokenTo,
          ethers.ZeroAddress,
          validParams.orderSample,
          validParams.oracleRouter,
          validParams.orderDurationInSeconds,
          validParams.marginInBasisPoints,
          validParams.priceToleranceInBasisPoints,
          validParams.maxImprovementInBasisPoints,
          validParams.allowPartialFill
        )
      )
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidAmountConverterAddress')
        .withArgs(ethers.ZeroAddress)
    })
    it('should not initialize with orderSample zero address', async function () {
      await expect(
        ContractFactory.deploy(
          validParams.agent,
          validParams.manager,
          validParams.tokenFrom,
          validParams.tokenTo,
          validParams.amountConverter,
          ethers.ZeroAddress,
          validParams.oracleRouter,
          validParams.orderDurationInSeconds,
          validParams.marginInBasisPoints,
          validParams.priceToleranceInBasisPoints,
          validParams.maxImprovementInBasisPoints,
          validParams.allowPartialFill
        )
      )
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidOrderSampleAddress')
        .withArgs(ethers.ZeroAddress)
    })
    it('should not initialize with orderDurationInSeconds less than 60', async function () {
      await expect(
        ContractFactory.deploy(
          validParams.agent,
          validParams.manager,
          validParams.tokenFrom,
          validParams.tokenTo,
          validParams.amountConverter,
          validParams.orderSample,
          validParams.oracleRouter,
          59,
          validParams.marginInBasisPoints,
          validParams.priceToleranceInBasisPoints,
          validParams.maxImprovementInBasisPoints,
          validParams.allowPartialFill
        )
      )
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidOrderDuration')
        .withArgs(60, 86400, 59)
    })
    it('should not initialize with orderDurationInSeconds more than day', async function () {
      await expect(
        ContractFactory.deploy(
          validParams.agent,
          validParams.manager,
          validParams.tokenFrom,
          validParams.tokenTo,
          validParams.amountConverter,
          validParams.orderSample,
          validParams.oracleRouter,
          60 * 60 * 24 + 1,
          validParams.marginInBasisPoints,
          validParams.priceToleranceInBasisPoints,
          validParams.maxImprovementInBasisPoints,
          validParams.allowPartialFill
        )
      )
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidOrderDuration')
        .withArgs(60, 86400, 86401)
    })
    it('should not initialize with marginInBasisPoints_ less or equal 1000', async function () {
      await expect(
        ContractFactory.deploy(
          validParams.agent,
          validParams.manager,
          validParams.tokenFrom,
          validParams.tokenTo,
          validParams.amountConverter,
          validParams.orderSample,
          validParams.oracleRouter,
          validParams.orderDurationInSeconds,
          1001,
          validParams.priceToleranceInBasisPoints,
          validParams.maxImprovementInBasisPoints,
          validParams.allowPartialFill
        )
      )
        .to.be.revertedWithCustomError(ContractFactory, 'MarginOverflowsAllowedLimit')
        .withArgs(1000, 1001)
    })
    it('should not initialize with priceToleranceInBasisPoints_ less or equal 1000', async function () {
      await expect(
        ContractFactory.deploy(
          validParams.agent,
          validParams.manager,
          validParams.tokenFrom,
          validParams.tokenTo,
          validParams.amountConverter,
          validParams.orderSample,
          validParams.oracleRouter,
          validParams.orderDurationInSeconds,
          validParams.marginInBasisPoints,
          1001,
          validParams.maxImprovementInBasisPoints,
          validParams.allowPartialFill
        )
      )
        .to.be.revertedWithCustomError(ContractFactory, 'PriceToleranceOverflowsAllowedLimit')
        .withArgs(1000, 1001)
    })
    it('should not initialize with maxImprovementInBasisPoints_ over limit (when not type(uint256).max)', async function () {
      await expect(
        ContractFactory.deploy(
          validParams.agent,
          validParams.manager,
          validParams.tokenFrom,
          validParams.tokenTo,
          validParams.amountConverter,
          validParams.orderSample,
          validParams.oracleRouter,
          validParams.orderDurationInSeconds,
          validParams.marginInBasisPoints,
          validParams.priceToleranceInBasisPoints,
          1001,
          validParams.allowPartialFill
        )
      )
        .to.be.revertedWithCustomError(ContractFactory, 'MarginOverflowsAllowedLimit')
        .withArgs(1000, 1001)
    })
    it('should allow maxImprovementInBasisPoints_ equal to type(uint256).max', async function () {
      const stonks = await ContractFactory.deploy(
        validParams.agent,
        validParams.manager,
        validParams.tokenFrom,
        validParams.tokenTo,
        validParams.amountConverter,
        validParams.orderSample,
        validParams.oracleRouter,
        validParams.orderDurationInSeconds,
        validParams.marginInBasisPoints,
        validParams.priceToleranceInBasisPoints,
        ethers.MaxUint256,
        validParams.allowPartialFill
      )
      await stonks.waitForDeployment()
      expect(await stonks.getMaxImprovementBps()).to.equal(ethers.MaxUint256)
    })
    it('should not initialize with oracleRouter zero address', async function () {
      await expect(
        ContractFactory.deploy(
          validParams.agent,
          validParams.manager,
          validParams.tokenFrom,
          validParams.tokenTo,
          validParams.amountConverter,
          validParams.orderSample,
          ethers.ZeroAddress,
          validParams.orderDurationInSeconds,
          validParams.marginInBasisPoints,
          validParams.priceToleranceInBasisPoints,
          validParams.maxImprovementInBasisPoints,
          validParams.allowPartialFill
        )
      )
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidOracleRouterAddress')
        .withArgs(ethers.ZeroAddress)
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
      expect(isClose(await steth.balanceOf(subject), amount, 2n)).to.be.true

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
      expect(isClose(diff, sellAmount, 1n)).to.be.true
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
