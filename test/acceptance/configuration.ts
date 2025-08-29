import { ethers } from 'hardhat'
import { takeSnapshot, SnapshotRestorer, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

import { AmountConverter__factory, IAmountConverter } from '../../typechain-types'
import { getContracts } from '../../utils/contracts'
import { getExpectedOut } from '../../utils/chainlink-helpers'

const addresses = getContracts()

describe('AmountConverter', () => {
  let converter: IAmountConverter
  let factory: AmountConverter__factory
  let snapshot: SnapshotRestorer

  let routerAddress: string

  const FEED_REGISTRY = addresses.CHAINLINK_PRICE_FEED_REGISTRY
  const USD = addresses.CHAINLINK_USD_QUOTE
  const WETH = addresses.WETH

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

  const configureRouterEthUsd = async (router: string, maxStalenessSeconds: number) => {
    const aggregator = await readAggregatorAddress(WETH, USD)
    const routerFactory = await ethers.getContractFactory('OracleRouter')
    const asRouter = routerFactory.attach(router)
    await asRouter.setEthUsdBridge(aggregator, maxStalenessSeconds)
  }

  const configureRouterTokenUsd = async (
    router: string,
    token: string,
    maxStalenessSeconds: number,
    isActive = true
  ) => {
    const aggregator = await readAggregatorAddress(token, USD)
    const tokenDecimals = await readTokenDecimals(token)
    const routerFactory = await ethers.getContractFactory('OracleRouter')
    const asRouter = routerFactory.attach(router)
    await asRouter.setTokenUsdFeed(token, aggregator, maxStalenessSeconds, tokenDecimals, isActive)
  }

  const configureRouterTokenEth = async (
    router: string,
    token: string,
    maxStalenessSeconds: number,
    isActive = true
  ) => {
    const aggregator = await readAggregatorAddress(token, WETH)
    const tokenDecimals = await readTokenDecimals(token)
    const routerFactory = await ethers.getContractFactory('OracleRouter')
    const asRouter = routerFactory.attach(router)
    await asRouter.setTokenEthFeed(token, aggregator, maxStalenessSeconds, tokenDecimals, isActive)
  }

  before(async () => {
    snapshot = await takeSnapshot()
    factory = await ethers.getContractFactory('AmountConverter')

    // Deploy OracleRouter (UNIT_DECIMALS = 18)
    const [deployer] = await ethers.getSigners()
    const router = await (
      await ethers.getContractFactory('OracleRouter')
    ).deploy(deployer.address, 18)
    await router.waitForDeployment()
    routerAddress = await router.getAddress()

    // Configure ETH/USD bridge
    await configureRouterEthUsd(routerAddress, 86_400) // 24 hours

    // Configure tokens on the router:
    // - stETH via TOKEN/USD (to match chainlink-helpers expectations for equality checks)
    // - DAI, USDC, USDT via TOKEN/USD
    await configureRouterTokenUsd(routerAddress, addresses.STETH, 86_400)
    await configureRouterTokenUsd(routerAddress, addresses.DAI, 86_400)
    await configureRouterTokenUsd(routerAddress, addresses.USDC, 86_400)
    await configureRouterTokenUsd(routerAddress, addresses.USDT, 86_400)

    // Deploy AmountConverter (router address + allowlists)
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
      // Deploy a dedicated router configured with stETH/ETH and DAI/USD to exercise the bridge path
      const [deployer] = await ethers.getSigners()
      const bridgeRouter = await (
        await ethers.getContractFactory('OracleRouter')
      ).deploy(deployer.address, 18)
      await bridgeRouter.waitForDeployment()
      const bridgeRouterAddress = await bridgeRouter.getAddress()

      await configureRouterEthUsd(bridgeRouterAddress, 86_400)
      await configureRouterTokenEth(bridgeRouterAddress, addresses.STETH, 86_400) // stETH/ETH
      await configureRouterTokenUsd(bridgeRouterAddress, addresses.DAI, 86_400) // DAI/USD

      const bridgeConverter = await factory.deploy(
        bridgeRouterAddress,
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

      // Independently compute via the router (no external helpers)
      const routerFactory = await ethers.getContractFactory('OracleRouter')
      const asRouter = routerFactory.attach(bridgeRouterAddress)
      const [stethUsdPrice, daiUsdPrice] = await asRouter.getUsdPrices(
        addresses.STETH,
        addresses.DAI
      )
      const [sellDecimals, buyDecimals] = await asRouter.getTokenDecimals(
        addresses.STETH,
        addresses.DAI
      )

      const raw = (amountToSell * stethUsdPrice) / daiUsdPrice
      let expected: bigint
      if (sellDecimals >= buyDecimals) {
        expected = raw / 10n ** BigInt(sellDecimals - buyDecimals)
      } else {
        expected = raw * 10n ** BigInt(buyDecimals - sellDecimals)
      }

      expect(amountFromContract.toString()).to.equal(expected.toString())
    })

    it('bubbles router staleness (OracleStale) on outdated feed', async () => {
      // New router with very tight staleness for DAI/USD to force staleness
      const [deployer] = await ethers.getSigners()
      const staleRouter = await (
        await ethers.getContractFactory('OracleRouter')
      ).deploy(deployer.address, 18)
      await staleRouter.waitForDeployment()
      const staleRouterAddress = await staleRouter.getAddress()

      await configureRouterEthUsd(staleRouterAddress, 86_400)

      // Tight staleness on DAI/USD
      const daiAggregator = await readAggregatorAddress(addresses.DAI, USD)
      const daiDecimals = await readTokenDecimals(addresses.DAI)
      const staleAsRouter = (await ethers.getContractFactory('OracleRouter')).attach(
        staleRouterAddress
      )
      await staleAsRouter.setTokenUsdFeed(addresses.DAI, daiAggregator, 1, daiDecimals, true)

      // Normal staleness on USDC/USD so only one side is tight
      await configureRouterTokenUsd(staleRouterAddress, addresses.USDC, 86_400)

      const staleConverter = await factory.deploy(
        staleRouterAddress,
        [addresses.DAI, addresses.USDC],
        [addresses.USDC]
      )
      await staleConverter.waitForDeployment()

      // Move time forward beyond the 1-second staleness
      await time.increase(2)
      await time.latestBlock()

      // Expect revert with OracleRouter's custom error
      await expect(
        staleConverter.getExpectedOut(addresses.DAI, addresses.USDC, ethers.parseEther('1'))
      ).to.be.revertedWithCustomError(staleAsRouter, 'OracleStale')
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
