import { ethers } from 'hardhat'
import { takeSnapshot, SnapshotRestorer, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

import { AmountConverter__factory, IAmountConverter, OracleRouter } from '../../typechain-types'
import { deployAndConfigureOracleRouter } from '../../utils/oracle-router'
import { getContracts } from '../../utils/contracts'
import { getExpectedOut } from '../../utils/chainlink-helpers'

const addresses = getContracts()

describe('AmountConverter', () => {
  let converter: IAmountConverter
  let factory: AmountConverter__factory
  let snapshot: SnapshotRestorer

  let router: OracleRouter
  let routerAddress: string

  const FEED_REGISTRY = addresses.CHAINLINK_PRICE_FEED_REGISTRY
  const USD = addresses.CHAINLINK_USD_QUOTE
  const WETH = addresses.CHAINLINK_ETH_QUOTE

  const readAggregatorAddress = async (base: string, quote: string) => {
    const registryInterface = new ethers.Interface([
      'function getFeed(address,address) view returns (address)',
    ])
    const registry = new ethers.Contract(
      FEED_REGISTRY,
      registryInterface,
      (await ethers.getSigners())[0]
    )
    return registry.getFunction('getFeed').staticCall(base, quote)
  }

  const readTokenDecimals = async (token: string) => {
    const tokenInterface = new ethers.Interface(['function decimals() view returns (uint8)'])
    const erc20 = new ethers.Contract(token, tokenInterface, (await ethers.getSigners())[0])
    return erc20.getFunction('decimals').staticCall()
  }

  const configureRouterEthUsd = async (r: OracleRouter, maxStalenessSeconds: number) => {
    const aggregator = await readAggregatorAddress(WETH, USD)
    await r.setEthUsdBridge(aggregator, maxStalenessSeconds)
  }

  const configureRouterTokenUsd = async (
    r: OracleRouter,
    token: string,
    maxStalenessSeconds: number,
    isActive = true
  ) => {
    const aggregator = await readAggregatorAddress(token, USD)
    const tokenDecimals = await readTokenDecimals(token)
    await r.setTokenUsdFeed(token, aggregator, maxStalenessSeconds, tokenDecimals, isActive)
  }

  const configureRouterTokenEth = async (
    r: OracleRouter,
    token: string,
    maxStalenessSeconds: number,
    isActive = true
  ) => {
    const aggregator = await readAggregatorAddress(token, WETH)
    const tokenDecimals = await readTokenDecimals(token)
    await r.setTokenEthFeed(token, aggregator, maxStalenessSeconds, tokenDecimals, isActive)
  }

  before(async () => {
    snapshot = await takeSnapshot()
    factory = await ethers.getContractFactory('AmountConverter')

    router = await deployAndConfigureOracleRouter({
      feedRegistry: addresses.CHAINLINK_PRICE_FEED_REGISTRY,
      tokensUsd: [addresses.STETH, addresses.DAI, addresses.USDC, addresses.USDT],
    })
    routerAddress = await router.getAddress()

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
      const [deployer] = await ethers.getSigners()
      const bridgeRouter = await deployAndConfigureOracleRouter({
        feedRegistry: FEED_REGISTRY,
        tokensUsd: [addresses.DAI],
        tokensEth: [addresses.STETH],
      })

      const bridgeConverter = await factory.deploy(
        await bridgeRouter.getAddress(),
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

      // Independent compute via the router
      const [stethUsdPrice, daiUsdPrice] = await bridgeRouter.getUsdPrices(
        addresses.STETH,
        addresses.DAI
      )
      const [sellDecimals, buyDecimals] = await bridgeRouter.getTokenDecimals(
        addresses.STETH,
        addresses.DAI
      )

      const raw = (amountToSell * stethUsdPrice) / daiUsdPrice
      const expected =
        sellDecimals >= buyDecimals
          ? raw / 10n ** BigInt(sellDecimals - buyDecimals)
          : raw * 10n ** BigInt(buyDecimals - sellDecimals)

      expect(amountFromContract.toString()).to.equal(expected.toString())
    })

    it('bubbles router staleness (OracleStale) on outdated feed', async () => {
      const [deployer] = await ethers.getSigners()
      const staleRouter = await deployAndConfigureOracleRouter({
        feedRegistry: FEED_REGISTRY,
        tokensUsd: [addresses.DAI, addresses.USDC],
      })
      // Overwrite DAI staleness to 1s to simulate staleness
      // Reconfigure only DAI with tight window
      const registryInterface = new ethers.Interface([
        'function getFeed(address,address) view returns (address)',
      ])
      const registry = new ethers.Contract(
        FEED_REGISTRY,
        registryInterface,
        (await ethers.getSigners())[0]
      )
      const getFeed = (base: string, quote: string) =>
        registry.getFunction('getFeed').staticCall(base, quote)
      const tokenInterface = new ethers.Interface(['function decimals() view returns (uint8)'])
      const erc20 = new ethers.Contract(
        addresses.DAI,
        tokenInterface,
        (await ethers.getSigners())[0]
      )
      const decimals = await erc20.getFunction('decimals').staticCall()
      await staleRouter.setTokenUsdFeed(addresses.DAI, ethers.ZeroAddress, 1, decimals, true)

      const staleConverter = await factory.deploy(
        await staleRouter.getAddress(),
        [addresses.DAI, addresses.USDC],
        [addresses.USDC]
      )
      await staleConverter.waitForDeployment()

      // Move time forward beyond the 1-second staleness
      await time.increase(2)
      await time.latestBlock()

      await expect(
        staleConverter.getExpectedOut(addresses.DAI, addresses.USDC, ethers.parseEther('1'))
      ).to.be.revertedWithCustomError(staleRouter, 'OracleStale')
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
  })
})
