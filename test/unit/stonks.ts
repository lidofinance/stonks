import { ethers, network } from 'hardhat'
import { Signer } from 'ethers'
import { expect } from 'chai'
import { isClose } from '../../utils/assert'
import { deployStonks } from '../../scripts/deployments/stonks'
import {
  AmountConverter,
  AssetRecovererTest__factory,
  Stonks,
  Stonks__factory,
} from '../../typechain-types'
import { mainnet } from '../../utils/contracts'
import { fillUpERC20FromTreasury } from '../../utils/fill-up-balance'
import { MAX_BASIS_POINTS } from '../../utils/gpv2-helpers'
import { getExpectedOut } from '../../utils/chainlink-helpers'

describe('Stonks', function () {
  let signer: Signer
  let subject: Stonks
  let subjectTokenConverter: AmountConverter
  let snapshotId: string

  const amount = ethers.parseEther('1')
  const marginInBps = 100

  let ContractFactory: Stonks__factory
  let AssetRecovererFactory: AssetRecovererTest__factory
  let managerAddress: string

  this.beforeAll(async function () {
    signer = (await ethers.getSigners())[0]
    snapshotId = await network.provider.send('evm_snapshot')

    ContractFactory = await ethers.getContractFactory('Stonks')
    AssetRecovererFactory =
      await ethers.getContractFactory('AssetRecovererTest')
    managerAddress = await signer.getAddress()

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
        marginInBps: marginInBps,
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
        agent: mainnet.AGENT,
        manager: managerAddress,
        tokenFrom: mainnet.STETH,
        tokenTo: mainnet.DAI,
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

      const params = await stonks.getOrderParameters()

      expect(params[0]).to.be.equal(validParams.tokenFrom)
      expect(params[1]).to.be.equal(validParams.tokenTo)
      expect(params[2]).to.be.equal(validParams.orderDurationInSeconds)
      expect(params[3]).to.be.equal(validParams.marginInBasisPoints)
      expect(params[4]).to.be.equal(validParams.priceToleranceInBasisPoints)
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
      ).to.be.revertedWithCustomError(
        AssetRecovererFactory,
        'InvalidAgentAddress'
      )
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
      ).to.be.revertedWithCustomError(ContractFactory, 'InvalidManagerAddress')
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
      ).to.be.revertedWithCustomError(
        ContractFactory,
        'InvalidTokenFromAddress'
      )
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
      ).to.be.revertedWithCustomError(ContractFactory, 'InvalidTokenToAddress')
    })
    it('should not initialize with same tokens address', async function () {
      await expect(
        ContractFactory.deploy(
          validParams.agent,
          validParams.manager,
          mainnet.STETH,
          mainnet.STETH,
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
      ).to.be.revertedWithCustomError(
        ContractFactory,
        'InvalidAmountConverterAddress'
      )
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
      ).to.be.revertedWithCustomError(
        ContractFactory,
        'InvalidOrderSampleAddress'
      )
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
      ).to.be.revertedWithCustomError(ContractFactory, 'InvalidOrderDuration')
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
      ).to.be.revertedWithCustomError(ContractFactory, 'InvalidOrderDuration')
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
      ).to.be.revertedWithCustomError(
        ContractFactory,
        'MarginOverflowsAllowedLimit'
      )
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
      ).to.be.revertedWithCustomError(
        ContractFactory,
        'PriceToleranceOverflowsAllowedLimit'
      )
    })
  })

  describe('estimateTradeOutput:', function () {
    it('should revert if amount is zero', async function () {
      await expect(
        subject.estimateTradeOutput(0)
      ).to.be.revertedWithCustomError(subject, 'InvalidAmount')
    })
    it('should return correct amount with margin included', async function () {
      const amount = ethers.parseEther('1')
      const expectedOut = await getExpectedOut(
        mainnet.STETH,
        mainnet.DAI,
        amount
      )
      const expectedOutWithMargin =
        (expectedOut * (MAX_BASIS_POINTS - BigInt(marginInBps))) /
        MAX_BASIS_POINTS

      expect(await subject.estimateTradeOutput(amount)).to.equal(
        expectedOutWithMargin
      )
    })
  })

  describe('estimateOutputFromCurrentBalance:', function () {
    it('should return correct amount with margin included', async function () {
      const localSnapshotId = await network.provider.send('evm_snapshot')
      await fillUpERC20FromTreasury({
        token: mainnet.STETH,
        amount: ethers.parseEther('1'),
        address: await subject.getAddress(),
      })
      const amount = await (
        await ethers.getContractAt('IERC20', mainnet.STETH, signer)
      ).balanceOf(await subject.getAddress())
      const expectedOut = await getExpectedOut(
        mainnet.STETH,
        mainnet.DAI,
        amount
      )
      const expectedOutWithMargin =
        (expectedOut * (MAX_BASIS_POINTS - BigInt(marginInBps))) /
        MAX_BASIS_POINTS

      expect(await subject.estimateOutputFromCurrentBalance()).to.equal(
        expectedOutWithMargin
      )
      await network.provider.send('evm_revert', [localSnapshotId])
    })
    it('should revert if balance is zero', async () => {
      await expect(
        subject.estimateOutputFromCurrentBalance()
      ).to.be.revertedWithCustomError(subject, 'InvalidAmount')
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
      const steth = await ethers.getContractAt('IERC20', mainnet.STETH, signer)

      await fillUpERC20FromTreasury({
        token: mainnet.STETH,
        amount,
        address: await subject.getAddress(),
      })
      expect(isClose(await steth.balanceOf(await subject.getAddress()), amount))
        .to.be.true

      const expectedBuyAmount = await subject.estimateOutputFromCurrentBalance()
      const tx = await subject.placeOrder(expectedBuyAmount)
      await tx.wait()
    })
  })

  this.afterAll(async function () {
    await network.provider.send('evm_revert', [snapshotId])
  })
})
