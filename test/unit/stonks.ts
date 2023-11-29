import { ethers, network } from 'hardhat'
import { Signer } from 'ethers'
import { expect } from 'chai'
import { isClose } from '../../utils/assert'
import { deployStonks } from '../../scripts/deployments/stonks'
import { AmountConverter, Stonks } from '../../typechain-types'
import { mainnet } from '../../utils/contracts'
import { fillUpERC20FromTreasury } from '../../utils/fill-up-balance'

describe('Stonks', function () {
  let signer: Signer
  let subject: Stonks
  let subjectTokenConverter: AmountConverter
  let snapshotId: string

  const amount = ethers.parseEther('1')

  this.beforeAll(async function () {
    signer = (await ethers.getSigners())[0]
    snapshotId = await network.provider.send('evm_snapshot')

    const { stonks, amountConverter: tokenConverter } = await deployStonks({
      factoryParams: {
        agent: mainnet.TREASURY,
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
        conversionTarget: "0x0000000000000000000000000000000000000348", // USD
        allowedTokensToSell: [mainnet.STETH],
        allowedStableTokensToBuy: [mainnet.DAI],
      },
    })

    subject = stonks
    subjectTokenConverter = tokenConverter
  })

  const notZeroAddress = '0x0000000000000000000000000000000000000999'

  describe('initialization:', function () {
    it('should set correct constructor params', async () => {})

    it('should not initialize with zero address', async function () {
      const ContractFactory = await ethers.getContractFactory('Stonks')
      const AssetRecovererFactory = await ethers.getContractFactory('AssetRecovererTest')
      const managerAddress = await signer.getAddress()

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
      ).to.be.revertedWithCustomError(AssetRecovererFactory, 'InvalidAgentAddress')
      await expect(
        ContractFactory.deploy(
          mainnet.TREASURY,
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
      await expect(
        ContractFactory.deploy(
          mainnet.TREASURY,
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
      await expect(
        ContractFactory.deploy(
          mainnet.TREASURY,
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
      await expect(
        ContractFactory.deploy(
          mainnet.TREASURY,
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
      await expect(
        ContractFactory.deploy(
          mainnet.TREASURY,
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
      await expect(
        ContractFactory.deploy(
          mainnet.TREASURY,
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
      await expect(
        ContractFactory.deploy(
          mainnet.TREASURY,
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
      await expect(
        ContractFactory.deploy(
          mainnet.TREASURY,
          managerAddress,
          mainnet.STETH,
          mainnet.DAI,
          subjectTokenConverter,
          notZeroAddress,
          (60 * 60 * 7) + 1,
          1000,
          1000
        )
      ).to.be.revertedWithCustomError(ContractFactory, 'InvalidOrderDuration')
      await expect(
        ContractFactory.deploy(
          mainnet.TREASURY,
          managerAddress,
          mainnet.STETH,
          mainnet.DAI,
          subjectTokenConverter,
          notZeroAddress,
          61,
          1001,
          1000
    )
      ).to.be.revertedWithCustomError(ContractFactory, 'MarginOverflowsAllowedLimit')
      await expect(
        ContractFactory.deploy(
          mainnet.TREASURY,
          managerAddress,
          mainnet.STETH,
          mainnet.DAI,
          subjectTokenConverter,
          notZeroAddress,
          61,
          1000,
          1001
        )
      ).to.be.revertedWithCustomError(ContractFactory, 'PriceToleranceOverflowsAllowedLimit')
      await expect(
        ContractFactory.deploy(
          mainnet.TREASURY,
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
  })

  describe('order placement:', function () {
    it('should not place order when balance is zero', async function () {
      expect(subject.placeOrder()).to.be.rejectedWith(
        'Stonks: insufficient balance'
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
      const receipt = await tx.wait()
    })
  })

  this.afterEach(async function () {
    await network.provider.send('evm_revert', [snapshotId])
  })
})
