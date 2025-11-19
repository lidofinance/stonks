import { ethers } from 'hardhat'
import { expect } from 'chai'
import { parseEther } from 'ethers'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import type { AmountConverter, OracleRouter } from '../../typechain-types'
import { getContracts } from '../../utils/contracts'
import {
  getAllTestTokens,
  refreshTestFeedData,
  resetTestFeedRegistryStub,
} from '../../utils/test-feed-registry'
import { getTestOracleRouter, resetTestOracleRouter } from '../../utils/test-oracle-router'
import { QuoteDenomination } from '../../utils/oracle-router'

const contracts = getContracts()
type QuoteValue = (typeof QuoteDenomination)[keyof typeof QuoteDenomination]

const calculateExpectedOutput = (
  amountFrom: bigint,
  priceFrom: bigint,
  priceTo: bigint,
  decimalsFrom: number,
  decimalsTo: number
): bigint => {
  const sellHasMoreOrEqualDecimals = decimalsFrom >= decimalsTo
  const decimalsDiff = sellHasMoreOrEqualDecimals
    ? decimalsFrom - decimalsTo
    : decimalsTo - decimalsFrom

  if (sellHasMoreOrEqualDecimals) {
    const grossOutput = (amountFrom * priceFrom) / priceTo
    return decimalsDiff === 0 ? grossOutput : grossOutput / 10n ** BigInt(decimalsDiff)
  }

  const pow10 = 10n ** BigInt(decimalsDiff)
  const scaledAmountFrom = amountFrom * pow10
  return (scaledAmountFrom * priceFrom) / priceTo
}

const getExpectedOutFromRouter = async (
  router: OracleRouter,
  tokenFrom: string,
  tokenTo: string,
  amount: bigint,
  denomination: QuoteValue
): Promise<bigint> => {
  const [priceFrom, priceTo, decimalsFrom, decimalsTo] = await router.getPricesAndDecimals(
    tokenFrom,
    tokenTo,
    denomination
  )

  return calculateExpectedOutput(
    amount,
    priceFrom,
    priceTo,
    Number(decimalsFrom),
    Number(decimalsTo)
  )
}

