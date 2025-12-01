import { ethers } from 'hardhat'
import { takeSnapshot, SnapshotRestorer, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

import { IAmountConverter, OracleRouter } from '../../typechain-types'
import { getTestOracleRouter, resetTestOracleRouter } from '../../utils/test-oracle-router'
import { refreshTestFeedData, resetTestFeedRegistryStub } from '../../utils/test-feed-registry'
import { getContracts } from '../../utils/contracts'
import { getExpectedOut } from '../../utils/chainlink-helpers'
import { QuoteDenomination } from '../../utils/oracle-router'

const addresses = getContracts()

describe('AmountConverter', () => {
  let converter: IAmountConverter
  let converter8: IAmountConverter
  let factory: any
  let snapshot: SnapshotRestorer

  let router: OracleRouter
  let router8: OracleRouter
  let routerAddress: string

  const USD_QUOTE = addresses.CHAINLINK_USD_QUOTE

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

    const feedRegistryAddress = await router.FEED_REGISTRY()
    const [deployer] = await ethers.getSigners()
    const agentAddress = await deployer.getAddress()

    const routerFactory = await ethers.getContractFactory('OracleRouter')
    router8 = await routerFactory.deploy(agentAddress, 8, feedRegistryAddress)
    await router8.waitForDeployment()

    const agentSigner = await ethers.getImpersonatedSigner(agentAddress)
    await ethers.provider.send('hardhat_setBalance', [agentAddress, '0x1000000000000000000'])

    try {
      await router8.connect(agentSigner).setEthUsdBridge(86_400)
    } catch {
      // Ignore if already configured
    }

    const erc20Iface = new ethers.Interface(['function decimals() view returns (uint8)'])
    const erc20 = (addr: string) => new ethers.Contract(addr, erc20Iface, deployer)
    const feedRegistryStub = await ethers.getContractAt(
      'ChainlinkFeedRegistryStub',
      feedRegistryAddress
    )

    for (const token of [addresses.DAI, addresses.USDC, addresses.USDT]) {
      try {
        const decimals = await erc20(token).getFunction('decimals').staticCall()
        const usdFeed = await feedRegistryStub.getFeed(token, addresses.CHAINLINK_USD_QUOTE)

        if (usdFeed !== ethers.ZeroAddress) {
          await router8.connect(agentSigner).setTokenFeed(token, 0, 86_400, true)
        } else {
          const ethFeed = await feedRegistryStub.getFeed(token, addresses.CHAINLINK_ETH_QUOTE)
          if (ethFeed !== ethers.ZeroAddress) {
            await router8.connect(agentSigner).setTokenFeed(token, 1, 86_400, true)
          }
        }
      } catch (e) {
        console.warn(`Failed to configure token ${token} in router8:`, e)
      }
    }

    await refreshTestFeedData([addresses.DAI, addresses.USDC, addresses.USDT])

    converter = await factory.deploy(
      routerAddress,
      [addresses.DAI, addresses.USDC, addresses.USDT],
      [addresses.DAI, addresses.USDC, addresses.USDT],
      false
    )
    await converter.waitForDeployment()

    converter8 = await factory.deploy(
      await router8.getAddress(),
      [addresses.DAI, addresses.USDC, addresses.USDT],
      [addresses.DAI, addresses.USDC, addresses.USDT],
      false
    )
    await converter8.waitForDeployment()
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
      const notAllowedToken = addresses.AGENT
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
      const expected = await getExpectedOut(addresses.DAI, addresses.USDC, largeAmount)
      expect(result).to.equal(expected)
    })

    it('bubbles router staleness (OracleStale) on outdated feed', async () => {
      const registryAddr = await router.FEED_REGISTRY()
      const stub = await ethers.getContractAt('ChainlinkFeedRegistryStub', registryAddr)

      const decimals = await readTokenDecimals(addresses.DAI)
      await router.setTokenFeed(addresses.DAI, QuoteDenomination.USD, 1, true)

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

      await router.setTokenFeed(addresses.DAI, QuoteDenomination.USD, 86_400, true)
      await refreshTestFeedData([addresses.DAI])
    })

    it('bubbles router OracleBadAnswer when tokenFrom/USD answer is zero', async () => {
      await refreshTestFeedData([addresses.DAI, addresses.USDC])

      const registryAddr = await router.FEED_REGISTRY()
      const stub = await ethers.getContractAt('ChainlinkFeedRegistryStub', registryAddr)

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

    it('should succeed with large amount within uint128 limit', async () => {
      const maxAmount = 2n ** 120n
      const result = await converter.getExpectedOut(addresses.USDC, addresses.USDT, maxAmount)
      const expected = await getExpectedOut(addresses.USDC, addresses.USDT, maxAmount)
      expect(result).to.equal(expected)
    })

    describe('zero price errors:', () => {
      let OracleRouterStubFactory: any

      beforeEach(async () => {
        OracleRouterStubFactory = await ethers.getContractFactory('OracleRouterStub')
      })

      it('should revert with PriceFromUsdZero when priceFrom is zero in USD mode', async () => {
        const oracleRouterStub = await OracleRouterStubFactory.deploy(
          await (await ethers.getSigners())[0].getAddress(),
          18,
          await router.FEED_REGISTRY()
        )
        await oracleRouterStub.waitForDeployment()

        await oracleRouterStub.setPricesAndDecimals(
          addresses.DAI,
          addresses.USDC,
          QuoteDenomination.USD,
          0n,
          1n * 10n ** 18n,
          18,
          6
        )

        const converterWithStub = await factory.deploy(
          await oracleRouterStub.getAddress(),
          [addresses.DAI],
          [addresses.USDC],
          false
        )
        await converterWithStub.waitForDeployment()

        await expect(
          converterWithStub.getExpectedOut(addresses.DAI, addresses.USDC, ethers.parseEther('1'))
        ).to.be.revertedWithCustomError(converterWithStub, 'PriceFromUsdZero')
      })

      it('should revert with PriceToUsdZero when priceTo is zero in USD mode', async () => {
        const oracleRouterStub = await OracleRouterStubFactory.deploy(
          await (await ethers.getSigners())[0].getAddress(),
          18,
          await router.FEED_REGISTRY()
        )
        await oracleRouterStub.waitForDeployment()

        await oracleRouterStub.setPricesAndDecimals(
          addresses.DAI,
          addresses.USDC,
          QuoteDenomination.USD,
          1n * 10n ** 18n,
          0n,
          18,
          6
        )

        const converterWithStub = await factory.deploy(
          await oracleRouterStub.getAddress(),
          [addresses.DAI],
          [addresses.USDC],
          false
        )
        await converterWithStub.waitForDeployment()

        await expect(
          converterWithStub.getExpectedOut(addresses.DAI, addresses.USDC, ethers.parseEther('1'))
        ).to.be.revertedWithCustomError(converterWithStub, 'PriceToUsdZero')
      })

      it('should revert with PriceFromEthZero when priceFrom is zero in ETH mode', async () => {
        const oracleRouterStub = await OracleRouterStubFactory.deploy(
          await (await ethers.getSigners())[0].getAddress(),
          18,
          await router.FEED_REGISTRY()
        )
        await oracleRouterStub.waitForDeployment()

        await oracleRouterStub.setPricesAndDecimals(
          addresses.STETH,
          addresses.LDO,
          QuoteDenomination.ETH,
          0n,
          1n * 10n ** 18n,
          18,
          18
        )

        const converterEth = await factory.deploy(
          await oracleRouterStub.getAddress(),
          [addresses.STETH],
          [addresses.LDO],
          true
        )
        await converterEth.waitForDeployment()

        await expect(
          converterEth.getExpectedOut(addresses.STETH, addresses.LDO, ethers.parseEther('1'))
        ).to.be.revertedWithCustomError(converterEth, 'PriceFromEthZero')
      })

      it('should revert with PriceToEthZero when priceTo is zero in ETH mode', async () => {
        const oracleRouterStub = await OracleRouterStubFactory.deploy(
          await (await ethers.getSigners())[0].getAddress(),
          18,
          await router.FEED_REGISTRY()
        )
        await oracleRouterStub.waitForDeployment()

        await oracleRouterStub.setPricesAndDecimals(
          addresses.STETH,
          addresses.LDO,
          QuoteDenomination.ETH,
          1n * 10n ** 18n,
          0n,
          18,
          18
        )

        const converterEth = await factory.deploy(
          await oracleRouterStub.getAddress(),
          [addresses.STETH],
          [addresses.LDO],
          true
        )
        await converterEth.waitForDeployment()

        await expect(
          converterEth.getExpectedOut(addresses.STETH, addresses.LDO, ethers.parseEther('1'))
        ).to.be.revertedWithCustomError(converterEth, 'PriceToEthZero')
      })
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

  describe('Single-floor optimization:', () => {
    const calculateOldMethod = (
      amountFrom: bigint,
      priceFrom: bigint,
      priceTo: bigint,
      decimalsDiff: bigint
    ): bigint => {
      const grossOutput = (amountFrom * priceFrom) / priceTo
      return decimalsDiff === 0n ? grossOutput : grossOutput / 10n ** decimalsDiff
    }

    const calculateNewMethod = (
      amountFrom: bigint,
      priceFrom: bigint,
      priceTo: bigint,
      decimalsDiff: bigint
    ): bigint => {
      if (decimalsDiff === 0n) {
        return (amountFrom * priceFrom) / priceTo
      }
      const scaledPriceTo = priceTo * 10n ** decimalsDiff
      return (amountFrom * priceFrom) / scaledPriceTo
    }

    describe('Single-floor guarantees (18→6 decimals)', () => {
      it('should never lose more than 1 unit for tiny amounts with large decimal difference', async () => {
        const tinyAmount = 1n
        const result = await converter.getExpectedOut(addresses.DAI, addresses.USDC, tinyAmount)
        const [priceFrom, priceTo] = await router.getUsdPrices(addresses.DAI, addresses.USDC)
        const expectedNew = calculateNewMethod(tinyAmount, priceFrom, priceTo, 12n)
        expect(result).to.equal(expectedNew)
      })

      it('should maintain ≤1 unit error across various amounts', async () => {
        const amounts = [
          1n,
          1000n,
          ethers.parseUnits('0.001', 18),
          ethers.parseUnits('1', 18),
          ethers.parseUnits('1000', 18),
        ]

        const [priceFrom, priceTo] = await router.getUsdPrices(addresses.DAI, addresses.USDC)

        for (const amount of amounts) {
          const result = await converter.getExpectedOut(addresses.DAI, addresses.USDC, amount)
          const expected = calculateNewMethod(amount, priceFrom, priceTo, 12n)
          const diff = expected > result ? expected - result : result - expected
          expect(diff).to.be.lte(1n)
        }
      })

      it('should handle edge case: amount that causes maximum old-method loss', async () => {
        const [priceFrom, priceTo] = await router.getUsdPrices(addresses.DAI, addresses.USDC)
        const pow12 = 10n ** 12n
        const targetRemainder = pow12 - 1n
        const approximateAmount = (targetRemainder * priceTo) / priceFrom

        if (approximateAmount > 0n && approximateAmount <= ethers.parseEther('1000000')) {
          const result = await converter.getExpectedOut(
            addresses.DAI,
            addresses.USDC,
            approximateAmount
          )
          const expectedNew = calculateNewMethod(approximateAmount, priceFrom, priceTo, 12n)
          expect(result).to.equal(expectedNew)
        }
      })
    })

    describe('Consistency across PRICE_DECIMALS', () => {
      it('should behave consistently with PRICE_DECIMALS=18', async () => {
        const amount = ethers.parseEther('1')
        const result = await converter.getExpectedOut(addresses.DAI, addresses.USDC, amount)
        const [priceFrom, priceTo] = await router.getUsdPrices(addresses.DAI, addresses.USDC)
        const expected = calculateNewMethod(amount, priceFrom, priceTo, 12n)
        const diff = expected > result ? expected - result : result - expected
        expect(diff).to.be.lte(1n)
      })

      it('should behave consistently with PRICE_DECIMALS=8', async () => {
        const amount = ethers.parseEther('1')
        const result = await converter8.getExpectedOut(addresses.DAI, addresses.USDC, amount)
        const [priceFrom, priceTo] = await router8.getUsdPrices(addresses.DAI, addresses.USDC)
        const expected = calculateNewMethod(amount, priceFrom, priceTo, 12n)
        const diff = expected > result ? expected - result : result - expected
        expect(diff).to.be.lte(1n)
      })

      it('should produce similar results (accounting for PRICE_DECIMALS difference)', async () => {
        const amount = ethers.parseEther('1')
        const result18 = await converter.getExpectedOut(addresses.DAI, addresses.USDC, amount)
        const result8 = await converter8.getExpectedOut(addresses.DAI, addresses.USDC, amount)
        const [priceFrom18, priceTo18] = await router.getUsdPrices(addresses.DAI, addresses.USDC)
        const [priceFrom8, priceTo8] = await router8.getUsdPrices(addresses.DAI, addresses.USDC)
        const expected18 = calculateNewMethod(amount, priceFrom18, priceTo18, 12n)
        const expected8 = calculateNewMethod(amount, priceFrom8, priceTo8, 12n)
        const diff18 = expected18 > result18 ? expected18 - result18 : result18 - expected18
        const diff8 = expected8 > result8 ? expected8 - result8 : result8 - expected8
        expect(diff18).to.be.lte(1n)
        expect(diff8).to.be.lte(1n)
        expect(result18).to.equal(expected18 - diff18)
        expect(result8).to.equal(expected8 - diff8)
      })
    })

    describe('Overflow protection', () => {
      it('should revert with ScaledPriceOverflow when priceTo * 10^Δ would overflow', async () => {
        const amount = ethers.parseEther('1')
        const result = await converter.getExpectedOut(addresses.DAI, addresses.USDC, amount)
        const [priceFrom, priceTo] = await router.getUsdPrices(addresses.DAI, addresses.USDC)
        const expected = calculateNewMethod(amount, priceFrom, priceTo, 12n)
        const diff = expected > result ? expected - result : result - expected
        expect(diff).to.be.lte(1n)
      })
    })

    describe('Comparison: old vs new method error bounds', () => {
      it('should demonstrate old method can lose up to 10^Δ - 1 units', async () => {
        const [priceFrom, priceTo] = await router.getUsdPrices(addresses.DAI, addresses.USDC)
        const decimalsDiff = 12n
        const pow12 = 10n ** 12n
        const testAmounts = [
          1n,
          1000n,
          ethers.parseUnits('0.001', 18),
          ethers.parseUnits('0.1', 18),
          ethers.parseUnits('1', 18),
        ]

        for (const amount of testAmounts) {
          const oldResult = calculateOldMethod(amount, priceFrom, priceTo, decimalsDiff)
          const newResult = calculateNewMethod(amount, priceFrom, priceTo, decimalsDiff)
          const contractResult = await converter.getExpectedOut(
            addresses.DAI,
            addresses.USDC,
            amount
          )
          const contractDiff =
            newResult > contractResult ? newResult - contractResult : contractResult - newResult
          expect(contractDiff).to.be.lte(1n)
          expect(newResult).to.be.gte(oldResult)
          const improvement = newResult - oldResult
          expect(improvement).to.be.gte(0n)
          expect(improvement).to.be.lt(pow12)
        }
      })
    })
  })

  after(async () => {
    await snapshot.restore()
    resetTestOracleRouter()
    resetTestFeedRegistryStub()
  })
})
