import { ethers } from 'hardhat'
import { Signer } from 'ethers'
import { expect } from 'chai'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import { isClose } from '../../utils/assert'
import { deployStonks } from '../../scripts/deployments/stonks'
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

    const { stonks, amountConverter: tokenConverter } = await deployStonks({
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
      },
      amountConverterParams: {
        conversionTarget: '0x0000000000000000000000000000000000000348', // USD
        allowedTokensToSell: [contracts.STETH],
        allowedStableTokensToBuy: [contracts.DAI],
        priceFeedsHeartbeatTimeouts: [3600],
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
      orderDurationInSeconds: ContractFactory[6]
      marginInBasisPoints: ContractFactory[7]
      priceToleranceInBasisPoints: ContractFactory[8]
    }

    this.beforeAll(async function () {
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
        validParams.orderDurationInSeconds,
        validParams.marginInBasisPoints,
        validParams.priceToleranceInBasisPoints
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
        validParams.orderDurationInSeconds,
        validParams.marginInBasisPoints,
        validParams.priceToleranceInBasisPoints
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
          validParams.orderDurationInSeconds,
          validParams.marginInBasisPoints,
          validParams.priceToleranceInBasisPoints
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
          validParams.orderDurationInSeconds,
          validParams.marginInBasisPoints,
          validParams.priceToleranceInBasisPoints
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
          validParams.orderDurationInSeconds,
          validParams.marginInBasisPoints,
          validParams.priceToleranceInBasisPoints
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
          validParams.orderDurationInSeconds,
          validParams.marginInBasisPoints,
          validParams.priceToleranceInBasisPoints
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
          validParams.orderDurationInSeconds,
          validParams.marginInBasisPoints,
          validParams.priceToleranceInBasisPoints
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
          validParams.orderDurationInSeconds,
          validParams.marginInBasisPoints,
          validParams.priceToleranceInBasisPoints
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
          validParams.orderDurationInSeconds,
          validParams.marginInBasisPoints,
          validParams.priceToleranceInBasisPoints
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
          59,
          validParams.marginInBasisPoints,
          validParams.priceToleranceInBasisPoints
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
          60 * 60 * 24 + 1,
          validParams.marginInBasisPoints,
          validParams.priceToleranceInBasisPoints
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
          validParams.orderDurationInSeconds,
          1001,
          validParams.priceToleranceInBasisPoints
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
          validParams.orderDurationInSeconds,
          validParams.marginInBasisPoints,
          1001
        )
      )
        .to.be.revertedWithCustomError(ContractFactory, 'PriceToleranceOverflowsAllowedLimit')
        .withArgs(1000, 1001)
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

    it('should place order', async function () {
      const steth = await ethers.getContractAt('IERC20', contracts.STETH, signer)

      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount,
        address: await subject.getAddress(),
      })
      expect(isClose(await steth.balanceOf(subject), amount, 1n)).to.be.true

      const expectedBuyAmount = await subject.estimateTradeOutputFromCurrentBalance()
      const tx = await subject.placeOrder(expectedBuyAmount)
      await tx.wait()
    })
  })

  this.afterAll(async function () {
    await snapshot.restore()
  })
})
