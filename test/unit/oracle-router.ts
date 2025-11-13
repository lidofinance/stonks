import { ethers } from 'hardhat'
import { expect } from 'chai'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs'
import { OracleRouter, OracleRouter__factory } from '../../typechain-types'
import {
  getTestFeedRegistryStub,
  getAllTestTokens,
  updateTokenFeed,
  resetTestFeedRegistryStub,
  refreshFeedData,
} from '../../utils/test-feed-registry'
import { getContracts } from '../../utils/contracts'
import { QUOTE_USD, QUOTE_ETH } from '../../utils/oracle-router'

const contracts = getContracts()

describe('OracleRouter', function () {
  let oracleRouter: OracleRouter
  let oracleRouterFactory: OracleRouter__factory
  let snapshot: SnapshotRestorer
  let agentAddress: string
  let feedRegistryAddress: string

  const feedConfig = {
    tokens: getAllTestTokens(),
    useRealPrices: true,
  }

  const getCurrentTimestamp = async () => {
    const block = await ethers.provider.getBlock('latest')
    return BigInt(block!.timestamp)
  }

  const getAgentSigner = async () => {
    const agentSigner = await ethers.getImpersonatedSigner(agentAddress)
    await ethers.provider.send('hardhat_setBalance', [agentAddress, '0x1000000000000000000'])
    return agentSigner
  }

  before(async function () {
    snapshot = await takeSnapshot()
    oracleRouterFactory = await ethers.getContractFactory('OracleRouter')
    agentAddress = contracts.AGENT
    const stub = await getTestFeedRegistryStub(feedConfig)
    feedRegistryAddress = await stub.getAddress()
  })

  beforeEach(async function () {
    await refreshFeedData(feedConfig)
    oracleRouter = await oracleRouterFactory.deploy(agentAddress, 8, feedRegistryAddress)
    await oracleRouter.waitForDeployment()
  })

  describe('Constructor', function () {
    it('sets constructor parameters', async function () {
      expect(await oracleRouter.PRICE_DECIMALS()).to.equal(8)
      expect(await oracleRouter.PRICE_UNIT()).to.equal(ethers.parseUnits('1', 8))
      expect(await oracleRouter.FEED_REGISTRY()).to.equal(feedRegistryAddress)
    })

    it('reverts with zero agent address', async function () {
      await expect(
        oracleRouterFactory.deploy(ethers.ZeroAddress, 8, feedRegistryAddress)
      ).to.be.revertedWithCustomError(oracleRouter, 'InvalidAgentAddress')
    })

    it('reverts with zero unit decimals', async function () {
      await expect(
        oracleRouterFactory.deploy(agentAddress, QUOTE_USD, feedRegistryAddress)
      ).to.be.revertedWithCustomError(oracleRouter, 'InvalidUnitDecimals')
    })

    it('reverts with unit decimals > 38', async function () {
      await expect(
        oracleRouterFactory.deploy(agentAddress, 39, feedRegistryAddress)
      ).to.be.revertedWithCustomError(oracleRouter, 'InvalidUnitDecimals')
    })

    it('reverts with zero feed registry address', async function () {
      await expect(
        oracleRouterFactory.deploy(agentAddress, 8, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(oracleRouter, 'InvalidFeedRegistryAddress')
    })
  })

  describe('ETH/USD Bridge Configuration', function () {
    let originalEthUsdFeed: any

    before(async function () {
      const feedRegistry = await ethers.getContractAt(
        'ChainlinkFeedRegistryStub',
        feedRegistryAddress
      )
      originalEthUsdFeed = await feedRegistry.feeds(
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE
      )
    })

    after(async function () {
      const feedRegistry = await ethers.getContractAt(
        'ChainlinkFeedRegistryStub',
        feedRegistryAddress
      )
      await feedRegistry.setFeed(contracts.CHAINLINK_ETH_QUOTE, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: originalEthUsdFeed.aggregator,
        answer: originalEthUsdFeed.answer,
        updatedAt: originalEthUsdFeed.updatedAt,
        startedAt: originalEthUsdFeed.startedAt,
        answeredInRound: originalEthUsdFeed.answeredInRound,
        roundId: originalEthUsdFeed.roundId,
        decimals: originalEthUsdFeed.decimals,
      })
    })

    beforeEach(async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setEthUsdBridge(86_400)
    })

    it('configures bridge', async function () {
      const bridgeConfig = await oracleRouter.ethUsdBridge()
      expect(bridgeConfig.aggregator).to.not.equal(ethers.ZeroAddress)
      expect(bridgeConfig.maxStalenessSeconds).to.equal(86_400)
      expect(bridgeConfig.aggregatorDecimals).to.be.greaterThan(0)
      expect(bridgeConfig.scaleNumerator).to.be.greaterThan(0)
      expect(bridgeConfig.scaleDenominator).to.be.greaterThan(0)
    })

    it('emits EthUsdBridgeConfigured', async function () {
      const freshRouter = await oracleRouterFactory.deploy(agentAddress, 8, feedRegistryAddress)
      await freshRouter.waitForDeployment()
      const agentSigner = await getAgentSigner()

      await expect(freshRouter.connect(agentSigner).setEthUsdBridge(86_400))
        .to.emit(freshRouter, 'EthUsdBridgeConfigured')
        .withArgs(anyValue, anyValue, 86_400, anyValue, anyValue)
    })

    it('reverts with zero staleness', async function () {
      const agentSigner = await getAgentSigner()
      await expect(
        oracleRouter.connect(agentSigner).setEthUsdBridge(0)
      ).to.be.revertedWithCustomError(oracleRouter, 'InvalidStaleness')
    })

    it('reverts when ETH/USD feed is missing', async function () {
      const agentSigner = await getAgentSigner()
      const feedRegistry = await ethers.getContractAt(
        'ChainlinkFeedRegistryStub',
        feedRegistryAddress
      )

      await feedRegistry.setFeed(contracts.CHAINLINK_ETH_QUOTE, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: ethers.ZeroAddress,
        answer: 0n,
        updatedAt: 0n,
        startedAt: 0n,
        answeredInRound: 0n,
        roundId: 0n,
        decimals: 8,
      })

      await expect(
        oracleRouter.connect(agentSigner).setEthUsdBridge(86_400)
      ).to.be.revertedWithCustomError(oracleRouter, 'FeedMissing')

      // restore
      await feedRegistry.setFeed(contracts.CHAINLINK_ETH_QUOTE, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: originalEthUsdFeed.aggregator,
        answer: originalEthUsdFeed.answer,
        updatedAt: originalEthUsdFeed.updatedAt,
        startedAt: originalEthUsdFeed.startedAt,
        answeredInRound: originalEthUsdFeed.answeredInRound,
        roundId: originalEthUsdFeed.roundId,
        decimals: originalEthUsdFeed.decimals,
      })
    })

    it('reverts sync when called by non-agent', async function () {
      const [, nonAgentSigner] = await ethers.getSigners()
      await expect(
        oracleRouter.connect(nonAgentSigner).syncEthUsdBridge()
      ).to.be.revertedWithCustomError(oracleRouter, 'NotAgentOrManager')
    })

    it('syncs bridge', async function () {
      const agentSigner = await getAgentSigner()
      await expect(oracleRouter.connect(agentSigner).syncEthUsdBridge())
        .to.emit(oracleRouter, 'EthUsdBridgeConfigured')
        .withArgs(anyValue, anyValue, 86_400, anyValue, anyValue)

      const bridgeConfig = await oracleRouter.ethUsdBridge()
      expect(bridgeConfig.aggregator).to.not.equal(ethers.ZeroAddress)
      expect(bridgeConfig.maxStalenessSeconds).to.equal(86_400)
    })
  })

  describe('Decimal Scaling Tests', function () {
    let oracleRouter18: OracleRouter

    beforeEach(async function () {
      await refreshFeedData(feedConfig)
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setEthUsdBridge(86_400)

      // Deploy OracleRouter with 18 decimals for comparison
      oracleRouter18 = await oracleRouterFactory.deploy(agentAddress, 18, feedRegistryAddress)
      await oracleRouter18.waitForDeployment()
      await oracleRouter18.connect(agentSigner).setEthUsdBridge(86_400)
    })

    it('should correctly scale feeds with 8-decimal unit', async function () {
      const agentSigner = await getAgentSigner()

      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QUOTE_USD, 86_400, 18, true)

      const [basePrice, quotePrice] = await oracleRouter.getUsdPrices(contracts.DAI, contracts.DAI)
      expect(basePrice).to.be.greaterThan(0)
      expect(quotePrice).to.be.greaterThan(0)
    })

    it('should correctly scale feeds with 18-decimal unit', async function () {
      const agentSigner = await getAgentSigner()

      await oracleRouter18
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QUOTE_USD, 86_400, 18, true)

      const [basePrice, quotePrice] = await oracleRouter18.getUsdPrices(
        contracts.DAI,
        contracts.DAI
      )
      expect(basePrice).to.be.greaterThan(0)
      expect(quotePrice).to.be.greaterThan(0)
    })

    it('should have correct unit values for different decimal configurations', async function () {
      expect(await oracleRouter.PRICE_DECIMALS()).to.equal(8)
      expect(await oracleRouter.PRICE_UNIT()).to.equal(ethers.parseUnits('1', 8))

      expect(await oracleRouter18.PRICE_DECIMALS()).to.equal(18)
      expect(await oracleRouter18.PRICE_UNIT()).to.equal(ethers.parseEther('1'))
    })

    it('should scale differently for same tokens with different unit decimals', async function () {
      const agentSigner = await getAgentSigner()

      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QUOTE_USD, 86_400, 18, true)

      await oracleRouter18
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QUOTE_USD, 86_400, 18, true)

      const [price8] = await oracleRouter.getUsdPrices(contracts.DAI, contracts.DAI)
      const [price18] = await oracleRouter18.getUsdPrices(contracts.DAI, contracts.DAI)

      // 18-decimal router should have 10^10 times larger values than 8-decimal router
      expect(price18).to.be.greaterThan(price8)
      expect(price18).to.be.closeTo(price8 * BigInt(10 ** 10), price8 * BigInt(10 ** 9))
    })
  })

  describe('Token Configuration', function () {
    beforeEach(async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setEthUsdBridge(86_400)
    })

    describe('setTokenFeed', function () {
      it('configures token with USD feed', async function () {
        const agentSigner = await getAgentSigner()
        await oracleRouter
          .connect(agentSigner)
          .setTokenFeed(contracts.DAI, QUOTE_USD, 86_400, 18, true)

        const tokenConfig = await oracleRouter.tokenConfig(contracts.DAI)
        expect(tokenConfig.primaryQuote).to.equal(0) // USD = 0
        expect(tokenConfig.primaryFeed.aggregator).to.not.equal(ethers.ZeroAddress)
        expect(tokenConfig.primaryFeed.maxStalenessSeconds).to.equal(86_400)
        expect(tokenConfig.tokenDecimals).to.equal(18)
        expect(tokenConfig.isActive).to.be.true
      })

      it('emits TokenConfigured', async function () {
        const agentSigner = await getAgentSigner()
        await expect(
          oracleRouter.connect(agentSigner).setTokenFeed(contracts.DAI, QUOTE_USD, 86_400, 18, true)
        )
          .to.emit(oracleRouter, 'TokenConfigured')
          .withArgs(
            contracts.DAI,
            QUOTE_USD,
            anyValue,
            anyValue,
            86_400,
            18,
            anyValue,
            anyValue,
            true
          )
      })

      it('reverts with zero token address', async function () {
        const agentSigner = await getAgentSigner()
        await expect(
          oracleRouter
            .connect(agentSigner)
            .setTokenFeed(ethers.ZeroAddress, QUOTE_USD, 86_400, 18, true)
        ).to.be.revertedWithCustomError(oracleRouter, 'InvalidTokenAddress')
      })

      it('reverts with zero staleness', async function () {
        const agentSigner = await getAgentSigner()
        await expect(
          oracleRouter.connect(agentSigner).setTokenFeed(contracts.DAI, QUOTE_USD, 0, 18, true)
        ).to.be.revertedWithCustomError(oracleRouter, 'InvalidStaleness')
      })

      it('reverts when USD feed is missing', async function () {
        const agentSigner = await getAgentSigner()
        const feedRegistry = await ethers.getContractAt(
          'ChainlinkFeedRegistryStub',
          feedRegistryAddress
        )

        const originalFeed = await feedRegistry.feeds(contracts.USDC, contracts.CHAINLINK_USD_QUOTE)
        await feedRegistry.setFeed(contracts.USDC, contracts.CHAINLINK_USD_QUOTE, {
          aggregator: ethers.ZeroAddress,
          answer: 0n,
          updatedAt: 0n,
          startedAt: 0n,
          answeredInRound: 0n,
          roundId: 0n,
          decimals: 8,
        })

        await expect(
          oracleRouter.connect(agentSigner).setTokenFeed(contracts.USDC, QUOTE_USD, 86_400, 6, true)
        ).to.be.revertedWithCustomError(oracleRouter, 'FeedMissing')

        // restore
        await feedRegistry.setFeed(contracts.USDC, contracts.CHAINLINK_USD_QUOTE, {
          aggregator: originalFeed.aggregator,
          answer: originalFeed.answer,
          updatedAt: originalFeed.updatedAt,
          startedAt: originalFeed.startedAt,
          answeredInRound: originalFeed.answeredInRound,
          roundId: originalFeed.roundId,
          decimals: originalFeed.decimals,
        })
      })

      it('reverts when provided decimals do not match ERC20.decimals()', async function () {
        const agentSigner = await getAgentSigner()
        await expect(
          oracleRouter.connect(agentSigner).setTokenFeed(contracts.DAI, QUOTE_USD, 86_400, 6, true) // DAI 18 vs provided 6
        ).to.be.revertedWithCustomError(oracleRouter, 'TokenDecimalsMismatch')
      })
    })

    describe('setTokenFeed with ETH quote', function () {
      it('configures token with ETH feed', async function () {
        const agentSigner = await getAgentSigner()
        await oracleRouter
          .connect(agentSigner)
          .setTokenFeed(contracts.STETH, QUOTE_ETH, 86_400, 18, true)

        const tokenConfig = await oracleRouter.tokenConfig(contracts.STETH)
        expect(tokenConfig.primaryQuote).to.equal(1)
        expect(tokenConfig.primaryFeed.aggregator).to.not.equal(ethers.ZeroAddress)
        expect(tokenConfig.primaryFeed.maxStalenessSeconds).to.equal(86_400)
        expect(tokenConfig.tokenDecimals).to.equal(18)
        expect(tokenConfig.isActive).to.be.true
      })

      it('emits TokenConfigured for ETH feed', async function () {
        const agentSigner = await getAgentSigner()
        await expect(
          oracleRouter
            .connect(agentSigner)
            .setTokenFeed(contracts.STETH, QUOTE_ETH, 86_400, 18, true)
        )
          .to.emit(oracleRouter, 'TokenConfigured')
          .withArgs(
            contracts.STETH,
            QUOTE_ETH,
            anyValue,
            anyValue,
            86_400,
            18,
            anyValue,
            anyValue,
            true
          )
      })
    })

    describe('setTokenActive', function () {
      beforeEach(async function () {
        const agentSigner = await getAgentSigner()
        await oracleRouter
          .connect(agentSigner)
          .setTokenFeed(contracts.DAI, QUOTE_USD, 86_400, 18, true)
      })

      it('toggles token active status', async function () {
        const agentSigner = await getAgentSigner()
        await oracleRouter.connect(agentSigner).setTokenActive(contracts.DAI, false)
        let tokenConfig = await oracleRouter.tokenConfig(contracts.DAI)
        expect(tokenConfig.isActive).to.be.false

        await oracleRouter.connect(agentSigner).setTokenActive(contracts.DAI, true)
        tokenConfig = await oracleRouter.tokenConfig(contracts.DAI)
        expect(tokenConfig.isActive).to.be.true
      })

      it('emits TokenActiveUpdated', async function () {
        const agentSigner = await getAgentSigner()
        await expect(oracleRouter.connect(agentSigner).setTokenActive(contracts.DAI, false))
          .to.emit(oracleRouter, 'TokenActiveUpdated')
          .withArgs(contracts.DAI, false)
      })

      it('reverts with zero token address', async function () {
        const agentSigner = await getAgentSigner()
        await expect(
          oracleRouter.connect(agentSigner).setTokenActive(ethers.ZeroAddress, true)
        ).to.be.revertedWithCustomError(oracleRouter, 'InvalidTokenAddress')
      })

      it('reverts when activating unconfigured token', async function () {
        const agentSigner = await getAgentSigner()
        await expect(
          oracleRouter.connect(agentSigner).setTokenActive(contracts.USDC, true)
        ).to.be.revertedWithCustomError(oracleRouter, 'TokenNotConfigured')
      })

      it('reverts with TokenStateUnchanged when setting active token to active', async function () {
        const agentSigner = await getAgentSigner()

        await expect(oracleRouter.connect(agentSigner).setTokenActive(contracts.DAI, true))
          .to.be.revertedWithCustomError(oracleRouter, 'TokenStateUnchanged')
          .withArgs(contracts.DAI, true)
      })

      it('reverts with TokenStateUnchanged when setting inactive token to inactive', async function () {
        const agentSigner = await getAgentSigner()
        await oracleRouter.connect(agentSigner).setTokenActive(contracts.DAI, false)

        await expect(oracleRouter.connect(agentSigner).setTokenActive(contracts.DAI, false))
          .to.be.revertedWithCustomError(oracleRouter, 'TokenStateUnchanged')
          .withArgs(contracts.DAI, false)
      })
    })

    describe('setTokenEthUsdStalenessOverride', function () {
      beforeEach(async function () {
        const agentSigner = await getAgentSigner()
        await oracleRouter
          .connect(agentSigner)
          .setTokenFeed(contracts.DAI, QUOTE_USD, 86_400, 18, true)
      })

      it('sets ETH/USD staleness override', async function () {
        const agentSigner = await getAgentSigner()
        await expect(
          oracleRouter.connect(agentSigner).setTokenEthUsdStalenessOverride(contracts.DAI, 43_200)
        )
          .to.emit(oracleRouter, 'TokenEthUsdStalenessOverridden')
          .withArgs(contracts.DAI, 43_200)

        const tokenConfig = await oracleRouter.tokenConfig(contracts.DAI)
        expect(tokenConfig.ethUsdMaxStalenessOverrideSeconds).to.equal(43_200)
      })

      it('reverts with zero token address', async function () {
        const agentSigner = await getAgentSigner()
        await expect(
          oracleRouter
            .connect(agentSigner)
            .setTokenEthUsdStalenessOverride(ethers.ZeroAddress, 43_200)
        ).to.be.revertedWithCustomError(oracleRouter, 'InvalidTokenAddress')
      })

      it('reverts when called by non-agent', async function () {
        const [, nonAgentSigner] = await ethers.getSigners()
        await expect(
          oracleRouter
            .connect(nonAgentSigner)
            .setTokenEthUsdStalenessOverride(contracts.DAI, 43_200)
        ).to.be.revertedWithCustomError(oracleRouter, 'NotAgentOrManager')
      })
    })
  })

  describe('Sync Functions', function () {
    beforeEach(async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setEthUsdBridge(86_400)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QUOTE_USD, 86_400, 18, true)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.STETH, QUOTE_ETH, 86_400, 18, true)
    })

    it('isBridgeInSync returns true when in sync', async function () {
      expect(await oracleRouter.isBridgeInSync()).to.be.true
    })

    it('isFeedInSync returns true for configured tokens, false otherwise', async function () {
      expect(await oracleRouter.isFeedInSync(contracts.DAI)).to.be.true
      expect(await oracleRouter.isFeedInSync(contracts.STETH)).to.be.true
      expect(await oracleRouter.isFeedInSync(contracts.USDC)).to.be.false
    })

    it('syncTokenFeed emits TokenConfigured', async function () {
      const agentSigner = await getAgentSigner()
      await expect(oracleRouter.connect(agentSigner).syncTokenFeed(contracts.DAI))
        .to.emit(oracleRouter, 'TokenConfigured')
        .withArgs(
          contracts.DAI,
          QUOTE_USD,
          anyValue,
          anyValue,
          86_400,
          18,
          anyValue,
          anyValue,
          true
        )
    })

    it('syncTokenFeed reverts for unconfigured token and non-agent', async function () {
      const agentSigner = await getAgentSigner()
      await expect(
        oracleRouter.connect(agentSigner).syncTokenFeed(contracts.USDC)
      ).to.be.revertedWithCustomError(oracleRouter, 'TokenNotConfigured')

      const [, nonAgentSigner] = await ethers.getSigners()
      await expect(
        oracleRouter.connect(nonAgentSigner).syncTokenFeed(contracts.DAI)
      ).to.be.revertedWithCustomError(oracleRouter, 'NotAgentOrManager')
    })
  })

  describe('Price Queries', function () {
    beforeEach(async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setEthUsdBridge(86_400)

      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QUOTE_USD, 86_400, 18, true)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.USDC, QUOTE_USD, 86_400, 6, true)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.STETH, QUOTE_ETH, 86_400, 18, true)

      // keep feeds fresh for price reads
      const currentTimestamp = await getCurrentTimestamp()
      await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        updatedAt: currentTimestamp,
      })
      await updateTokenFeed(feedConfig, contracts.USDC, contracts.CHAINLINK_USD_QUOTE, {
        updatedAt: currentTimestamp,
      })
      await updateTokenFeed(
        feedConfig,
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE,
        {
          updatedAt: currentTimestamp,
        }
      )
      await updateTokenFeed(feedConfig, contracts.STETH, contracts.CHAINLINK_ETH_QUOTE, {
        updatedAt: currentTimestamp,
      })
    })

    describe('getUsdPrices', function () {
      it('returns USD prices for both tokens', async function () {
        const [daiUsdPrice, usdcUsdPrice] = await oracleRouter.getUsdPrices(
          contracts.DAI,
          contracts.USDC
        )
        expect(daiUsdPrice).to.be.greaterThan(0)
        expect(usdcUsdPrice).to.be.greaterThan(0)
        expect(usdcUsdPrice).to.be.closeTo(ethers.parseUnits('1', 8), ethers.parseUnits('0.1', 8))
      })

      it('handles ETH bridge path', async function () {
        const [stethUsdPrice, daiUsdPrice] = await oracleRouter.getUsdPrices(
          contracts.STETH,
          contracts.DAI
        )
        expect(stethUsdPrice).to.be.greaterThan(0)
        expect(daiUsdPrice).to.be.greaterThan(0)
      })
    })

    describe('getPricesAndDecimals with USD quote', function () {
      describe('Happy paths', function () {
        it('returns correct prices and decimals', async function () {
          const [daiPrice, usdcPrice, daiDecimals, usdcDecimals] =
            await oracleRouter.getPricesAndDecimals(contracts.DAI, contracts.USDC, QUOTE_USD)
          expect(daiDecimals).to.equal(18)
          expect(usdcDecimals).to.equal(6)
          expect(daiPrice).to.be.gt(0)
          expect(usdcPrice).to.be.gt(0)
        })

        it('should handle same token for base and quote', async function () {
          const result = await oracleRouter.getPricesAndDecimals(
            contracts.DAI,
            contracts.DAI,
            QUOTE_USD
          )
          expect(result[0]).to.equal(result[1]) // basePrice == quotePrice
          expect(result[2]).to.equal(result[3]) // baseTokenDecimals == quoteTokenDecimals
          expect(result[2]).to.equal(18) // baseTokenDecimals
        })

        it('should handle tokens with different decimals', async function () {
          const result = await oracleRouter.getPricesAndDecimals(
            contracts.DAI,
            contracts.USDC,
            QUOTE_USD
          )
          expect(result[2]).to.equal(18) // baseTokenDecimals
          expect(result[3]).to.equal(6) // quoteTokenDecimals
          expect(result[0]).to.be.gt(0) // basePrice
          expect(result[1]).to.be.gt(0) // quotePrice
        })
      })

      describe('Validation - Token not configured', function () {
        it('should revert if base token not configured', async function () {
          const randomAddress = ethers.Wallet.createRandom().address

          await expect(oracleRouter.getPricesAndDecimals(randomAddress, contracts.DAI, QUOTE_USD))
            .to.be.revertedWithCustomError(oracleRouter, 'TokenNotConfigured')
            .withArgs(randomAddress)
        })

        it('should revert if quote token not configured', async function () {
          const randomAddress = ethers.Wallet.createRandom().address

          await expect(oracleRouter.getPricesAndDecimals(contracts.DAI, randomAddress, QUOTE_USD))
            .to.be.revertedWithCustomError(oracleRouter, 'TokenNotConfigured')
            .withArgs(randomAddress)
        })

        it('should revert if base token inactive', async function () {
          const agent = await getAgentSigner()

          await oracleRouter.connect(agent).setTokenActive(contracts.DAI, false)

          await expect(oracleRouter.getPricesAndDecimals(contracts.DAI, contracts.USDC, QUOTE_USD))
            .to.be.revertedWithCustomError(oracleRouter, 'TokenNotConfigured')
            .withArgs(contracts.DAI)
        })

        it('should revert if quote token inactive', async function () {
          const agent = await getAgentSigner()

          await oracleRouter.connect(agent).setTokenActive(contracts.USDC, false)

          await expect(oracleRouter.getPricesAndDecimals(contracts.DAI, contracts.USDC, QUOTE_USD))
            .to.be.revertedWithCustomError(oracleRouter, 'TokenNotConfigured')
            .withArgs(contracts.USDC)
        })
      })

      describe('Validation - Token not USD-quoted', function () {
        it('should revert if base token is ETH-quoted (stETH)', async function () {
          const agent = await getAgentSigner()

          await oracleRouter
            .connect(agent)
            .setTokenFeed(contracts.STETH, QUOTE_ETH, 86400, 18, true)

          await expect(oracleRouter.getPricesAndDecimals(contracts.STETH, contracts.DAI, QUOTE_USD))
            .to.be.revertedWithCustomError(oracleRouter, 'TokenNotUsdQuoted')
            .withArgs(contracts.STETH)
        })

        it('should revert if quote token is ETH-quoted (LDO)', async function () {
          const agent = await getAgentSigner()

          await oracleRouter.connect(agent).setTokenFeed(contracts.LDO, QUOTE_ETH, 86400, 18, true)

          await expect(oracleRouter.getPricesAndDecimals(contracts.DAI, contracts.LDO, QUOTE_USD))
            .to.be.revertedWithCustomError(oracleRouter, 'TokenNotUsdQuoted')
            .withArgs(contracts.LDO)
        })

        it('should revert if both tokens are ETH-quoted', async function () {
          const agent = await getAgentSigner()

          await oracleRouter
            .connect(agent)
            .setTokenFeed(contracts.STETH, QUOTE_ETH, 86400, 18, true)
          await oracleRouter.connect(agent).setTokenFeed(contracts.LDO, QUOTE_ETH, 86400, 18, true)

          await expect(oracleRouter.getPricesAndDecimals(contracts.STETH, contracts.LDO, QUOTE_USD))
            .to.be.revertedWithCustomError(oracleRouter, 'TokenNotUsdQuoted')
            .withArgs(contracts.STETH)
        })
      })

      describe('Staleness checks', function () {
        it('should revert if base token feed is stale', async function () {
          const maxStaleness = 86400 + 3600
          await ethers.provider.send('evm_increaseTime', [maxStaleness])
          await ethers.provider.send('evm_mine', [])

          await expect(
            oracleRouter.getPricesAndDecimals(contracts.DAI, contracts.USDC, QUOTE_USD)
          ).to.be.revertedWithCustomError(oracleRouter, 'OracleStale')
        })

        it('should revert if quote token feed is stale', async function () {
          const maxStaleness = 86400 + 3600
          await ethers.provider.send('evm_increaseTime', [maxStaleness])
          await ethers.provider.send('evm_mine', [])

          await expect(
            oracleRouter.getPricesAndDecimals(contracts.DAI, contracts.USDC, QUOTE_USD)
          ).to.be.revertedWithCustomError(oracleRouter, 'OracleStale')
        })
      })

      describe('Edge cases', function () {
        it('should work with maximum valid staleness value', async function () {
          const agent = await getAgentSigner()
          const maxStaleness = 2 ** 32 - 1

          await oracleRouter
            .connect(agent)
            .setTokenFeed(contracts.DAI, QUOTE_USD, maxStaleness, 18, true)
          await oracleRouter
            .connect(agent)
            .setTokenFeed(contracts.USDC, QUOTE_USD, maxStaleness, 6, true)

          const result = await oracleRouter.getPricesAndDecimals(
            contracts.DAI,
            contracts.USDC,
            QUOTE_USD
          )
          expect(result[0]).to.be.gt(0) // basePrice
          expect(result[1]).to.be.gt(0) // quotePrice
        })
      })
    })
  })

  describe('Oracle Staleness', function () {
    beforeEach(async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setEthUsdBridge(1)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QUOTE_USD, QUOTE_ETH, 18, true)
    })

    it('reverts with OracleStale when token feed is stale', async function () {
      const staleTimestamp = (await getCurrentTimestamp()) - 2n
      await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        updatedAt: staleTimestamp,
      })
      await expect(
        oracleRouter.getUsdPrices(contracts.DAI, contracts.DAI)
      ).to.be.revertedWithCustomError(oracleRouter, 'OracleStale')
    })

    it('reverts with OracleStale when ETH/USD bridge is stale', async function () {
      const staleTimestamp = (await getCurrentTimestamp()) - 2n
      await updateTokenFeed(
        feedConfig,
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE,
        { updatedAt: staleTimestamp }
      )
      await expect(
        oracleRouter.getUsdPrices(contracts.DAI, contracts.DAI)
      ).to.be.revertedWithCustomError(oracleRouter, 'OracleStale')
    })

    it('accepts updatedAt exactly at staleness boundary', async function () {
      const agentSigner = await getAgentSigner()
      const maxStalenessSeconds = 10
      await oracleRouter.connect(agentSigner).setEthUsdBridge(maxStalenessSeconds)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QUOTE_USD, maxStalenessSeconds, 18, true)

      // anchor on a known block timestamp
      const latestBlock = await ethers.provider.getBlock('latest')
      const baseTimestamp = BigInt(latestBlock!.timestamp)

      // set both feeds' updatedAt to baseTimestamp
      await updateTokenFeed(
        feedConfig,
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE,
        { updatedAt: baseTimestamp }
      )
      await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        updatedAt: baseTimestamp,
      })

      // mine a block exactly at boundary
      await ethers.provider.send('evm_mine', [Number(baseTimestamp + BigInt(maxStalenessSeconds))])

      const [firstUsdPrice, secondUsdPrice] = await oracleRouter.getUsdPrices(
        contracts.DAI,
        contracts.DAI
      )
      expect(firstUsdPrice).to.be.greaterThan(0)
      expect(secondUsdPrice).to.be.greaterThan(0)
    })
  })

  describe('Oracle Bad Answer', function () {
    beforeEach(async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setEthUsdBridge(86_400)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QUOTE_USD, 86_400, 18, true)
    })

    it('reverts with OracleBadAnswer when answer is zero', async function () {
      await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        answer: 0n,
      })
      await expect(
        oracleRouter.getUsdPrices(contracts.DAI, contracts.DAI)
      ).to.be.revertedWithCustomError(oracleRouter, 'OracleBadAnswer')
    })

    it('reverts with OracleBadAnswer when answer is negative', async function () {
      await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        answer: -1n,
      })
      await expect(
        oracleRouter.getUsdPrices(contracts.DAI, contracts.DAI)
      ).to.be.revertedWithCustomError(oracleRouter, 'OracleBadAnswer')
    })

    it('reverts with OracleUnanswered when answeredInRound < roundId', async function () {
      const feedRegistry = await ethers.getContractAt(
        'ChainlinkFeedRegistryStub',
        feedRegistryAddress
      )
      const existingFeed = await feedRegistry.feeds(contracts.DAI, contracts.CHAINLINK_USD_QUOTE)

      await feedRegistry.setFeed(contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: existingFeed.aggregator,
        answer: existingFeed.answer,
        updatedAt: await getCurrentTimestamp(),
        startedAt: existingFeed.startedAt,
        answeredInRound: 9n,
        roundId: 10n,
        decimals: existingFeed.decimals,
      })

      await expect(
        oracleRouter.getUsdPrices(contracts.DAI, contracts.DAI)
      ).to.be.revertedWithCustomError(oracleRouter, 'OracleUnanswered')
    })
  })

  describe('Scale Factors', function () {
    beforeEach(async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setEthUsdBridge(86_400)

      const feedRegistry = await ethers.getContractAt(
        'ChainlinkFeedRegistryStub',
        feedRegistryAddress
      )

      await feedRegistry.setFeed(contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: await feedRegistry.getAddress(),
        answer: 1n * 10n ** 8n,
        updatedAt: await getCurrentTimestamp(),
        startedAt: 0n,
        answeredInRound: 0n,
        roundId: 0n,
        decimals: 8,
      })

      await feedRegistry.setFeed(contracts.USDC, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: await feedRegistry.getAddress(),
        answer: 1n * 10n ** 8n,
        updatedAt: await getCurrentTimestamp(),
        startedAt: 0n,
        answeredInRound: 0n,
        roundId: 0n,
        decimals: 8,
      })
    })

    it('handles different aggregator decimals', async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QUOTE_USD, 86_400, 18, true)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.USDC, QUOTE_USD, 86_400, 6, true)

      const daiConfig = await oracleRouter.tokenConfig(contracts.DAI)
      const usdcConfig = await oracleRouter.tokenConfig(contracts.USDC)

      expect(daiConfig.primaryFeed.scaleNumerator).to.be.greaterThan(0)
      expect(daiConfig.primaryFeed.scaleDenominator).to.be.greaterThan(0)
      expect(usdcConfig.primaryFeed.scaleNumerator).to.be.greaterThan(0)
      expect(usdcConfig.primaryFeed.scaleDenominator).to.be.greaterThan(0)
    })
  })

  describe('Edge Cases', function () {
    beforeEach(async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setEthUsdBridge(86_400)

      const feedRegistry = await ethers.getContractAt(
        'ChainlinkFeedRegistryStub',
        feedRegistryAddress
      )

      await feedRegistry.setFeed(contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: await feedRegistry.getAddress(),
        answer: 1n * 10n ** 8n,
        updatedAt: await getCurrentTimestamp(),
        startedAt: 0n,
        answeredInRound: 0n,
        roundId: 0n,
        decimals: 8,
      })
    })

    it('handles same token for base and quote', async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QUOTE_USD, 86_400, 18, true)

      const [firstUsdPrice, secondUsdPrice] = await oracleRouter.getUsdPrices(
        contracts.DAI,
        contracts.DAI
      )
      expect(firstUsdPrice).to.equal(secondUsdPrice)
    })

    it('handles maximum staleness values', async function () {
      const agentSigner = await getAgentSigner()
      const maxStalenessSeconds = 2 ** 32 - 1
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QUOTE_USD, maxStalenessSeconds, 18, true)

      const tokenConfig = await oracleRouter.tokenConfig(contracts.DAI)
      expect(tokenConfig.primaryFeed.maxStalenessSeconds).to.equal(maxStalenessSeconds)
    })
  })

  // -------- Feed drift detection and recovery

  describe('Feed drift detection', function () {
    beforeEach(async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setEthUsdBridge(86_400)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QUOTE_USD, 86_400, 18, true)
    })

    it('reverts with FeedConfigOutOfSync when registry aggregator changes', async function () {
      const feedRegistry = await ethers.getContractAt(
        'ChainlinkFeedRegistryStub',
        feedRegistryAddress
      )
      const existingFeed = await feedRegistry.feeds(contracts.DAI, contracts.CHAINLINK_USD_QUOTE)
      const fakeAggregator = ethers.Wallet.createRandom().address

      await feedRegistry.setFeed(contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: fakeAggregator,
        answer: existingFeed.answer,
        updatedAt: await getCurrentTimestamp(),
        startedAt: existingFeed.startedAt,
        answeredInRound: existingFeed.answeredInRound,
        roundId: existingFeed.roundId,
        decimals: existingFeed.decimals,
      })

      await expect(
        oracleRouter.getUsdPrices(contracts.DAI, contracts.DAI)
      ).to.be.revertedWithCustomError(oracleRouter, 'FeedConfigOutOfSync')
    })

    it('reverts with FeedConfigOutOfSync when registry decimals change', async function () {
      const feedRegistry = await ethers.getContractAt(
        'ChainlinkFeedRegistryStub',
        feedRegistryAddress
      )
      const existingFeed = await feedRegistry.feeds(contracts.DAI, contracts.CHAINLINK_USD_QUOTE)

      await feedRegistry.setFeed(contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: existingFeed.aggregator,
        answer: existingFeed.answer,
        updatedAt: await getCurrentTimestamp(),
        startedAt: existingFeed.startedAt,
        answeredInRound: existingFeed.answeredInRound,
        roundId: existingFeed.roundId,
        decimals: Number(existingFeed.decimals) === 8 ? 18 : 8,
      })

      await expect(
        oracleRouter.getUsdPrices(contracts.DAI, contracts.DAI)
      ).to.be.revertedWithCustomError(oracleRouter, 'FeedConfigOutOfSync')
    })

    it('recovers after syncTokenFeed', async function () {
      const agentSigner = await getAgentSigner()
      const feedRegistry = await ethers.getContractAt(
        'ChainlinkFeedRegistryStub',
        feedRegistryAddress
      )
      const existingFeed = await feedRegistry.feeds(contracts.DAI, contracts.CHAINLINK_USD_QUOTE)
      const fakeAggregator = ethers.Wallet.createRandom().address

      await feedRegistry.setFeed(contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: fakeAggregator,
        answer: existingFeed.answer,
        updatedAt: await getCurrentTimestamp(),
        startedAt: existingFeed.startedAt,
        answeredInRound: existingFeed.answeredInRound,
        roundId: existingFeed.roundId,
        decimals: existingFeed.decimals,
      })

      await expect(
        oracleRouter.getUsdPrices(contracts.DAI, contracts.DAI)
      ).to.be.revertedWithCustomError(oracleRouter, 'FeedConfigOutOfSync')

      await oracleRouter.connect(agentSigner).syncTokenFeed(contracts.DAI)
      const [firstUsdPrice, secondUsdPrice] = await oracleRouter.getUsdPrices(
        contracts.DAI,
        contracts.DAI
      )
      expect(firstUsdPrice).to.be.greaterThan(0)
      expect(secondUsdPrice).to.be.greaterThan(0)
    })
  })

  // -------- Quantization guard

  describe('OracleQuantizedToZero guard', function () {
    it('reverts when normalization floors to zero at chosen PRICE_UNIT', async function () {
      const smallUnitFactory = await ethers.getContractFactory('OracleRouter')
      const smallUnitRouter = await smallUnitFactory.deploy(
        agentAddress,
        2, // PRICE_DECIMALS = 2
        feedRegistryAddress
      )
      await smallUnitRouter.waitForDeployment()

      const agentSigner = await getAgentSigner()
      await smallUnitRouter.connect(agentSigner).setEthUsdBridge(86_400)

      const feedRegistry = await ethers.getContractAt(
        'ChainlinkFeedRegistryStub',
        feedRegistryAddress
      )

      await feedRegistry.setFeed(contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: await feedRegistry.getAddress(),
        answer: 1n, // tiny value with 18 decimals → 0 at PRICE_UNIT=1e2
        updatedAt: await getCurrentTimestamp(),
        startedAt: 0n,
        answeredInRound: 1n,
        roundId: 1n,
        decimals: 18,
      })

      await expect(
        smallUnitRouter
          .connect(agentSigner)
          .setTokenFeed(contracts.DAI, QUOTE_USD, 86_400, 18, true)
      ).to.emit(smallUnitRouter, 'TokenConfigured')

      await expect(
        smallUnitRouter.getUsdPrices(contracts.DAI, contracts.DAI)
      ).to.be.revertedWithCustomError(smallUnitRouter, 'OracleQuantizedToZero')
    })
  })

  // -------- Per-token ETH/USD staleness override semantics

  describe('Per-token ETH/USD staleness override', function () {
    beforeEach(async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setEthUsdBridge(86_400)
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.STETH, QUOTE_ETH, 300, 18, true) // token path max 300s
      await oracleRouter
        .connect(agentSigner)
        .setTokenFeed(contracts.DAI, QUOTE_USD, 86_400, 18, true)
    })

    it('uses min(override, global) when override is set', async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter.connect(agentSigner).setTokenEthUsdStalenessOverride(contracts.STETH, 60)

      const fiveMinutesOld = (await getCurrentTimestamp()) - 300n
      await updateTokenFeed(
        feedConfig,
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE,
        { updatedAt: fiveMinutesOld }
      )
      await updateTokenFeed(feedConfig, contracts.STETH, contracts.CHAINLINK_ETH_QUOTE, {
        updatedAt: await getCurrentTimestamp(),
      })

      await expect(
        oracleRouter.getUsdPrices(contracts.STETH, contracts.DAI)
      ).to.be.revertedWithCustomError(oracleRouter, 'OracleStale')
    })

    it('falls back to global when override is zero', async function () {
      const agentSigner = await getAgentSigner()
      await oracleRouter
        .connect(agentSigner)
        .setTokenEthUsdStalenessOverride(contracts.STETH, QUOTE_USD)

      // anchor to the latest mined block timestamp to avoid drift
      const latestBlock = await ethers.provider.getBlock('latest')
      const baseTimestamp = BigInt(latestBlock!.timestamp)

      // ETH/USD is 120s old relative to baseTimestamp, which is < global cap 86,400
      await updateTokenFeed(
        feedConfig,
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE,
        { updatedAt: baseTimestamp - 120n }
      )
      // STETH/ETH is fresh at the same baseTimestamp
      await updateTokenFeed(feedConfig, contracts.STETH, contracts.CHAINLINK_ETH_QUOTE, {
        updatedAt: baseTimestamp,
      })

      // do not advance time; call in the same block context to keep staleness exact
      const [stethUsdPrice, daiUsdPrice] = await oracleRouter.getUsdPrices(
        contracts.STETH,
        contracts.DAI
      )
      expect(stethUsdPrice).to.be.greaterThan(0)
      expect(daiUsdPrice).to.be.greaterThan(0)
    })
  })

  describe('getPricesAndDecimals with ETH quote', function () {
    beforeEach(async function () {
      const agent = await getAgentSigner()

      // Configure ETH-quoted tokens for testing
      await oracleRouter.connect(agent).setTokenFeed(contracts.STETH, QUOTE_ETH, 86400, 18, true)
      await oracleRouter.connect(agent).setTokenFeed(contracts.LDO, QUOTE_ETH, 86400, 18, true)
    })

    describe('Happy paths', function () {
      it('should return ETH prices for two ETH-quoted tokens (stETH/LDO)', async function () {
        const result = await oracleRouter.getPricesAndDecimals(
          contracts.STETH,
          contracts.LDO,
          QUOTE_ETH
        )

        expect(result[0]).to.be.gt(0) // basePrice
        expect(result[1]).to.be.gt(0) // quotePrice
        expect(result[2]).to.equal(18) // baseTokenDecimals
        expect(result[3]).to.equal(18) // quoteTokenDecimals
      })

      it('should return ETH prices for same token pair (stETH/stETH)', async function () {
        const result = await oracleRouter.getPricesAndDecimals(
          contracts.STETH,
          contracts.STETH,
          QUOTE_ETH
        )

        expect(result[0]).to.be.gt(0) // basePrice
        expect(result[1]).to.be.gt(0) // quotePrice

        // Same token should have identical prices
        expect(result[0]).to.equal(result[1]) // basePrice == quotePrice
        expect(result[2]).to.equal(18) // baseTokenDecimals
        expect(result[3]).to.equal(18) // quoteTokenDecimals
      })

      it('should return correct token decimals', async function () {
        const result = await oracleRouter.getPricesAndDecimals(
          contracts.STETH,
          contracts.LDO,
          QUOTE_ETH
        )

        // Verify decimals match configured values
        expect(result[2]).to.equal(18) // baseTokenDecimals
        expect(result[3]).to.equal(18) // quoteTokenDecimals
      })

      it('should normalize prices to PRICE_UNIT', async function () {
        const result = await oracleRouter.getPricesAndDecimals(
          contracts.STETH,
          contracts.LDO,
          QUOTE_ETH
        )

        // Prices should be normalized to the configured unit decimals
        const priceUnit = await oracleRouter.PRICE_UNIT()

        // stETH/ETH should be close to 1 (allowing for small deviations)
        const minPrice = (priceUnit * 8n) / 10n // 0.8
        const maxPrice = (priceUnit * 12n) / 10n // 1.2

        expect(result[0]).to.be.gte(minPrice) // basePrice
        expect(result[0]).to.be.lte(maxPrice) // basePrice

        // LDO should have a reasonable ETH price
        expect(result[1]).to.be.gt(0) // quotePrice
        expect(result[1]).to.be.lt(priceUnit) // quotePrice
      })
    })

    describe('Validation - Token not configured', function () {
      it('should revert if base token not configured', async function () {
        const randomAddress = ethers.Wallet.createRandom().address

        await expect(oracleRouter.getPricesAndDecimals(randomAddress, contracts.LDO, QUOTE_ETH))
          .to.be.revertedWithCustomError(oracleRouter, 'TokenNotConfigured')
          .withArgs(randomAddress)
      })

      it('should revert if quote token not configured', async function () {
        const randomAddress = ethers.Wallet.createRandom().address

        await expect(oracleRouter.getPricesAndDecimals(contracts.STETH, randomAddress, QUOTE_ETH))
          .to.be.revertedWithCustomError(oracleRouter, 'TokenNotConfigured')
          .withArgs(randomAddress)
      })

      it('should revert if base token inactive', async function () {
        const agent = await getAgentSigner()

        // Deactivate stETH
        await oracleRouter.connect(agent).setTokenActive(contracts.STETH, false)

        await expect(oracleRouter.getPricesAndDecimals(contracts.STETH, contracts.LDO, QUOTE_ETH))
          .to.be.revertedWithCustomError(oracleRouter, 'TokenNotConfigured')
          .withArgs(contracts.STETH)
      })

      it('should revert if quote token inactive', async function () {
        const agent = await getAgentSigner()

        // Deactivate LDO
        await oracleRouter.connect(agent).setTokenActive(contracts.LDO, false)

        await expect(oracleRouter.getPricesAndDecimals(contracts.STETH, contracts.LDO, QUOTE_ETH))
          .to.be.revertedWithCustomError(oracleRouter, 'TokenNotConfigured')
          .withArgs(contracts.LDO)
      })
    })

    describe('Validation - ETH/USD bridge missing', function () {
      it('should revert when ETH/USD bridge is not configured', async function () {
        const localSnapshot = await takeSnapshot()

        // Deploy a new router without ETH/USD bridge
        const newRouter = await oracleRouterFactory.deploy(agentAddress, 8, feedRegistryAddress)
        await newRouter.waitForDeployment()

        const agent = await getAgentSigner()

        // Configure ETH-quoted tokens but don't set ETH/USD bridge
        await newRouter.connect(agent).setTokenFeed(contracts.STETH, QUOTE_ETH, 86400, 18, true)
        await newRouter.connect(agent).setTokenFeed(contracts.LDO, QUOTE_ETH, 86400, 18, true)

        // Should revert when trying to get USD prices for ETH-quoted tokens
        // This fails with TokenNotUsdQuoted because tokens are ETH-quoted, not USD-quoted
        await expect(
          newRouter.getPricesAndDecimals(contracts.STETH, contracts.LDO, QUOTE_USD)
        ).to.be.revertedWithCustomError(newRouter, 'TokenNotUsdQuoted')

        // To test EthUsdBridgeMissing, we need to call _getUsdPrices which requires the bridge
        // This happens internally when getting USD prices for ETH-quoted tokens
        // We can test this by calling getUsdPrices which internally uses the bridge
        await expect(
          newRouter.getUsdPrices(contracts.STETH, contracts.LDO)
        ).to.be.revertedWithCustomError(newRouter, 'EthUsdBridgeMissing')

        await localSnapshot.restore()
      })
    })

    describe('Validation - Token not ETH-quoted', function () {
      it('should revert if base token is USD-quoted (DAI)', async function () {
        const agent = await getAgentSigner()

        // Configure DAI as USD-quoted
        await oracleRouter.connect(agent).setTokenFeed(contracts.DAI, QUOTE_USD, 86400, 18, true)

        await expect(oracleRouter.getPricesAndDecimals(contracts.DAI, contracts.LDO, QUOTE_ETH))
          .to.be.revertedWithCustomError(oracleRouter, 'TokenNotEthQuoted')
          .withArgs(contracts.DAI)
      })

      it('should revert if quote token is USD-quoted (USDC)', async function () {
        const agent = await getAgentSigner()

        // Configure USDC as USD-quoted
        await oracleRouter.connect(agent).setTokenFeed(contracts.USDC, QUOTE_USD, 86400, 6, true)

        await expect(oracleRouter.getPricesAndDecimals(contracts.STETH, contracts.USDC, QUOTE_ETH))
          .to.be.revertedWithCustomError(oracleRouter, 'TokenNotEthQuoted')
          .withArgs(contracts.USDC)
      })

      it('should revert if both tokens are USD-quoted', async function () {
        const agent = await getAgentSigner()

        // Configure both as USD-quoted
        await oracleRouter.connect(agent).setTokenFeed(contracts.DAI, QUOTE_USD, 86400, 18, true)
        await oracleRouter.connect(agent).setTokenFeed(contracts.USDC, QUOTE_USD, 86400, 6, true)

        // Should revert on the first token (base)
        await expect(oracleRouter.getPricesAndDecimals(contracts.DAI, contracts.USDC, QUOTE_ETH))
          .to.be.revertedWithCustomError(oracleRouter, 'TokenNotEthQuoted')
          .withArgs(contracts.DAI)
      })
    })

    describe('Staleness checks', function () {
      it('should revert if base token feed is stale', async function () {
        // Advance time beyond staleness threshold
        const maxStaleness = 86400 + 3600 // 25 hours
        await ethers.provider.send('evm_increaseTime', [maxStaleness])
        await ethers.provider.send('evm_mine', [])

        await expect(
          oracleRouter.getPricesAndDecimals(contracts.STETH, contracts.LDO, QUOTE_ETH)
        ).to.be.revertedWithCustomError(oracleRouter, 'OracleStale')
      })

      it('should revert if quote token feed is stale', async function () {
        // Advance time beyond staleness threshold
        const maxStaleness = 86400 + 3600 // 25 hours
        await ethers.provider.send('evm_increaseTime', [maxStaleness])
        await ethers.provider.send('evm_mine', [])

        await expect(
          oracleRouter.getPricesAndDecimals(contracts.STETH, contracts.LDO, QUOTE_ETH)
        ).to.be.revertedWithCustomError(oracleRouter, 'OracleStale')
      })
    })

    describe('Edge cases', function () {
      it('should work without ETH/USD bridge configured (does not need bridge)', async function () {
        // getEthPricesAndDecimals should not require ETH/USD bridge since it reads ETH prices directly
        const agent = await getAgentSigner()

        // Deploy a fresh router without bridge
        const freshRouter = await oracleRouterFactory.deploy(agentAddress, 8, feedRegistryAddress)
        await freshRouter.waitForDeployment()

        // Configure only ETH-quoted tokens (no bridge)
        await freshRouter.connect(agent).setTokenFeed(contracts.STETH, QUOTE_ETH, 86400, 18, true)
        await freshRouter.connect(agent).setTokenFeed(contracts.LDO, QUOTE_ETH, 86400, 18, true)

        // Should work without bridge
        const result = await freshRouter.getPricesAndDecimals(
          contracts.STETH,
          contracts.LDO,
          QUOTE_ETH
        )
        expect(result[0]).to.be.gt(0) // basePrice
        expect(result[1]).to.be.gt(0) // quotePrice
      })

      it('should work with tokens that have different decimals', async function () {
        const agent = await getAgentSigner()

        // Configure a token with 6 decimals
        await oracleRouter.connect(agent).setTokenFeed(contracts.USDC, QUOTE_ETH, 86400, 6, true)

        // Should handle the decimal difference
        const result = await oracleRouter.getPricesAndDecimals(
          contracts.STETH,
          contracts.USDC,
          QUOTE_ETH
        )
        expect(result[2]).to.equal(18) // baseTokenDecimals
        expect(result[3]).to.equal(6) // quoteTokenDecimals
        expect(result[0]).to.be.gt(0) // basePrice
        expect(result[1]).to.be.gt(0) // quotePrice
      })
    })
  })

  describe('Edge Cases', function () {
    it('should handle maximum valid staleness value', async function () {
      const agent = await getAgentSigner()
      const maxStaleness = 2n ** 32n - 1n

      await expect(
        oracleRouter.connect(agent).setTokenFeed(contracts.USDT, QUOTE_USD, maxStaleness, 6, true)
      ).to.not.be.reverted
    })
  })

  after(async function () {
    await snapshot.restore()
    resetTestFeedRegistryStub()
  })
})
