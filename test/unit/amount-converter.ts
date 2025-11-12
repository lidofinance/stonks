import { ethers } from 'hardhat'
import { takeSnapshot, SnapshotRestorer, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

import { IAmountConverter, OracleRouter } from '../../typechain-types'
import { getTestOracleRouter, resetTestOracleRouter } from '../../utils/test-oracle-router'
import { refreshTestFeedData, resetTestFeedRegistryStub } from '../../utils/test-feed-registry'
import { getContracts } from '../../utils/contracts'
import { getExpectedOut } from '../../utils/chainlink-helpers'

const addresses = getContracts()

describe('AmountConverter', () => {
  let converter: IAmountConverter
  let factory: any
  let snapshot: SnapshotRestorer

  let router: OracleRouter
  let routerAddress: string

  const USD_QUOTE = addresses.CHAINLINK_USD_QUOTE
  const ETH_QUOTE = addresses.CHAINLINK_ETH_QUOTE

  const readTokenDecimals = async (token: string) => {
    const tokenInterface = new ethers.Interface(['function decimals() view returns (uint8)'])
    const erc20 = new ethers.Contract(token, tokenInterface, (await ethers.getSigners())[0])
    return erc20.getFunction('decimals').staticCall()
  }

  before(async () => {
    snapshot = await takeSnapshot()
    factory = await ethers.getContractFactory('AmountConverter')

    router = await getTestOracleRouter({
      tokens: [addresses.DAI, addresses.USDC, addresses.USDT],
      useRealPrices: true,
    })
    routerAddress = await router.getAddress()

    await refreshTestFeedData([addresses.DAI, addresses.USDC, addresses.USDT])

    converter = await factory.deploy(
      routerAddress,
      [addresses.DAI, addresses.USDC, addresses.USDT],
      [addresses.DAI, addresses.USDC, addresses.USDT],
      false
    )
    await converter.waitForDeployment()
  })

  describe('initialization:', () => {
    it('reverts on zero oracle router address', async () => {
      await expect(
        factory.deploy(
          ethers.ZeroAddress,
          [addresses.STETH, addresses.DAI, addresses.USDC, addresses.USDT],
          [addresses.DAI, addresses.USDC, addresses.USDT],
          false
        )
      )
        .to.be.revertedWithCustomError(factory, 'InvalidOracleRouterAddress')
        .withArgs(ethers.ZeroAddress)
    })

    it('reverts on empty allowedTokensToSell', async () => {
      await expect(
        factory.deploy(routerAddress, [], [addresses.DAI, addresses.USDC, addresses.USDT], false)
      ).to.be.revertedWithCustomError(factory, 'InvalidTokensToSellArrayLength')
    })
    it('reverts on empty allowedTokensToBuy', async () => {
      await expect(
        factory.deploy(routerAddress, [addresses.DAI], [], false)
      ).to.be.revertedWithCustomError(factory, 'InvalidTokensToBuyArrayLength')
    })

    it('reverts on zero address in allowedTokensToSell', async () => {
      await expect(
        factory.deploy(routerAddress, [addresses.DAI, ethers.ZeroAddress], [addresses.USDC], false)
      )
        .to.be.revertedWithCustomError(factory, 'InvalidAllowedTokenToSell')
        .withArgs(ethers.ZeroAddress)
    })

    it('reverts on zero address in allowedTokensToBuy', async () => {
      await expect(factory.deploy(routerAddress, [addresses.DAI], [ethers.ZeroAddress], false))
        .to.be.revertedWithCustomError(factory, 'InvalidAllowedTokenToBuy')
        .withArgs(ethers.ZeroAddress)
    })
  })

  describe('getExpectedOut:', () => {
    it('reverts when amount is zero', async () => {
      await expect(converter.getExpectedOut(addresses.DAI, addresses.USDC, 0))
        .to.be.revertedWithCustomError(converter, 'InvalidAmount')
        .withArgs(0)
    })

    it('reverts when tokenFrom is not allowed', async () => {
      await expect(converter.getExpectedOut(addresses.LDO, addresses.DAI, 1))
        .to.be.revertedWithCustomError(converter, 'SellTokenNotAllowed')
        .withArgs(addresses.LDO)
    })

    it('reverts when tokenTo is not allowed', async () => {
      const notAllowedToken = addresses.AGENT // Use any address not in allowlist
      await expect(converter.getExpectedOut(addresses.DAI, notAllowedToken, 1))
        .to.be.revertedWithCustomError(converter, 'BuyTokenNotAllowed')
        .withArgs(notAllowedToken)
    })

    it('reverts when tokenFrom equals tokenTo', async () => {
      await expect(
        converter.getExpectedOut(addresses.DAI, addresses.DAI, 1)
      ).to.be.revertedWithCustomError(converter, 'TokensCannotBeSame')
    })

    it('matches Chainlink helper for DAI → USDC (18 → 6)', async () => {
      const amountToSell = ethers.parseEther('1000')
      const amountFromContract = await converter.getExpectedOut(
        addresses.DAI,
        addresses.USDC,
        amountToSell
      )
      const amountFromHelper = await getExpectedOut(addresses.DAI, addresses.USDC, amountToSell)
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

    it('should handle very small amounts', async () => {
      await refreshTestFeedData([addresses.DAI, addresses.USDC])
      const tinyAmount = 1n
      const result = await converter.getExpectedOut(addresses.DAI, addresses.USDC, tinyAmount)
      const expectedResult = await getExpectedOut(addresses.DAI, addresses.USDC, tinyAmount)
      expect(result).to.equal(expectedResult)
    })

    it('should handle very large valid amounts', async () => {
      await refreshTestFeedData([addresses.DAI, addresses.USDC])
      const largeAmount = ethers.parseEther('100000')
      const result = await converter.getExpectedOut(addresses.DAI, addresses.USDC, largeAmount)
      const expectedResult = await getExpectedOut(addresses.DAI, addresses.USDC, largeAmount)
      expect(result).to.equal(expectedResult)
    })

    it('should handle amount at uint128 boundary', async () => {
      await refreshTestFeedData([addresses.DAI, addresses.USDC])
      const maxUint128 = 2n ** 128n - 1n
      const result = await converter.getExpectedOut(addresses.DAI, addresses.USDC, maxUint128)
      const expectedResult = await getExpectedOut(addresses.DAI, addresses.USDC, maxUint128)
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
      const daiUsd = await stub.feeds(addresses.DAI, USD_QUOTE)
      await stub.setFeed(addresses.DAI, USD_QUOTE, {
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

    it('bubbles router OracleBadAnswer when tokenFrom/USD answer is zero', async () => {
      // First refresh both feeds to ensure they're not stale
      await refreshTestFeedData([addresses.DAI, addresses.USDC])

      const registryAddr = await router.FEED_REGISTRY()
      const stub = await ethers.getContractAt('ChainlinkFeedRegistryStub', registryAddr)

      // Set DAI answer to 0 with far future timestamp to trigger OracleBadAnswer
      // Using tokenFrom instead of tokenTo to test the other path
      const latest = await ethers.provider.getBlock('latest')
      const farFutureTs = BigInt(latest!.timestamp) + 1000000n

      const current = await stub.feeds(addresses.DAI, USD_QUOTE)
      await stub.setFeed(addresses.DAI, USD_QUOTE, {
        aggregator: current.aggregator,
        answer: 0n,
        updatedAt: farFutureTs,
        startedAt: farFutureTs,
        answeredInRound: current.answeredInRound,
        roundId: current.roundId,
        decimals: current.decimals,
      })

      await expect(
        converter.getExpectedOut(addresses.DAI, addresses.USDC, ethers.parseEther('1'))
      ).to.be.revertedWithCustomError(router, 'OracleBadAnswer')

      await refreshTestFeedData([addresses.DAI])
    })

    it('reverts with AmountTooLarge when input exceeds uint128 limit', async () => {
      const tooLarge = 2n ** 128n + 1n
      await expect(
        converter.getExpectedOut(addresses.DAI, addresses.USDC, tooLarge)
      ).to.be.revertedWithCustomError(converter, 'AmountFromTooLarge')
    })
  })

  describe('events:', () => {
    it('constructor emits allowlist events (USD mode)', async () => {
      const local = await factory.deploy(routerAddress, [addresses.DAI], [addresses.USDC], false)
      await local.waitForDeployment()

      await expect(local.deploymentTransaction())
        .to.emit(local, 'AllowedTokenToSellAdded')
        .withArgs(addresses.DAI)

      await expect(local.deploymentTransaction())
        .to.emit(local, 'AllowedTokenToBuyAdded')
        .withArgs(addresses.USDC)
    })

    it('constructor emits allowlist events (ETH anchor mode)', async () => {
      const local = await factory.deploy(routerAddress, [addresses.STETH], [addresses.LDO], true)
      await local.waitForDeployment()

      await expect(local.deploymentTransaction())
        .to.emit(local, 'AllowedTokenToSellAdded')
        .withArgs(addresses.STETH)

      await expect(local.deploymentTransaction())
        .to.emit(local, 'AllowedTokenToBuyAdded')
        .withArgs(addresses.LDO)
    })
  })

  describe('USE_ETH_ANCHOR immutable:', () => {
    it('should be false when deployed with useEthAnchor=false', async () => {
      const local = await factory.deploy(routerAddress, [addresses.DAI], [addresses.USDC], false)
      await local.waitForDeployment()

      expect(await local.USE_ETH_ANCHOR()).to.be.false
    })

    it('should be true when deployed with useEthAnchor=true', async () => {
      const local = await factory.deploy(routerAddress, [addresses.STETH], [addresses.LDO], true)
      await local.waitForDeployment()

      expect(await local.USE_ETH_ANCHOR()).to.be.true
    })
  })

  after(async () => {
    await snapshot.restore()
    resetTestOracleRouter()
    resetTestFeedRegistryStub()
  })
})
