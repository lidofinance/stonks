import { ethers } from 'hardhat'
import { expect } from 'chai'
import { takeSnapshot, SnapshotRestorer, time } from '@nomicfoundation/hardhat-network-helpers'
import type { AmountConverter, AmountConverterFactory, OracleRouter } from '../../typechain-types'
import { getContracts } from '../../utils/contracts'
import {
  getTestFeedRegistryStub,
  getAllTestTokens,
  updateTokenFeed,
  resetTestFeedRegistryStub,
  refreshFeedData,
} from '../../utils/test-feed-registry'
import { getTestOracleRouter, resetTestOracleRouter } from '../../utils/test-oracle-router'
import { QuoteDenomination } from '../../utils/oracle-router'
import { getRouterPriceDecimals } from '../utils/oracle-router-helpers'

const contracts = getContracts()

describe('Integration: OracleRouter Failure Scenarios', function () {
  let router: OracleRouter
  let factory: AmountConverterFactory
  let snapshot: SnapshotRestorer
  let feedRegistryAddress: string

  const feedConfig = {
    tokens: getAllTestTokens(),
    useRealPrices: true,
  }

  const getCurrentTimestamp = async function () {
    const block = await ethers.provider.getBlock('latest')
    return BigInt(block!.timestamp)
  }

  before(async function () {
    snapshot = await takeSnapshot()

    router = await getTestOracleRouter({
      tokens: getAllTestTokens(),
      useRealPrices: true,
      admin: contracts.ADMIN,
    })

    const feedRegistry = await getTestFeedRegistryStub(feedConfig)
    feedRegistryAddress = await feedRegistry.getAddress()

    await refreshFeedData(feedConfig)

    const factoryContract = await ethers.getContractFactory('AmountConverterFactory')
    factory = await factoryContract.deploy(await router.getAddress())
    await factory.waitForDeployment()
  })

  after(async function () {
    await snapshot.restore()
    resetTestOracleRouter()
    resetTestFeedRegistryStub()
  })

  describe('AmountConverter Integration Failures', function () {
    describe('Router error propagation', function () {
      it('should revert with OracleBadAnswer when router receives zero price from feed', async function () {
        const converter = await deployConverter([contracts.DAI], [contracts.USDC], false)

        const adminSigner = await ethers.getImpersonatedSigner(contracts.ADMIN)
        await ethers.provider.send('hardhat_setBalance', [contracts.ADMIN, '0x1000000000000000000'])

        await router
          .connect(adminSigner)
          .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)
        await router
          .connect(adminSigner)
          .setTokenFeed(contracts.USDC, QuoteDenomination.USD, 86_400, true)

        const currentTimestamp = await getCurrentTimestamp()

        const feedRegistry = await ethers.getContractAt(
          'ChainlinkFeedRegistryStub',
          feedRegistryAddress
        )
        const feed = await feedRegistry.feeds(contracts.DAI, contracts.CHAINLINK_USD_QUOTE)

        await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
          answer: 0n,
          updatedAt: currentTimestamp,
          roundId: 1n,
          answeredInRound: 1n,
        })

        await expect(
          converter.getExpectedOut(contracts.DAI, contracts.USDC, ethers.parseEther('1'))
        )
          .to.be.revertedWithCustomError(router, 'OracleBadAnswer')
          .withArgs(feed.aggregator, 0n)
      })

      it('should revert with OracleBadAnswer when router receives zero price for buy token from feed', async function () {
        const converter = await deployConverter([contracts.DAI], [contracts.USDC], false)

        const adminSigner = await ethers.getImpersonatedSigner(contracts.ADMIN)
        await ethers.provider.send('hardhat_setBalance', [contracts.ADMIN, '0x1000000000000000000'])

        await router
          .connect(adminSigner)
          .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)
        await router
          .connect(adminSigner)
          .setTokenFeed(contracts.USDC, QuoteDenomination.USD, 86_400, true)

        const currentTimestamp = await getCurrentTimestamp()

        const feedRegistry = await ethers.getContractAt(
          'ChainlinkFeedRegistryStub',
          feedRegistryAddress
        )
        const feed = await feedRegistry.feeds(contracts.USDC, contracts.CHAINLINK_USD_QUOTE)

        await updateTokenFeed(feedConfig, contracts.USDC, contracts.CHAINLINK_USD_QUOTE, {
          answer: 0n,
          updatedAt: currentTimestamp,
          roundId: 1n,
          answeredInRound: 1n,
        })

        await expect(
          converter.getExpectedOut(contracts.DAI, contracts.USDC, ethers.parseEther('1'))
        )
          .to.be.revertedWithCustomError(router, 'OracleBadAnswer')
          .withArgs(feed.aggregator, 0n)
      })

      it('should revert with OracleBadAnswer when router receives zero price for sell token in ETH mode', async function () {
        const converter = await deployConverter([contracts.STETH], [contracts.LDO], true)

        const adminSigner = await ethers.getImpersonatedSigner(contracts.ADMIN)
        await ethers.provider.send('hardhat_setBalance', [contracts.ADMIN, '0x1000000000000000000'])

        await router.connect(adminSigner).setEthUsdBridge(86_400)
        await router
          .connect(adminSigner)
          .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86_400, true)
        await router
          .connect(adminSigner)
          .setTokenFeed(contracts.LDO, QuoteDenomination.ETH, 86_400, true)

        const currentTimestamp = await getCurrentTimestamp()

        const feedRegistry = await ethers.getContractAt(
          'ChainlinkFeedRegistryStub',
          feedRegistryAddress
        )
        const feed = await feedRegistry.feeds(contracts.STETH, contracts.CHAINLINK_ETH_QUOTE)

        await updateTokenFeed(feedConfig, contracts.STETH, contracts.CHAINLINK_ETH_QUOTE, {
          answer: 0n,
          updatedAt: currentTimestamp,
          roundId: 1n,
          answeredInRound: 1n,
        })

        await expect(
          converter.getExpectedOut(contracts.STETH, contracts.LDO, ethers.parseEther('1'))
        )
          .to.be.revertedWithCustomError(router, 'OracleBadAnswer')
          .withArgs(feed.aggregator, 0n)
      })

      it('should revert with OracleBadAnswer when router receives zero price for buy token in ETH mode', async function () {
        const converter = await deployConverter([contracts.STETH], [contracts.LDO], true)

        const adminSigner = await ethers.getImpersonatedSigner(contracts.ADMIN)
        await ethers.provider.send('hardhat_setBalance', [contracts.ADMIN, '0x1000000000000000000'])

        await router.connect(adminSigner).setEthUsdBridge(86_400)
        await router
          .connect(adminSigner)
          .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86_400, true)
        await router
          .connect(adminSigner)
          .setTokenFeed(contracts.LDO, QuoteDenomination.ETH, 86_400, true)

        const currentTimestamp = await getCurrentTimestamp()

        const feedRegistry = await ethers.getContractAt(
          'ChainlinkFeedRegistryStub',
          feedRegistryAddress
        )
        const feed = await feedRegistry.feeds(contracts.LDO, contracts.CHAINLINK_ETH_QUOTE)

        await updateTokenFeed(feedConfig, contracts.LDO, contracts.CHAINLINK_ETH_QUOTE, {
          answer: 0n,
          updatedAt: currentTimestamp,
          roundId: 1n,
          answeredInRound: 1n,
        })

        await expect(
          converter.getExpectedOut(contracts.STETH, contracts.LDO, ethers.parseEther('1'))
        )
          .to.be.revertedWithCustomError(router, 'OracleBadAnswer')
          .withArgs(feed.aggregator, 0n)
      })

      it('should revert with OracleQuantizedToZero when feed normalizes to zero', async function () {
        const freshRouterFactory = await ethers.getContractFactory('OracleRouter')
        const freshRouter = await freshRouterFactory.deploy(contracts.ADMIN, feedRegistryAddress)
        await freshRouter.waitForDeployment()

        const freshFactoryContract = await ethers.getContractFactory('AmountConverterFactory')
        const freshFactory = await freshFactoryContract.deploy(await freshRouter.getAddress())
        await freshFactory.waitForDeployment()

        const converter = await deployConverterWithFactory(
          freshFactory,
          [contracts.DAI],
          [contracts.USDC],
          false
        )

        const adminSigner = await ethers.getImpersonatedSigner(contracts.ADMIN)
        await ethers.provider.send('hardhat_setBalance', [contracts.ADMIN, '0x1000000000000000000'])

        const currentTimestamp = await getCurrentTimestamp()
        const feedRegistry = await ethers.getContractAt(
          'ChainlinkFeedRegistryStub',
          feedRegistryAddress
        )

        const priceDecimals = await getRouterPriceDecimals(freshRouter)
        const feedDecimals = 20

        expect(priceDecimals).to.equal(18n)

        const scaleDenominator = 10n ** BigInt(feedDecimals - Number(priceDecimals))
        const maxAnswerBeforeZero = scaleDenominator - 1n

        await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
          answer: maxAnswerBeforeZero,
          updatedAt: currentTimestamp,
          roundId: 1n,
          answeredInRound: 1n,
          decimals: feedDecimals,
        })

        await freshRouter
          .connect(adminSigner)
          .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)
        await freshRouter
          .connect(adminSigner)
          .setTokenFeed(contracts.USDC, QuoteDenomination.USD, 86_400, true)

        const feed = await feedRegistry.feeds(contracts.DAI, contracts.CHAINLINK_USD_QUOTE)

        await expect(
          converter.getExpectedOut(contracts.DAI, contracts.USDC, ethers.parseEther('1'))
        )
          .to.be.revertedWithCustomError(freshRouter, 'OracleQuantizedToZero')
          .withArgs(feed.aggregator, feedDecimals, Number(priceDecimals))

        await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
          decimals: 8,
          answer: 1n * 10n ** 8n,
        })
      })
    })

    describe('Bridge missing in ETH mode', function () {
      it('should revert with EthUsdBridgeMissing when bridge not configured and bridging needed', async function () {
        const freshRouterFactory = await ethers.getContractFactory('OracleRouter')
        const freshRouter = await freshRouterFactory.deploy(contracts.ADMIN, feedRegistryAddress)
        await freshRouter.waitForDeployment()

        const freshFactoryContract = await ethers.getContractFactory('AmountConverterFactory')
        const freshFactory = await freshFactoryContract.deploy(await freshRouter.getAddress())
        await freshFactory.waitForDeployment()

        const converter = await deployConverterWithFactory(
          freshFactory,
          [contracts.DAI],
          [contracts.USDC],
          true
        )

        const adminSigner = await ethers.getImpersonatedSigner(contracts.ADMIN)
        await ethers.provider.send('hardhat_setBalance', [contracts.ADMIN, '0x1000000000000000000'])

        await freshRouter
          .connect(adminSigner)
          .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)
        await freshRouter
          .connect(adminSigner)
          .setTokenFeed(contracts.USDC, QuoteDenomination.USD, 86_400, true)

        const currentTimestamp = await getCurrentTimestamp()

        await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
          updatedAt: currentTimestamp,
          roundId: 1n,
          answeredInRound: 1n,
        })
        await updateTokenFeed(feedConfig, contracts.USDC, contracts.CHAINLINK_USD_QUOTE, {
          updatedAt: currentTimestamp,
          roundId: 1n,
          answeredInRound: 1n,
        })

        await expect(
          converter.getExpectedOut(contracts.DAI, contracts.USDC, ethers.parseEther('1'))
        ).to.be.revertedWithCustomError(freshRouter, 'EthUsdBridgeMissing')
      })
    })

    describe('Feed staleness between calls', function () {
      it('should revert with OracleStale when feed becomes stale between converter calls', async function () {
        const converter = await deployConverter([contracts.DAI], [contracts.USDC], false)

        const adminSigner = await ethers.getImpersonatedSigner(contracts.ADMIN)
        await ethers.provider.send('hardhat_setBalance', [contracts.ADMIN, '0x1000000000000000000'])

        await router
          .connect(adminSigner)
          .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 5, true)
        await router
          .connect(adminSigner)
          .setTokenFeed(contracts.USDC, QuoteDenomination.USD, 86_400, true)

        await refreshFeedData(feedConfig, [contracts.DAI, contracts.USDC])

        const freshTimestamp = await getCurrentTimestamp()
        await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
          updatedAt: freshTimestamp,
          roundId: 1n,
          answeredInRound: 1n,
        })
        await updateTokenFeed(feedConfig, contracts.USDC, contracts.CHAINLINK_USD_QUOTE, {
          updatedAt: freshTimestamp,
          roundId: 1n,
          answeredInRound: 1n,
        })

        const firstCall = await converter.getExpectedOut(
          contracts.DAI,
          contracts.USDC,
          ethers.parseEther('1')
        )

        const [priceFrom, priceTo, decimalsFrom, decimalsTo] = await router.getPricesAndDecimals(
          contracts.DAI,
          contracts.USDC,
          QuoteDenomination.USD
        )
        const amountFrom = ethers.parseEther('1')

        // DAI and USDC decimals are known and fixed for this scenario
        expect(decimalsFrom).to.equal(18n)
        expect(decimalsTo).to.equal(6n)

        const decimalsDiff = decimalsFrom - decimalsTo
        const pow10 = 10n ** decimalsDiff
        const scaledPriceTo = priceTo * pow10
        const expectedFirstCall = (amountFrom * priceFrom) / scaledPriceTo

        expect(firstCall).to.equal(expectedFirstCall)

        await time.increase(6)

        await expect(
          converter.getExpectedOut(contracts.DAI, contracts.USDC, ethers.parseEther('1'))
        ).to.be.revertedWithCustomError(router, 'OracleStale')

        await router
          .connect(adminSigner)
          .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)
      })
    })
  })

  const deployConverter = async (
    allowedTokensToSell: string[],
    allowedTokensToBuy: string[],
    useEthAnchor: boolean
  ): Promise<AmountConverter> => {
    return deployConverterWithFactory(
      factory,
      allowedTokensToSell,
      allowedTokensToBuy,
      useEthAnchor
    )
  }

  const deployConverterWithFactory = async (
    factoryInstance: AmountConverterFactory,
    allowedTokensToSell: string[],
    allowedTokensToBuy: string[],
    useEthAnchor: boolean
  ): Promise<AmountConverter> => {
    const tx = await factoryInstance.deployAmountConverter(
      allowedTokensToSell,
      allowedTokensToBuy,
      useEthAnchor
    )
    const receipt = await tx.wait()
    const factoryAddress = (await factoryInstance.getAddress()).toLowerCase()
    const eventLog = receipt?.logs.find((log: any) => log.address?.toLowerCase() === factoryAddress)
    if (!eventLog) {
      throw new Error('AmountConverterDeployed event not found')
    }
    // Fix type compatibility for parseLog argument due to readonly vs mutable array types
    const { topics, data } = eventLog
    const converterAddress = factoryInstance.interface.parseLog({ topics: [...topics], data })
      ?.args[0]
    return ethers.getContractAt('AmountConverter', converterAddress)
  }
})
