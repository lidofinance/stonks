import { ethers } from 'hardhat'
import { expect } from 'chai'
import { parseEther } from 'ethers'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import type {
  OracleRouter,
  AmountConverter,
  AmountConverterFactory,
  ChainlinkFeedRegistryStub,
} from '../../typechain-types'
import { getContracts } from '../../utils/contracts'
import { QuoteDenomination } from '../../utils/oracle-router'
import { getFeedData, getExpectedConversion } from '../helpers/oracle-helpers'
import { createStubWithFeedData } from '../../utils/chainlink-helpers'

const contracts = getContracts()

describe('OracleRouter edge cases', function () {
  let router: OracleRouter
  let factory: AmountConverterFactory
  let snapshot: SnapshotRestorer
  let deployer: any

  before(async () => {
    snapshot = await takeSnapshot()
    ;[deployer] = await ethers.getSigners()
  })

  after(async () => {
    await snapshot.restore()
  })

  async function deployConverter(
    tokensToSell: string[],
    tokensToBuy: string[],
    useEthAnchor: boolean
  ): Promise<AmountConverter> {
    const tx = await factory.deployAmountConverter(tokensToSell, tokensToBuy, useEthAnchor)
    const receipt = await tx.wait()
    const factoryAddress = (await factory.getAddress()).toLowerCase()
    const eventLog = receipt?.logs.find((log: any) => log.address?.toLowerCase() === factoryAddress)
    if (!eventLog) {
      throw new Error('AmountConverterDeployed event not found')
    }
    const converterAddress = factory.interface.parseLog({
      topics: [...eventLog.topics],
      data: eventLog.data,
    })?.args[0]
    return ethers.getContractAt('AmountConverter', converterAddress)
  }

  describe('Boundary conditions', function () {
    let localSnapshot: SnapshotRestorer

    beforeEach(async () => {
      localSnapshot = await takeSnapshot()

      const routerFactory = await ethers.getContractFactory('OracleRouter')
      router = await routerFactory.deploy(
        await deployer.getAddress(),
        contracts.CHAINLINK_PRICE_FEED_REGISTRY
      )
      await router.waitForDeployment()

      const factoryContract = await ethers.getContractFactory('AmountConverterFactory')
      factory = await factoryContract.deploy(await router.getAddress())
      await factory.waitForDeployment()
    })

    afterEach(async () => {
      await localSnapshot.restore()
    })

    it('should handle minimum non-zero amount (1 wei)', async () => {
      await router.setTokenFeed(contracts.STETH, QuoteDenomination.USD, 86400, true)
      await router.setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, true)

      const converter = await deployConverter([contracts.STETH], [contracts.DAI], false)
      const result = await converter.getExpectedOut(contracts.STETH, contracts.DAI, 1n)

      const expected = await getExpectedConversion(contracts.STETH, contracts.DAI, 1n)
      expect(result).to.be.closeTo(expected, 1n)
    })

    it('should handle maximum realistic amount (1B tokens)', async () => {
      await router.setTokenFeed(contracts.STETH, QuoteDenomination.USD, 86400, true)
      await router.setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, true)

      const converter = await deployConverter([contracts.STETH], [contracts.DAI], false)
      const amount = parseEther('1000000000')

      await expect(converter.getExpectedOut(contracts.STETH, contracts.DAI, amount)).to.not.be
        .reverted
    })

    it('should handle token with very small amount (1000 wei)', async () => {
      await router.setTokenFeed(contracts.STETH, QuoteDenomination.USD, 86400, true)
      await router.setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, true)

      const converter = await deployConverter([contracts.STETH], [contracts.DAI], false)
      const result = await converter.getExpectedOut(contracts.STETH, contracts.DAI, 1000n)

      const expected = await getExpectedConversion(contracts.STETH, contracts.DAI, 1000n)
      expect(result).to.be.closeTo(expected, 10n)
    })
  })

  describe('Feed data edge cases', function () {
    let stub: ChainlinkFeedRegistryStub
    let localSnapshot: SnapshotRestorer

    beforeEach(async () => {
      localSnapshot = await takeSnapshot()

      stub = await createStubWithFeedData([contracts.STETH, contracts.DAI])
      const stubAddress = await stub.getAddress()

      const [deployer] = await ethers.getSigners()
      const routerFactory = await ethers.getContractFactory('OracleRouter')
      router = await routerFactory.deploy(await deployer.getAddress(), stubAddress)
      await router.waitForDeployment()

      const factoryContract = await ethers.getContractFactory('AmountConverterFactory')
      factory = await factoryContract.deploy(await router.getAddress())
      await factory.waitForDeployment()
    })

    afterEach(async () => {
      await localSnapshot.restore()
    })

    it('should revert on negative price from feed', async () => {
      const stethData = await getFeedData(contracts.STETH, contracts.CHAINLINK_USD_QUOTE)
      const daiData = await getFeedData(contracts.DAI, contracts.CHAINLINK_USD_QUOTE)
      const nowTs = BigInt((await ethers.provider.getBlock('latest'))!.timestamp)

      await stub.setFeed(contracts.STETH, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: await stub.getAddress(),
        answer: -1n,
        updatedAt: nowTs,
        startedAt: nowTs,
        answeredInRound: 1n,
        roundId: 1n,
        decimals: stethData.decimals,
      })

      await stub.setFeed(contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: await stub.getAddress(),
        answer: daiData.answer,
        updatedAt: nowTs,
        startedAt: nowTs,
        answeredInRound: 1n,
        roundId: 1n,
        decimals: daiData.decimals,
      })

      await router.setTokenFeed(contracts.STETH, QuoteDenomination.USD, 86400, true)
      await router.setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, true)

      const converter = await deployConverter([contracts.STETH], [contracts.DAI], false)

      await expect(
        converter.getExpectedOut(contracts.STETH, contracts.DAI, parseEther('1'))
      ).to.be.revertedWithCustomError(router, 'OracleBadAnswer')
    })

    it('should accept feed with timestamp within heartbeat', async () => {
      const stethData = await getFeedData(contracts.STETH, contracts.CHAINLINK_USD_QUOTE)
      const daiData = await getFeedData(contracts.DAI, contracts.CHAINLINK_USD_QUOTE)
      const nowTs = BigInt((await ethers.provider.getBlock('latest'))!.timestamp)
      const heartbeat = 86400n
      const validTs = nowTs - heartbeat + 10n

      await stub.setFeed(contracts.STETH, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: await stub.getAddress(),
        answer: stethData.answer,
        updatedAt: validTs,
        startedAt: validTs,
        answeredInRound: 1n,
        roundId: 1n,
        decimals: stethData.decimals,
      })

      await stub.setFeed(contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: await stub.getAddress(),
        answer: daiData.answer,
        updatedAt: nowTs,
        startedAt: nowTs,
        answeredInRound: 1n,
        roundId: 1n,
        decimals: daiData.decimals,
      })

      await router.setTokenFeed(contracts.STETH, QuoteDenomination.USD, Number(heartbeat), true)
      await router.setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, true)

      const converter = await deployConverter([contracts.STETH], [contracts.DAI], false)

      await expect(converter.getExpectedOut(contracts.STETH, contracts.DAI, parseEther('1'))).to.not
        .be.reverted
    })

    it('should revert on feed with stale timestamp 1 second past heartbeat', async () => {
      const stethData = await getFeedData(contracts.STETH, contracts.CHAINLINK_USD_QUOTE)
      const daiData = await getFeedData(contracts.DAI, contracts.CHAINLINK_USD_QUOTE)
      const nowTs = BigInt((await ethers.provider.getBlock('latest'))!.timestamp)
      const heartbeat = 86400n
      const staleTs = nowTs - heartbeat - 1n

      await stub.setFeed(contracts.STETH, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: await stub.getAddress(),
        answer: stethData.answer,
        updatedAt: staleTs,
        startedAt: staleTs,
        answeredInRound: 1n,
        roundId: 1n,
        decimals: stethData.decimals,
      })

      await stub.setFeed(contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
        aggregator: await stub.getAddress(),
        answer: daiData.answer,
        updatedAt: nowTs,
        startedAt: nowTs,
        answeredInRound: 1n,
        roundId: 1n,
        decimals: daiData.decimals,
      })

      await router.setTokenFeed(contracts.STETH, QuoteDenomination.USD, Number(heartbeat), true)
      await router.setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, true)

      const converter = await deployConverter([contracts.STETH], [contracts.DAI], false)

      await expect(
        converter.getExpectedOut(contracts.STETH, contracts.DAI, parseEther('1'))
      ).to.be.revertedWithCustomError(router, 'OracleStale')
    })
  })

  describe('Multi-token conversion chains', function () {
    let localSnapshot: SnapshotRestorer

    // Wide enough that a live 24h-heartbeat feed never reads as stale here.
    const STALENESS = 604800 // seconds

    beforeEach(async () => {
      localSnapshot = await takeSnapshot()

      const routerFactory = await ethers.getContractFactory('OracleRouter')
      router = await routerFactory.deploy(
        await deployer.getAddress(),
        contracts.CHAINLINK_PRICE_FEED_REGISTRY
      )
      await router.waitForDeployment()

      const factoryContract = await ethers.getContractFactory('AmountConverterFactory')
      factory = await factoryContract.deploy(await router.getAddress())
      await factory.waitForDeployment()
    })

    afterEach(async () => {
      await localSnapshot.restore()
    })

    it('should handle A→B→C conversion maintaining accuracy', async () => {
      await router.setTokenFeed(contracts.STETH, QuoteDenomination.USD, STALENESS, true)
      await router.setTokenFeed(contracts.DAI, QuoteDenomination.USD, STALENESS, true)
      await router.setTokenFeed(contracts.USDC, QuoteDenomination.USD, STALENESS, true)

      const converter = await deployConverter(
        [contracts.STETH, contracts.DAI],
        [contracts.DAI, contracts.USDC],
        false
      )

      const amount = parseEther('100')

      const stethToDai = await converter.getExpectedOut(contracts.STETH, contracts.DAI, amount)

      const daiToUsdc = await converter.getExpectedOut(contracts.DAI, contracts.USDC, stethToDai)

      const directStethToUsdc = await converter.getExpectedOut(
        contracts.STETH,
        contracts.USDC,
        amount
      )

      expect(daiToUsdc).to.be.closeTo(directStethToUsdc, directStethToUsdc / 1000n)
    })

    it('should maintain commutativity: A→B then B→A ≈ original amount', async () => {
      await router.setTokenFeed(contracts.STETH, QuoteDenomination.USD, STALENESS, true)
      await router.setTokenFeed(contracts.DAI, QuoteDenomination.USD, STALENESS, true)

      const converter = await deployConverter(
        [contracts.STETH, contracts.DAI],
        [contracts.DAI, contracts.STETH],
        false
      )

      const originalAmount = parseEther('100')

      const stethToDai = await converter.getExpectedOut(
        contracts.STETH,
        contracts.DAI,
        originalAmount
      )

      const daiToSteth = await converter.getExpectedOut(contracts.DAI, contracts.STETH, stethToDai)

      expect(daiToSteth).to.be.closeTo(originalAmount, originalAmount / 100n)
    })

    it('should maintain transitivity across 5 tokens', async () => {
      await router.setTokenFeed(contracts.STETH, QuoteDenomination.USD, STALENESS, true)
      await router.setTokenFeed(contracts.DAI, QuoteDenomination.USD, STALENESS, true)
      await router.setTokenFeed(contracts.USDC, QuoteDenomination.USD, STALENESS, true)
      await router.setTokenFeed(contracts.USDT, QuoteDenomination.USD, STALENESS, true)

      const converter = await deployConverter(
        [contracts.STETH, contracts.DAI, contracts.USDC, contracts.USDT],
        [contracts.DAI, contracts.USDC, contracts.USDT, contracts.STETH],
        false
      )

      const amount = parseEther('10')

      const step1 = await converter.getExpectedOut(contracts.STETH, contracts.DAI, amount)
      const step2 = await converter.getExpectedOut(contracts.DAI, contracts.USDC, step1)
      const step3 = await converter.getExpectedOut(contracts.USDC, contracts.USDT, step2)
      const step4 = await converter.getExpectedOut(contracts.USDT, contracts.STETH, step3)

      expect(step4).to.be.closeTo(amount, amount / 50n)
    })
  })

  describe('Denomination switching', function () {
    let localSnapshot: SnapshotRestorer

    beforeEach(async () => {
      localSnapshot = await takeSnapshot()

      const routerFactory = await ethers.getContractFactory('OracleRouter')
      router = await routerFactory.deploy(
        await deployer.getAddress(),
        contracts.CHAINLINK_PRICE_FEED_REGISTRY
      )
      await router.waitForDeployment()

      const factoryContract = await ethers.getContractFactory('AmountConverterFactory')
      factory = await factoryContract.deploy(await router.getAddress())
      await factory.waitForDeployment()
    })

    afterEach(async () => {
      await localSnapshot.restore()
    })

    it('should produce consistent results when switching between USD and ETH modes', async () => {
      await router.setEthUsdBridge(86400)
      await router.setTokenFeed(contracts.STETH, QuoteDenomination.USD, 86400, true)
      await router.setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86400, true)
      await router.setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, true)

      const converterUsd = await deployConverter([contracts.STETH], [contracts.DAI], false)

      const converterEth = await deployConverter([contracts.STETH], [contracts.DAI], true)

      const amount = parseEther('1')
      const resultUsd = await converterUsd.getExpectedOut(contracts.STETH, contracts.DAI, amount)
      const resultEth = await converterEth.getExpectedOut(contracts.STETH, contracts.DAI, amount)

      expect(resultUsd).to.be.closeTo(resultEth, resultUsd / 100n)
    })

    it('should handle token configured for both USD and ETH simultaneously', async () => {
      await router.setEthUsdBridge(86400)
      await router.setTokenFeed(contracts.STETH, QuoteDenomination.USD, 86400, true)
      await router.setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86400, true)

      const [priceUsd] = await router.getPricesAndDecimals(
        contracts.STETH,
        contracts.STETH,
        QuoteDenomination.USD
      )
      const [priceEth] = await router.getPricesAndDecimals(
        contracts.STETH,
        contracts.STETH,
        QuoteDenomination.ETH
      )

      expect(priceUsd).to.not.equal(0n)
      expect(priceEth).to.not.equal(0n)
      expect(priceUsd).to.not.equal(priceEth)
    })
  })

  describe('Configuration changes during operation', function () {
    let localSnapshot: SnapshotRestorer

    beforeEach(async () => {
      localSnapshot = await takeSnapshot()

      const routerFactory = await ethers.getContractFactory('OracleRouter')
      router = await routerFactory.deploy(
        await deployer.getAddress(),
        contracts.CHAINLINK_PRICE_FEED_REGISTRY
      )
      await router.waitForDeployment()

      const factoryContract = await ethers.getContractFactory('AmountConverterFactory')
      factory = await factoryContract.deploy(await router.getAddress())
      await factory.waitForDeployment()
    })

    afterEach(async () => {
      await localSnapshot.restore()
    })

    it('should reflect heartbeat change immediately', async () => {
      await router.setTokenFeed(contracts.STETH, QuoteDenomination.USD, 3600, true)

      const staleness1 = (await router.tokenConfig(contracts.STETH))[0][3]
      expect(staleness1).to.equal(3600)

      await router.setTokenFeed(contracts.STETH, QuoteDenomination.USD, 7200, true)

      const staleness2 = (await router.tokenConfig(contracts.STETH))[0][3]
      expect(staleness2).to.equal(7200)
    })

    it('should deactivate token and reject queries immediately', async () => {
      await router.setTokenFeed(contracts.STETH, QuoteDenomination.USD, 86400, true)
      await router.setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, true)

      const converter = await deployConverter([contracts.STETH], [contracts.DAI], false)

      await expect(converter.getExpectedOut(contracts.STETH, contracts.DAI, parseEther('1'))).to.not
        .be.reverted

      await router.setTokenActive(contracts.STETH, false)

      await expect(
        converter.getExpectedOut(contracts.STETH, contracts.DAI, parseEther('1'))
      ).to.be.revertedWithCustomError(router, 'TokenNotConfigured')
    })

    it('should reactivate token and accept queries immediately', async () => {
      await router.setTokenFeed(contracts.STETH, QuoteDenomination.USD, 86400, true)
      await router.setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, true)

      const converter = await deployConverter([contracts.STETH], [contracts.DAI], false)

      await router.setTokenActive(contracts.STETH, false)

      await expect(
        converter.getExpectedOut(contracts.STETH, contracts.DAI, parseEther('1'))
      ).to.be.revertedWithCustomError(router, 'TokenNotConfigured')

      await router.setTokenActive(contracts.STETH, true)

      await expect(converter.getExpectedOut(contracts.STETH, contracts.DAI, parseEther('1'))).to.not
        .be.reverted
    })
  })
})