describe('AmountConverter - ETH/USD Modes', () => {
  let router: OracleRouter
  let factory: any
  let snapshot: SnapshotRestorer

  before(async () => {
    snapshot = await takeSnapshot()

    router = await getTestOracleRouter({
      tokens: getAllTestTokens(),
      useRealPrices: true,
      agent: contracts.AGENT, // Use the same agent address
    })

    await refreshTestFeedData(getAllTestTokens())

    // Use agent signer for setTokenFeed
    const agent = await ethers.getImpersonatedSigner(contracts.AGENT)
    await (
      await ethers.getSigners()
    )[0].sendTransaction({
      to: contracts.AGENT,
      value: parseEther('1'),
    })

    await router
      .connect(agent)
      .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86400, 18, true)
    await router.connect(agent).setTokenFeed(contracts.LDO, QuoteDenomination.ETH, 86400, 18, true)

    factory = await ethers.getContractFactory('AmountConverter')
  })

  after(async () => {
    await snapshot.restore()
    resetTestOracleRouter()
    resetTestFeedRegistryStub()
  })

  describe('useEthAnchor=true', () => {
    let ethConverter: AmountConverter

    beforeEach(async () => {
      ethConverter = await factory.deploy(
        await router.getAddress(),
        [contracts.STETH],
        [contracts.LDO],
        true
      )
      await ethConverter.waitForDeployment()
    })

    describe('ETH-quoted pairs', () => {
      it('should convert stETH to LDO', async () => {
        const amount = parseEther('1')
        const result = await ethConverter.getExpectedOut(contracts.STETH, contracts.LDO, amount)

        const expected = await getExpectedOutFromRouter(
          router,
          contracts.STETH,
          contracts.LDO,
          amount,
          QuoteDenomination.ETH
        )

        expect(result).to.equal(expected)
      })

      it('should scale proportionally with amount', async () => {
        const amount1 = parseEther('0.5')
        const amount2 = parseEther('1')
        const result1 = await ethConverter.getExpectedOut(contracts.STETH, contracts.LDO, amount1)
        const result2 = await ethConverter.getExpectedOut(contracts.STETH, contracts.LDO, amount2)

        const expected1 = await getExpectedOutFromRouter(
          router,
          contracts.STETH,
          contracts.LDO,
          amount1,
          QuoteDenomination.ETH
        )
        const expected2 = await getExpectedOutFromRouter(
          router,
          contracts.STETH,
          contracts.LDO,
          amount2,
          QuoteDenomination.ETH
        )

        expect(result1).to.equal(expected1)
        expect(result2).to.equal(expected2)

        const scaled = expected1 * (amount2 / amount1)
        expect(expected2).to.be.closeTo(scaled, 1n)
      })

      it('should handle small amounts', async () => {
        const amount = parseEther('0.001')
        const result = await ethConverter.getExpectedOut(contracts.STETH, contracts.LDO, amount)

        const expected = await getExpectedOutFromRouter(
          router,
          contracts.STETH,
          contracts.LDO,
          amount,
          QuoteDenomination.ETH
        )

        expect(result).to.equal(expected)
      })

      it('should handle large amounts', async () => {
        const amount = parseEther('1000')
        const result = await ethConverter.getExpectedOut(contracts.STETH, contracts.LDO, amount)

        const expected = await getExpectedOutFromRouter(
          router,
          contracts.STETH,
          contracts.LDO,
          amount,
          QuoteDenomination.ETH
        )

        expect(result).to.equal(expected)
      })

      it('should be deterministic', async () => {
        const amount = parseEther('5')
        const result1 = await ethConverter.getExpectedOut(contracts.STETH, contracts.LDO, amount)
        const result2 = await ethConverter.getExpectedOut(contracts.STETH, contracts.LDO, amount)

        expect(result1).to.equal(result2)
      })
    })

    describe('USD-quoted tokens', () => {
      it('should revert when selling USD-quoted token', async () => {
        const amount = parseEther('1000')

        await expect(ethConverter.getExpectedOut(contracts.DAI, contracts.LDO, amount))
          .to.be.revertedWithCustomError(ethConverter, 'SellTokenNotAllowed')
          .withArgs(contracts.DAI)
      })

      it('should revert when buying USD-quoted token', async () => {
        const amount = parseEther('1')

        await expect(ethConverter.getExpectedOut(contracts.STETH, contracts.DAI, amount))
          .to.be.revertedWithCustomError(ethConverter, 'BuyTokenNotAllowed')
          .withArgs(contracts.DAI)
      })

      it('should work with mixed denominations via bridging', async () => {
        const mixedConverter = await factory.deploy(
          await router.getAddress(),
          [contracts.STETH],
          [contracts.DAI],
          true
        )
        await mixedConverter.waitForDeployment()

        // Configure DAI as USD-quoted for bridging test
        const agent = await ethers.getImpersonatedSigner(contracts.AGENT)
        await (
          await ethers.getSigners()
        )[0].sendTransaction({
          to: contracts.AGENT,
          value: parseEther('1'),
        })

        // Ensure ETH/USD feed exists before setting bridge
        await refreshTestFeedData([]) // Refresh ETH/USD feed

        // Verify feed exists, if not set it up
        const feedRegistry = await ethers.getContractAt(
          'ChainlinkFeedRegistryStub',
          await router.FEED_REGISTRY()
        )
        const ethUsdFeed = await feedRegistry.feeds(
          contracts.CHAINLINK_ETH_QUOTE,
          contracts.CHAINLINK_USD_QUOTE
        )

        if (ethUsdFeed.aggregator === ethers.ZeroAddress) {
          const latestBlock = await ethers.provider.getBlock('latest')
          const nowTs = BigInt(latestBlock!.timestamp)
          const ethUsdPrice = 3000n * 10n ** 8n // $3000 with 8 decimals
          await feedRegistry.setFeed(contracts.CHAINLINK_ETH_QUOTE, contracts.CHAINLINK_USD_QUOTE, {
            aggregator: await feedRegistry.getAddress(),
            answer: ethUsdPrice,
            updatedAt: nowTs,
            startedAt: nowTs,
            answeredInRound: 1n,
            roundId: 1n,
            decimals: 8,
          })
        }

        // Now set the bridge (feed should exist now)
        await router.connect(agent).setEthUsdBridge(86400)
        await router
          .connect(agent)
          .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, 18, true)

        const amount = parseEther('1')
        const result = await mixedConverter.getExpectedOut(contracts.STETH, contracts.DAI, amount)

        const expected = await getExpectedOutFromRouter(
          router,
          contracts.STETH,
          contracts.DAI,
          amount,
          QuoteDenomination.ETH
        )
        expect(result).to.equal(expected)
      })
    })
  })

  describe('useEthAnchor=false', () => {
    let usdConverter: AmountConverter

    beforeEach(async () => {
      usdConverter = await factory.deploy(
        await router.getAddress(),
        [contracts.DAI],
        [contracts.USDC],
        false
      )
      await usdConverter.waitForDeployment()
    })

    describe('USD-quoted pairs', () => {
      it('should convert DAI to USDC', async () => {
        const amount = parseEther('1000')
        const result = await usdConverter.getExpectedOut(contracts.DAI, contracts.USDC, amount)

        const expected = await getExpectedOutFromRouter(
          router,
          contracts.DAI,
          contracts.USDC,
          amount,
          QuoteDenomination.USD
        )
        expect(result).to.equal(expected)
      })

      it('should handle large conversions', async () => {
        const amount = parseEther('100000')
        const result = await usdConverter.getExpectedOut(contracts.DAI, contracts.USDC, amount)

        const expected = await getExpectedOutFromRouter(
          router,
          contracts.DAI,
          contracts.USDC,
          amount,
          QuoteDenomination.USD
        )
        expect(result).to.equal(expected)
      })
    })

    describe('Mixed denominations with USD mode (bridging)', () => {
      beforeEach(async () => {
        const agent = await ethers.getImpersonatedSigner(contracts.AGENT)
        await (
          await ethers.getSigners()
        )[0].sendTransaction({
          to: contracts.AGENT,
          value: parseEther('1'),
        })

        // Ensure ETH/USD feed exists before setting bridge
        await refreshTestFeedData([]) // Refresh ETH/USD feed

        // Verify feed exists, if not set it up
        const feedRegistry = await ethers.getContractAt(
          'ChainlinkFeedRegistryStub',
          await router.FEED_REGISTRY()
        )
        const ethUsdFeed = await feedRegistry.feeds(
          contracts.CHAINLINK_ETH_QUOTE,
          contracts.CHAINLINK_USD_QUOTE
        )

        if (ethUsdFeed.aggregator === ethers.ZeroAddress) {
          const latestBlock = await ethers.provider.getBlock('latest')
          const nowTs = BigInt(latestBlock!.timestamp)
          const ethUsdPrice = 3000n * 10n ** 8n // $3000 with 8 decimals
          await feedRegistry.setFeed(contracts.CHAINLINK_ETH_QUOTE, contracts.CHAINLINK_USD_QUOTE, {
            aggregator: await feedRegistry.getAddress(),
            answer: ethUsdPrice,
            updatedAt: nowTs,
            startedAt: nowTs,
            answeredInRound: 1n,
            roundId: 1n,
            decimals: 8,
          })
        }

        // Now set the bridge (feed should exist now)
        await router.connect(agent).setEthUsdBridge(86400)
      })

      it('should bridge ETH-quoted token to USD when selling in USD mode converter', async () => {
        const ethTokenConverter = await factory.deploy(
          await router.getAddress(),
          [contracts.STETH],
          [contracts.DAI],
          false
        )
        await ethTokenConverter.waitForDeployment()

        const amount = parseEther('1')
        const result = await ethTokenConverter.getExpectedOut(
          contracts.STETH,
          contracts.DAI,
          amount
        )

        const expected = await getExpectedOutFromRouter(
          router,
          contracts.STETH,
          contracts.DAI,
          amount,
          QuoteDenomination.USD
        )
        expect(result).to.equal(expected)
      })

      it('should bridge ETH-quoted token to USD when buying in USD mode converter', async () => {
        const ethTokenConverter = await factory.deploy(
          await router.getAddress(),
          [contracts.DAI],
          [contracts.STETH],
          false
        )
        await ethTokenConverter.waitForDeployment()

        const amount = parseEther('1000')
        const result = await ethTokenConverter.getExpectedOut(
          contracts.DAI,
          contracts.STETH,
          amount
        )

        const expected = await getExpectedOutFromRouter(
          router,
          contracts.DAI,
          contracts.STETH,
          amount,
          QuoteDenomination.USD
        )
        expect(result).to.equal(expected)
      })

      it('should work with both tokens having different denominations', async () => {
        const agent = await ethers.getImpersonatedSigner(contracts.AGENT)
        await router
          .connect(agent)
          .setTokenFeed(contracts.LDO, QuoteDenomination.ETH, 86400, 18, true)

        const mixedConverter = await factory.deploy(
          await router.getAddress(),
          [contracts.DAI],
          [contracts.LDO],
          false
        )
        await mixedConverter.waitForDeployment()

        const amount = parseEther('1000')
        const result = await mixedConverter.getExpectedOut(contracts.DAI, contracts.LDO, amount)

        const expected = await getExpectedOutFromRouter(
          router,
          contracts.DAI,
          contracts.LDO,
          amount,
          QuoteDenomination.USD
        )
        expect(result).to.equal(expected)
      })
    })

    describe('Validations', () => {
      it('should revert on zero amount', async () => {
        await expect(usdConverter.getExpectedOut(contracts.DAI, contracts.USDC, 0))
          .to.be.revertedWithCustomError(usdConverter, 'InvalidAmount')
          .withArgs(0)
      })

      it('should revert on disallowed sell token', async () => {
        const amount = parseEther('1')
        const notAllowed = contracts.USDT

        await expect(usdConverter.getExpectedOut(notAllowed, contracts.USDC, amount))
          .to.be.revertedWithCustomError(usdConverter, 'SellTokenNotAllowed')
          .withArgs(notAllowed)
      })

      it('should revert on disallowed buy token', async () => {
        const amount = parseEther('1')
        const notAllowed = contracts.USDT

        await expect(usdConverter.getExpectedOut(contracts.DAI, notAllowed, amount))
          .to.be.revertedWithCustomError(usdConverter, 'BuyTokenNotAllowed')
          .withArgs(notAllowed)
      })

      it('should revert if amount exceeds uint128 max', async () => {
        const tooLarge = 2n ** 128n + 1n

        await expect(usdConverter.getExpectedOut(contracts.DAI, contracts.USDC, tooLarge))
          .to.be.revertedWithCustomError(usdConverter, 'AmountFromTooLarge')
          .withArgs(tooLarge)
      })
    })
  })

  describe('USE_ETH_ANCHOR immutable', () => {
    it('should expose correct value for ETH mode', async () => {
      const ethConverter = await factory.deploy(
        await router.getAddress(),
        [contracts.STETH],
        [contracts.LDO],
        true
      )
      await ethConverter.waitForDeployment()

      expect(await ethConverter.USE_ETH_ANCHOR()).to.be.true
    })

    it('should expose correct value for USD mode', async () => {
      const usdConverter = await factory.deploy(
        await router.getAddress(),
        [contracts.STETH],
        [contracts.DAI],
        false
      )
      await usdConverter.waitForDeployment()

      expect(await usdConverter.USE_ETH_ANCHOR()).to.be.false
    })
  })

  describe('Decimal handling', () => {
    it('should handle 18 to 6 decimal conversion', async () => {
      const usdConverter = await factory.deploy(
        await router.getAddress(),
        [contracts.DAI],
        [contracts.USDC],
        false
      )
      await usdConverter.waitForDeployment()

      const amount = parseEther('100')
      const result = await usdConverter.getExpectedOut(contracts.DAI, contracts.USDC, amount)

      const expected = await getExpectedOutFromRouter(
        router,
        contracts.DAI,
        contracts.USDC,
        amount,
        QuoteDenomination.USD
      )
      expect(result).to.equal(expected)
    })

    it('should handle 18 to 18 decimal conversion (ETH mode)', async () => {
      await refreshTestFeedData([contracts.STETH, contracts.LDO])

      const agent = await ethers.getImpersonatedSigner(contracts.AGENT)
      await (
        await ethers.getSigners()
      )[0].sendTransaction({
        to: contracts.AGENT,
        value: parseEther('1'),
      })

      await router
        .connect(agent)
        .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86400, 18, true)
      await router
        .connect(agent)
        .setTokenFeed(contracts.LDO, QuoteDenomination.ETH, 86400, 18, true)

      const ethConverter = await factory.deploy(
        await router.getAddress(),
        [contracts.STETH],
        [contracts.LDO],
        true
      )
      await ethConverter.waitForDeployment()

      const amount = parseEther('1.234567890123456789')
      const result = await ethConverter.getExpectedOut(contracts.STETH, contracts.LDO, amount)

      const expected = await getExpectedOutFromRouter(
        router,
        contracts.STETH,
        contracts.LDO,
        amount,
        QuoteDenomination.ETH
      )
      expect(result).to.equal(expected)
    })
  })
})
