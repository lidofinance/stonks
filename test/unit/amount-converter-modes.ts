import { ethers } from 'hardhat'
import { expect } from 'chai'
import { parseEther, parseUnits } from 'ethers'
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

describe('AmountConverter - ETH/USD Modes', () => {
  let router: OracleRouter
  let factory: any
  let snapshot: SnapshotRestorer

  before(async () => {
    snapshot = await takeSnapshot()

    router = await getTestOracleRouter({
      tokens: getAllTestTokens(),
      useRealPrices: true,
    })

    await refreshTestFeedData(getAllTestTokens())

    await router.setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86400, 18, true)
    await router.setTokenFeed(contracts.LDO, QuoteDenomination.ETH, 86400, 18, true)

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

        expect(result).to.be.gt(0)

        const [basePrice, quotePrice] = await router.getPricesAndDecimals(
          contracts.STETH,
          contracts.LDO,
          1
        )
        const manualCalc = (amount * basePrice) / quotePrice

        expect(result).to.be.closeTo(manualCalc, 2n)
      })

      it('should scale proportionally with amount', async () => {
        const amount1 = parseEther('0.5')
        const amount2 = parseEther('1')
        const result1 = await ethConverter.getExpectedOut(contracts.STETH, contracts.LDO, amount1)
        const result2 = await ethConverter.getExpectedOut(contracts.STETH, contracts.LDO, amount2)

        expect(result1).to.be.gt(0)
        expect(result2).to.be.gt(0)
        expect(result2).to.be.closeTo(result1 * 2n, 2n)
      })

      it('should handle small amounts', async () => {
        const amount = parseEther('0.001')
        const result = await ethConverter.getExpectedOut(contracts.STETH, contracts.LDO, amount)

        expect(result).to.be.gt(0)
      })

      it('should handle large amounts', async () => {
        const amount = parseEther('1000')
        const result = await ethConverter.getExpectedOut(contracts.STETH, contracts.LDO, amount)

        expect(result).to.be.gt(0)
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

      it('should revert at oracle level for misconfigured converter', async () => {
        const badConverter = await factory.deploy(
          await router.getAddress(),
          [contracts.STETH],
          [contracts.DAI],
          true
        )
        await badConverter.waitForDeployment()

        const amount = parseEther('1')

        await expect(badConverter.getExpectedOut(contracts.STETH, contracts.DAI, amount))
          .to.be.revertedWithCustomError(router, 'TokenNotEthQuoted')
          .withArgs(contracts.DAI)
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

        expect(result).to.be.gt(0)
        expect(result).to.be.closeTo(parseUnits('1000', 6), parseUnits('10', 6))
      })

      it('should handle large conversions', async () => {
        const amount = parseEther('100000')
        const result = await usdConverter.getExpectedOut(contracts.DAI, contracts.USDC, amount)

        expect(result).to.be.gt(0)
        expect(result).to.be.closeTo(parseUnits('100000', 6), parseUnits('1000', 6))
      })
    })

    describe('ETH-quoted tokens with USD mode', () => {
      it('should revert when selling ETH-quoted token in USD mode converter', async () => {
        const ethTokenConverter = await factory.deploy(
          await router.getAddress(),
          [contracts.STETH],
          [contracts.DAI],
          false
        )
        await ethTokenConverter.waitForDeployment()

        const amount = parseEther('1')

        await expect(ethTokenConverter.getExpectedOut(contracts.STETH, contracts.DAI, amount))
          .to.be.revertedWithCustomError(router, 'TokenNotUsdQuoted')
          .withArgs(contracts.STETH)
      })

      it('should revert when buying ETH-quoted token in USD mode converter', async () => {
        const ethTokenConverter = await factory.deploy(
          await router.getAddress(),
          [contracts.DAI],
          [contracts.STETH],
          false
        )
        await ethTokenConverter.waitForDeployment()

        const amount = parseEther('1000')

        await expect(ethTokenConverter.getExpectedOut(contracts.DAI, contracts.STETH, amount))
          .to.be.revertedWithCustomError(router, 'TokenNotUsdQuoted')
          .withArgs(contracts.STETH)
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

      expect(result).to.be.gt(0)
      expect(result).to.be.lt(parseUnits('200', 6))
    })

    it('should handle 18 to 18 decimal conversion (ETH mode)', async () => {
      await refreshTestFeedData([contracts.STETH, contracts.LDO])
      await router.setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86400, 18, true)
      await router.setTokenFeed(contracts.LDO, QuoteDenomination.ETH, 86400, 18, true)

      const ethConverter = await factory.deploy(
        await router.getAddress(),
        [contracts.STETH],
        [contracts.LDO],
        true
      )
      await ethConverter.waitForDeployment()

      const amount = parseEther('1.234567890123456789')
      const result = await ethConverter.getExpectedOut(contracts.STETH, contracts.LDO, amount)

      expect(result).to.be.gt(0)
    })
  })
})
