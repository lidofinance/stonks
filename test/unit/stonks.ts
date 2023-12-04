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
      },
    })

    subject = stonks
    subjectTokenConverter = tokenConverter
  })

  const notZeroAddress = '0x0000000000000000000000000000000000000999'

  describe('initialization:', function () {
    it('should set correct constructor params', async () => {
      await expect(
        ContractFactory.deploy(
          mainnet.AGENT,
          managerAddress,
          mainnet.STETH,
          mainnet.DAI,
          subjectTokenConverter,
          notZeroAddress,
          61,
          1000,
          1000
        )
      ).to.be.not.reverted
    })

    it('should not initialize with agent zero address', async function () {
      await expect(
        ContractFactory.deploy(
          ethers.ZeroAddress,
          managerAddress,
          mainnet.STETH,
          mainnet.DAI,
          subjectTokenConverter,
          notZeroAddress,
          61,
          1000,
          1000
        )
      ).to.be.revertedWithCustomError(
        AssetRecovererFactory,
        'InvalidAgentAddress'
      )
    })
    it('should not initialize with manager zero address', async function () {
      await expect(
        ContractFactory.deploy(
          mainnet.AGENT,
          ethers.ZeroAddress,
          mainnet.STETH,
          mainnet.DAI,
          subjectTokenConverter,
          notZeroAddress,
          61,
          1000,
          1000
        )
      ).to.be.revertedWithCustomError(ContractFactory, 'ZeroAddress')
    })
    it('should not initialize with tokenFrom zero address', async function () {
      await expect(
        ContractFactory.deploy(
          mainnet.AGENT,
          managerAddress,
          ethers.ZeroAddress,
          mainnet.DAI,
          subjectTokenConverter,
          notZeroAddress,
          61,
          1000,
          1000
        )
      ).to.be.revertedWithCustomError(ContractFactory, 'ZeroAddress')
    })
    it('should not initialize with tokenTo zero address', async function () {
      await expect(
        ContractFactory.deploy(
          mainnet.AGENT,
          managerAddress,
          mainnet.STETH,
          ethers.ZeroAddress,
          subjectTokenConverter,
          notZeroAddress,
          61,
          1000,
          1000
        )
      ).to.be.revertedWithCustomError(ContractFactory, 'ZeroAddress')
    })
    it('should not initialize with same tokens address', async function () {
      await expect(
        ContractFactory.deploy(
          mainnet.AGENT,
          managerAddress,
          mainnet.STETH,
          mainnet.STETH,
          subjectTokenConverter,
          notZeroAddress,
          61,
          1000,
          1000
        )
      ).to.be.revertedWithCustomError(ContractFactory, 'TokensCannotBeSame')
    })
    it('should not initialize with amountConverter zero address', async function () {
      await expect(
        ContractFactory.deploy(
          mainnet.AGENT,
          managerAddress,
          mainnet.STETH,
          mainnet.DAI,
          ethers.ZeroAddress,
          notZeroAddress,
          61,
          1000,
          1000
        )
      ).to.be.revertedWithCustomError(ContractFactory, 'ZeroAddress')
    })
    it('should not initialize with orderSample zero address', async function () {
      await expect(
        ContractFactory.deploy(
          mainnet.AGENT,
          managerAddress,
          mainnet.STETH,
          mainnet.DAI,
          subjectTokenConverter,
          ethers.ZeroAddress,
          61,
          1000,
          1000
        )
      ).to.be.revertedWithCustomError(ContractFactory, 'ZeroAddress')
    })
    it('should not initialize with orderDurationInSeconds less or equal 60', async function () {
      await expect(
        ContractFactory.deploy(
          mainnet.AGENT,
          managerAddress,
          mainnet.STETH,
          mainnet.DAI,
          subjectTokenConverter,
          notZeroAddress,
          60,
          1000,
          1000
        )
      ).to.be.revertedWithCustomError(ContractFactory, 'InvalidOrderDuration')
    })
    it('should not initialize with orderDurationInSeconds more 60 * 60 * 7', async function () {
      await expect(
        ContractFactory.deploy(
          mainnet.AGENT,
          managerAddress,
          mainnet.STETH,
          mainnet.DAI,
          subjectTokenConverter,
          notZeroAddress,
          60 * 60 * 7 + 1,
          1000,
          1000
        )
      ).to.be.revertedWithCustomError(ContractFactory, 'InvalidOrderDuration')
    })
    it('should not initialize with marginInBasisPoints_ less or equal 1000', async function () {
      await expect(
        ContractFactory.deploy(
          mainnet.AGENT,
          managerAddress,
          mainnet.STETH,
          mainnet.DAI,
          subjectTokenConverter,
          notZeroAddress,
          61,
          1001,
          1000
        )
      ).to.be.revertedWithCustomError(
        ContractFactory,
        'MarginOverflowsAllowedLimit'
      )
    })
    it('should not initialize with priceToleranceInBasisPoints_ less or equal 1000', async function () {
      await expect(
        ContractFactory.deploy(
          mainnet.AGENT,
          managerAddress,
          mainnet.STETH,
          mainnet.DAI,
          subjectTokenConverter,
          notZeroAddress,
          61,
          1000,
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
      await expect(subject.placeOrder()).to.be.revertedWithCustomError(
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

      const tx = await subject.placeOrder()
      await tx.wait()
    })
  })

  this.afterAll(async function () {
    await network.provider.send('evm_revert', [snapshotId])
  })
})
