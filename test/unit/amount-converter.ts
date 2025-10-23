import { ethers } from 'hardhat'
import { takeSnapshot, SnapshotRestorer, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

import { IAmountConverter, OracleRouter } from '../../typechain-types'
import { getTestOracleRouter, resetTestOracleRouter } from '../../utils/test-oracle-router'
import { refreshTestFeedData } from '../../utils/test-feed-registry'
import { getContracts } from '../../utils/contracts'
import { getExpectedOut } from '../../utils/chainlink-helpers'

const addresses = getContracts()

describe('AmountConverter', () => {
  let converter: IAmountConverter
  let factory: any
  let snapshot: SnapshotRestorer

  let router: OracleRouter
  let routerAddress: string

  const USD = addresses.CHAINLINK_USD_QUOTE
  const WETH = addresses.CHAINLINK_ETH_QUOTE

  const readTokenDecimals = async (token: string) => {
    const tokenInterface = new ethers.Interface(['function decimals() view returns (uint8)'])
    const erc20 = new ethers.Contract(token, tokenInterface, (await ethers.getSigners())[0])
    return erc20.getFunction('decimals').staticCall()
  }

  before(async () => {
    snapshot = await takeSnapshot()
    factory = await ethers.getContractFactory('AmountConverter')

    router = await getTestOracleRouter({
      tokens: [addresses.STETH, addresses.DAI, addresses.USDC, addresses.USDT],
      useRealPrices: true,
    })
    routerAddress = await router.getAddress()

    await refreshTestFeedData([addresses.STETH, addresses.DAI, addresses.USDC, addresses.USDT])

    converter = await factory.deploy(
      routerAddress,
      [addresses.STETH, addresses.DAI, addresses.USDC, addresses.USDT],
      [addresses.DAI, addresses.USDC, addresses.USDT]
    )
    await converter.waitForDeployment()
  })

  describe('initialization:', () => {
    it('reverts on zero oracle router address', async () => {
      await expect(
        factory.deploy(
          ethers.ZeroAddress,
          [addresses.STETH, addresses.DAI, addresses.USDC, addresses.USDT],
          [addresses.DAI, addresses.USDC, addresses.USDT]
        )
      )
        .to.be.revertedWithCustomError(factory, 'InvalidOracleRouterAddress')
        .withArgs(ethers.ZeroAddress)
    })

    it('reverts on empty allowedTokensToSell', async () => {
      await expect(
        factory.deploy(routerAddress, [], [addresses.DAI, addresses.USDC, addresses.USDT])
      ).to.be.revertedWithCustomError(factory, 'InvalidTokensToSellArrayLength')
    })
    it('reverts on empty allowedTokensToBuy', async () => {
      await expect(
        factory.deploy(routerAddress, [addresses.STETH, addresses.DAI], [])
      ).to.be.revertedWithCustomError(factory, 'InvalidTokensToBuyArrayLength')
    })

    it('reverts on zero address in allowedTokensToSell', async () => {
      await expect(
        factory.deploy(routerAddress, [addresses.STETH, ethers.ZeroAddress], [addresses.DAI])
      )
        .to.be.revertedWithCustomError(factory, 'InvalidAllowedTokenToSell')
        .withArgs(ethers.ZeroAddress)
    })

    it('reverts on zero address in allowedTokensToBuy', async () => {
      await expect(factory.deploy(routerAddress, [addresses.STETH], [ethers.ZeroAddress]))
        .to.be.revertedWithCustomError(factory, 'InvalidAllowedTokenToBuy')
        .withArgs(ethers.ZeroAddress)
    })
  })

  describe('getExpectedOut:', () => {
    it('reverts when amount is zero', async () => {
      await expect(converter.getExpectedOut(addresses.STETH, addresses.DAI, 0))
        .to.be.revertedWithCustomError(converter, 'InvalidAmount')
        .withArgs(0)
    })

    it('reverts when tokenFrom is not allowed', async () => {
      await expect(converter.getExpectedOut(addresses.LDO, addresses.DAI, 1))
        .to.be.revertedWithCustomError(converter, 'SellTokenNotAllowed')
        .withArgs(addresses.LDO)
    })

    it('reverts when tokenTo is not allowed', async () => {
      await expect(converter.getExpectedOut(addresses.STETH, addresses.LDO, 1))
        .to.be.revertedWithCustomError(converter, 'BuyTokenNotAllowed')
        .withArgs(addresses.LDO)
    })

    it('reverts when tokenFrom equals tokenTo', async () => {
      await expect(
        converter.getExpectedOut(addresses.STETH, addresses.STETH, 1)
      ).to.be.revertedWithCustomError(converter, 'SameTokensConversion')
    })

    it('matches Chainlink helper for stETH → DAI (18 → 18)', async () => {
      const amountToSell = ethers.parseEther('1')
      const amountFromContract = await converter.getExpectedOut(
        addresses.STETH,
        addresses.DAI,
        amountToSell
      )
      const amountFromHelper = await getExpectedOut(addresses.STETH, addresses.DAI, amountToSell)
      expect(amountFromContract.toString()).to.equal(amountFromHelper.toString())
    })

    it('matches Chainlink helper for USDC → DAI (6 → 18)', async () => {
      const amountToSell = 1_000_000n // 1 USDC with 6 decimals
      const amountFromContract = await converter.getExpectedOut(
        addresses.USDC,
        addresses.DAI,
        amountToSell
      )
      const amountFromHelper = await getExpectedOut(addresses.USDC, addresses.DAI, amountToSell)
      expect(amountFromContract.toString()).to.equal(amountFromHelper.toString())
    })

    it('matches Chainlink helper for DAI → USDC (18 → 6)', async () => {
      const amountToSell = ethers.parseEther('1')
      const amountFromContract = await converter.getExpectedOut(
        addresses.DAI,
        addresses.USDC,
        amountToSell
      )
      const amountFromHelper = await getExpectedOut(addresses.DAI, addresses.USDC, amountToSell)
      expect(amountFromContract.toString()).to.equal(amountFromHelper.toString())
    })

    it('uses ETH bridge path when configured (stETH/ETH * ETH/USD)', async () => {
      const localSnapshot = await takeSnapshot()

      await refreshTestFeedData([addresses.STETH, addresses.DAI])

      const registryAddr = await router.FEED_REGISTRY()
      const stub = await ethers.getContractAt('ChainlinkFeedRegistryStub', registryAddr)

      const latest = await ethers.provider.getBlock('latest')
      const nowTs = BigInt(latest!.timestamp)

      await stub.setFeed(addresses.STETH, WETH, {
        aggregator: await stub.getAddress(),
        answer: 1n * 10n ** 18n,
        updatedAt: nowTs,
        startedAt: nowTs,
        answeredInRound: 1n,
        roundId: 1n,
        decimals: 18,
      })
      await stub.setFeed(WETH, USD, {
        aggregator: await stub.getAddress(),
        answer: 2000n * 10n ** 8n,
        updatedAt: nowTs,
        startedAt: nowTs,
        answeredInRound: 1n,
        roundId: 1n,
        decimals: 8,
      })

      const tokenDecimals = await readTokenDecimals(addresses.STETH)
      await router.setTokenEthFeed(addresses.STETH, 86_400, tokenDecimals, true)

      const bridgeConverter = await factory.deploy(
        await router.getAddress(),
        [addresses.STETH, addresses.DAI],
        [addresses.DAI]
      )
      await bridgeConverter.waitForDeployment()

      const amountToSell = ethers.parseEther('1')
      const amountFromContract = await bridgeConverter.getExpectedOut(
        addresses.STETH,
        addresses.DAI,
        amountToSell
      )

      const [stethUsdPrice, daiUsdPrice] = await router.getUsdPrices(addresses.STETH, addresses.DAI)
      const [sellDecimals, buyDecimals] = await router.getTokenDecimals(
        addresses.STETH,
        addresses.DAI
      )

      const raw = (amountToSell * stethUsdPrice) / daiUsdPrice
      const expected =
        sellDecimals >= buyDecimals
          ? raw / 10n ** BigInt(sellDecimals - buyDecimals)
          : raw * 10n ** BigInt(buyDecimals - sellDecimals)

      expect(amountFromContract.toString()).to.equal(expected.toString())

      await localSnapshot.restore()
    })

    it('should handle very small amounts', async () => {
      await refreshTestFeedData([addresses.STETH, addresses.DAI])
      const tinyAmount = 1n
      const result = await converter.getExpectedOut(addresses.STETH, addresses.DAI, tinyAmount)
      const expectedResult = await getExpectedOut(addresses.STETH, addresses.DAI, tinyAmount)
      expect(result).to.equal(expectedResult)
    })

    it('should handle very large valid amounts', async () => {
      await refreshTestFeedData([addresses.STETH, addresses.DAI])
      const largeAmount = ethers.parseEther('100000')
      const result = await converter.getExpectedOut(addresses.STETH, addresses.DAI, largeAmount)
      const expectedResult = await getExpectedOut(addresses.STETH, addresses.DAI, largeAmount)
      expect(result).to.equal(expectedResult)
    })

    it('should handle amount at uint128 boundary', async () => {
      await refreshTestFeedData([addresses.STETH, addresses.DAI])
      const maxUint128 = 2n ** 128n - 1n
      const result = await converter.getExpectedOut(addresses.STETH, addresses.DAI, maxUint128)
      const expectedResult = await getExpectedOut(addresses.STETH, addresses.DAI, maxUint128)
      expect(result).to.equal(expectedResult)
    })

    it('should handle conversions with maximum decimal difference (38)', async () => {
      await refreshTestFeedData([addresses.DAI, addresses.USDC])
      const largeAmount = 2n ** 127n - 1n
      const result = await converter.getExpectedOut(addresses.DAI, addresses.USDC, largeAmount)
      expect(result).to.be.greaterThan(0)
    })

    it('bubbles router staleness (OracleStale) on outdated feed', async () => {
      const registryAddr = await router.FEED_REGISTRY()
      const stub = await ethers.getContractAt('ChainlinkFeedRegistryStub', registryAddr)

      // Configure short staleness for DAI
      const decimals = await readTokenDecimals(addresses.DAI)
      await router.setTokenUsdFeed(addresses.DAI, 1, decimals, true)

      // Freshen both DAI/USD and ETH/USD to now, then advance time to exceed staleness
      const latest = await ethers.provider.getBlock('latest')
      const nowTs = BigInt(latest!.timestamp)
      const daiUsd = await stub.feeds(addresses.DAI, USD)
      await stub.setFeed(addresses.DAI, USD, {
        aggregator: daiUsd.aggregator,
        answer: daiUsd.answer,
        updatedAt: nowTs,
        startedAt: nowTs,
        answeredInRound: 1n,
        roundId: 1n,
        decimals: daiUsd.decimals,
      })

      await time.increase(2)

      await expect(
        converter.getExpectedOut(addresses.DAI, addresses.USDC, ethers.parseEther('1'))
      ).to.be.revertedWithCustomError(router, 'OracleStale')
    })

    it('bubbles router OracleBadAnswer when tokenTo/USD answer is zero', async () => {
      await refreshTestFeedData([addresses.STETH, addresses.DAI])

      const registryAddr = await router.FEED_REGISTRY()
      const stub = await ethers.getContractAt('ChainlinkFeedRegistryStub', registryAddr)

      const latest = await ethers.provider.getBlock('latest')
      const nowTs = BigInt(latest!.timestamp)

      const current = await stub.feeds(addresses.DAI, USD)
      await stub.setFeed(addresses.DAI, USD, {
        aggregator: current.aggregator,
        answer: 0n,
        updatedAt: nowTs,
        startedAt: nowTs,
        answeredInRound: current.answeredInRound,
        roundId: current.roundId,
        decimals: current.decimals,
      })

      await expect(
        converter.getExpectedOut(addresses.STETH, addresses.DAI, ethers.parseEther('1'))
      ).to.be.revertedWithCustomError(router, 'OracleBadAnswer')

      await refreshTestFeedData([addresses.DAI])
    })

    it('reverts with AmountTooLarge when input exceeds uint128 limit', async () => {
      const tooLarge = 2n ** 128n + 1n
      await expect(
        converter.getExpectedOut(addresses.STETH, addresses.DAI, tooLarge)
      ).to.be.revertedWithCustomError(converter, 'AmountTooLarge')
    })
  })

  describe('events:', () => {
    it('constructor emits allowlist events', async () => {
      const local = await factory.deploy(routerAddress, [addresses.STETH], [addresses.DAI])
      await local.waitForDeployment()

      await expect(local.deploymentTransaction())
        .to.emit(local, 'AllowedTokenToSellAdded')
        .withArgs(addresses.STETH)

      await expect(local.deploymentTransaction())
        .to.emit(local, 'AllowedTokenToBuyAdded')
        .withArgs(addresses.DAI)
    })
  })

  after(async () => {
    await snapshot.restore()
    resetTestOracleRouter()
  })
})
