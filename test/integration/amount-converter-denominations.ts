import { ethers } from 'hardhat'
import { expect } from 'chai'
import { parseEther } from 'ethers'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import type { AmountConverter, AmountConverterFactory, OracleRouter } from '../../typechain-types'
import { getContracts } from '../../utils/contracts'
import {
  getAllTestTokens,
  refreshTestFeedData,
  resetTestFeedRegistryStub,
} from '../../utils/test-feed-registry'
import { getTestOracleRouter, resetTestOracleRouter } from '../../utils/test-oracle-router'
import { QuoteDenomination } from '../../utils/oracle-router'

const contracts = getContracts()

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

type QuoteValue = (typeof QuoteDenomination)[keyof typeof QuoteDenomination]

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

describe('Integration: AmountConverter Denominations', () => {
  let router: OracleRouter
  let factory: AmountConverterFactory
  let snapshot: SnapshotRestorer

  before(async () => {
    snapshot = await takeSnapshot()

    router = await getTestOracleRouter({
      tokens: getAllTestTokens(),
      useRealPrices: true,
    })

    await refreshTestFeedData(getAllTestTokens())

    await router.setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86400, true)
    await router.setTokenFeed(contracts.LDO, QuoteDenomination.ETH, 86400, true)

    const factoryContract = await ethers.getContractFactory('AmountConverterFactory')
    factory = await factoryContract.deploy(await router.getAddress())
    await factory.waitForDeployment()
  })

  after(async () => {
    await snapshot.restore()
    resetTestOracleRouter()
    resetTestFeedRegistryStub()
  })

  describe('ETH-quoted to ETH-quoted with ETH mode', () => {
    let converter: AmountConverter

    beforeEach(async () => {
      const tx = await factory.deployAmountConverter([contracts.STETH], [contracts.LDO], true)
      const receipt = await tx.wait()
      const event = receipt?.logs.find((log: any) => {
        try {
          return factory.interface.parseLog(log)?.name === 'AmountConverterDeployed'
        } catch {
          return false
        }
      })
      const converterAddress = factory.interface.parseLog(event as any)?.args[0]
      converter = await ethers.getContractAt('AmountConverter', converterAddress)
    })

    it('should convert stETH to LDO', async () => {
      const amount = parseEther('10')
      const result = await converter.getExpectedOut(contracts.STETH, contracts.LDO, amount)

      const [basePrice, quotePrice] = await router.getPricesAndDecimals(
        contracts.STETH,
        contracts.LDO,
        1
      )
      const manualCalc = (amount * basePrice) / quotePrice

      expect(result).to.equal(manualCalc)
    })

    it('should handle small conversions', async () => {
      const amount = parseEther('0.1')
      const result = await converter.getExpectedOut(contracts.STETH, contracts.LDO, amount)

      // Verify using router directly
      const [basePrice, quotePrice] = await router.getPricesAndDecimals(
        contracts.STETH,
        contracts.LDO,
        1
      )
      const manualCalc = (amount * basePrice) / quotePrice
      expect(result).to.equal(manualCalc)
    })

    it('should produce consistent results for multiple conversions', async () => {
      const amount = parseEther('1')
      const result1 = await converter.getExpectedOut(contracts.STETH, contracts.LDO, amount)
      const result2 = await converter.getExpectedOut(contracts.STETH, contracts.LDO, amount)

      // Same input should always produce same output
      expect(result1).to.equal(result2)
    })
  })

  describe('ETH-quoted to USD-quoted with USD mode', () => {
    let converter: AmountConverter

    beforeEach(async () => {
      // Reconfigure STETH as USD-quoted for mixed denomination tests
      // This uses the ETH/USD bridge internally
      await router.setTokenFeed(contracts.STETH, QuoteDenomination.USD, 86400, true)
      await router.setEthUsdBridge(86400)

      const tx = await factory.deployAmountConverter(
        [contracts.STETH],
        [contracts.DAI, contracts.USDC, contracts.USDT],
        false // USD mode (required for mixed denominations)
      )
      const receipt = await tx.wait()
      const event = receipt?.logs.find((log: any) => {
        try {
          return factory.interface.parseLog(log)?.name === 'AmountConverterDeployed'
        } catch {
          return false
        }
      })
      const converterAddress = factory.interface.parseLog(event as any)?.args[0]
      converter = await ethers.getContractAt('AmountConverter', converterAddress)
    })

    it('should convert stETH → DAI using USD prices', async () => {
      const amount = parseEther('1')
      const result = await converter.getExpectedOut(contracts.STETH, contracts.DAI, amount)

      const expected = await getExpectedOutFromRouter(
        router,
        contracts.STETH,
        contracts.DAI,
        amount,
        QuoteDenomination.USD
      )

      expect(result).to.equal(expected)
    })

    it('should convert stETH → USDC (6 decimals) using USD prices', async () => {
      const amount = parseEther('1')
      const result = await converter.getExpectedOut(contracts.STETH, contracts.USDC, amount)

      const expected = await getExpectedOutFromRouter(
        router,
        contracts.STETH,
        contracts.USDC,
        amount,
        QuoteDenomination.USD
      )

      expect(result).to.equal(expected)
    })

    it('should convert stETH → USDT (6 decimals) correctly', async () => {
      const amount = parseEther('1')
      const result = await converter.getExpectedOut(contracts.STETH, contracts.USDT, amount)

      const expected = await getExpectedOutFromRouter(
        router,
        contracts.STETH,
        contracts.USDT,
        amount,
        QuoteDenomination.USD
      )

      expect(result).to.equal(expected)
    })

    it('should handle precision differences between stETH (18) and USDC (6)', async () => {
      const amount = parseEther('1.123456789123456789')
      const result = await converter.getExpectedOut(contracts.STETH, contracts.USDC, amount)

      const expected = await getExpectedOutFromRouter(
        router,
        contracts.STETH,
        contracts.USDC,
        amount,
        QuoteDenomination.USD
      )

      expect(result).to.equal(expected)
    })
  })
})
