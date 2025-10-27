import { ethers } from 'hardhat'
import { expect } from 'chai'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import fc from 'fast-check'
import { AmountConverterTest, OracleRouter } from '../../typechain-types'
import { getTestOracleRouter, resetTestOracleRouter } from '../../utils/test-oracle-router'
import { refreshTestFeedData, resetTestFeedRegistryStub } from '../../utils/test-feed-registry'
import { getContracts } from '../../utils/contracts'

const addresses = getContracts()

describe('AmountConverter - Fuzz Tests', () => {
  let converter: AmountConverterTest
  let snapshot: SnapshotRestorer
  let router: OracleRouter

  before(async () => {
    snapshot = await takeSnapshot()

    router = await getTestOracleRouter({
      tokens: [addresses.STETH, addresses.DAI, addresses.USDC],
      useRealPrices: true,
    })

    await refreshTestFeedData([addresses.STETH, addresses.DAI, addresses.USDC])

    const factory = await ethers.getContractFactory('AmountConverterTest')
    converter = await factory.deploy(
      await router.getAddress(),
      [addresses.STETH, addresses.DAI, addresses.USDC],
      [addresses.DAI, addresses.USDC]
    )
    await converter.waitForDeployment()
  })

  beforeEach(async () => {
    await refreshTestFeedData([addresses.STETH, addresses.DAI, addresses.USDC])
  })

  describe('Decimal scaling invariants', () => {
    let routerAddress: string
    let priceFromUsd: bigint
    let priceToUsd: bigint
    let decimalsFrom: bigint
    let decimalsTo: bigint

    before(async () => {
      routerAddress = await router.getAddress()
      const [priceFromUsd_, priceToUsd_, decimalsFrom_, decimalsTo_] =
        await router.getPricesAndDecimals(addresses.STETH, addresses.USDC)
      priceFromUsd = priceFromUsd_
      priceToUsd = priceToUsd_
      decimalsFrom = decimalsFrom_
      decimalsTo = decimalsTo_
    })
    it('should never overflow for valid uint128 amounts', async () => {
      await fc.assert(
        fc.asyncProperty(fc.bigInt({ min: 1n, max: 2n ** 128n - 1n }), async (amount) => {
          const result = await converter.getExpectedOut(addresses.STETH, addresses.DAI, amount)
          expect(result).to.be.gte(0)
        }),
        { numRuns: 50 }
      )
    })

    it('should maintain proportionality: 2x input ≈ 2x output', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 1000n, max: ethers.parseEther('1000') }),
          async (amount) => {
            const result1 = await converter.getExpectedOut(addresses.STETH, addresses.DAI, amount)
            const result2 = await converter.getExpectedOut(
              addresses.STETH,
              addresses.DAI,
              amount * 2n
            )

            // Compute expected independently to avoid compounding rounding
            const [priceFromUsd, priceToUsd] = await router.getUsdPrices(
              addresses.STETH,
              addresses.DAI
            )
            const expected1 = (amount * priceFromUsd) / priceToUsd
            const expected2 = (amount * 2n * priceFromUsd) / priceToUsd
            // Check both independently to avoid compounding rounding errors
            expect(result1).to.equal(expected1)
            expect(result2).to.equal(expected2)
          }
        ),
        { numRuns: 100 }
      )
    })

    it('should handle cross-decimal conversions (18→6) with quantization boundary', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: ethers.parseUnits('1', 6), max: ethers.parseEther('100') }),
          async (amount) => {
            // Calculate expected output using the exact AmountConverter logic
            const decimalsDiff = decimalsFrom - decimalsTo // 18 - 6 = 12
            const grossOutput = (amount * priceFromUsd) / priceToUsd
            const expectedOutput = grossOutput / 10n ** BigInt(decimalsDiff)

            // Guard against scenarios that would cause zero output
            // This happens when grossOutput < 10^decimalsDiff
            const minGrossOutputForNonZero = 10n ** BigInt(decimalsDiff)
            if (grossOutput < minGrossOutputForNonZero) {
              return true // Skip this scenario - it would result in zero
            }

            const actualOutput = await converter.getExpectedOut(
              addresses.STETH,
              addresses.USDC,
              amount
            )

            // The actual output should exactly match the expected calculation
            expect(actualOutput).to.equal(
              expectedOutput,
              `Expected: ${expectedOutput}, Got: ${actualOutput}, Amount: ${amount}, GrossOutput: ${grossOutput}`
            )
          }
        ),
        { numRuns: 100 }
      )
    })

    it('should maintain consistent price ratio', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.tuple(
            fc.bigInt({ min: ethers.parseEther('1'), max: ethers.parseEther('10') }),
            fc.bigInt({ min: ethers.parseEther('1'), max: ethers.parseEther('10') })
          ),
          async ([amount1, amount2]) => {
            const [priceFromUsd, priceToUsd, decimalsFrom, decimalsTo] =
              await router.getPricesAndDecimals(addresses.STETH, addresses.DAI)

            // Calculate expected outputs using the exact AmountConverter logic
            const decimalsDiff =
              decimalsFrom >= decimalsTo ? decimalsFrom - decimalsTo : decimalsTo - decimalsFrom
            const sellHasMoreOrEqualDecimals = decimalsFrom >= decimalsTo

            let expected1: bigint, expected2: bigint

            if (sellHasMoreOrEqualDecimals) {
              const grossOutput1 = (amount1 * priceFromUsd) / priceToUsd
              const grossOutput2 = (amount2 * priceFromUsd) / priceToUsd
              expected1 =
                decimalsDiff === 0n ? grossOutput1 : grossOutput1 / 10n ** BigInt(decimalsDiff)
              expected2 =
                decimalsDiff === 0n ? grossOutput2 : grossOutput2 / 10n ** BigInt(decimalsDiff)
            } else {
              const pow10 = 10n ** BigInt(decimalsDiff)
              const scaledAmount1 = amount1 * pow10
              const scaledAmount2 = amount2 * pow10
              const grossOutput1 = (scaledAmount1 * priceFromUsd) / priceToUsd
              const grossOutput2 = (scaledAmount2 * priceFromUsd) / priceToUsd
              expected1 = grossOutput1
              expected2 = grossOutput2
            }

            // Guard against scenarios that would cause zero output
            if (expected1 === 0n || expected2 === 0n) {
              return true // Skip scenarios that would result in zero
            }

            const actual1 = await converter.getExpectedOut(addresses.STETH, addresses.DAI, amount1)
            const actual2 = await converter.getExpectedOut(addresses.STETH, addresses.DAI, amount2)

            // Both actual results should exactly match their expected calculations
            expect(actual1).to.equal(expected1, `Amount1: Expected ${expected1}, Got ${actual1}`)
            expect(actual2).to.equal(expected2, `Amount2: Expected ${expected2}, Got ${actual2}`)

            // The price ratios should be identical (no tolerance needed for exact calculations)
            const ratio1 = (actual1 * 10000n) / amount1
            const ratio2 = (actual2 * 10000n) / amount2
            expect(ratio1).to.equal(ratio2, 'Price ratios should be identical for same token pair')
          }
        ),
        { numRuns: 100 }
      )
    })
  })

  describe('Reversibility and boundary quantization', () => {
    it('USDC -> DAI -> USDC should not increase amount (with rounding down)', async () => {
      await fc.assert(
        fc.asyncProperty(
          // USDC has 6 decimals; keep amounts in realistic range in 6-dec units
          fc.bigInt({ min: 10n, max: ethers.parseUnits('1000000', 6) }),
          async (amount) => {
            const outToDai = await converter.getExpectedOut(addresses.USDC, addresses.DAI, amount)
            if (outToDai === 0n) return true
            const backToSteth = await converter.getExpectedOut(
              addresses.DAI,
              addresses.USDC,
              outToDai
            )
            expect(backToSteth).to.be.lte(amount)
          }
        ),
        { numRuns: 100 }
      )
    })

    it('quantization boundary: smallest amount that yields non-zero for 18->6', async () => {
      const [priceFromUsd, priceToUsd] = await router.getUsdPrices(addresses.STETH, addresses.USDC)
      const decimalsDiff = 18n - 6n
      const minGrossOutput = 10n ** decimalsDiff
      // Find minimal amount where (amount * pf) / pt >= 10^diff
      const amount = (minGrossOutput * priceToUsd + (priceFromUsd - 1n)) / priceFromUsd
      const output = await converter.getExpectedOut(addresses.STETH, addresses.USDC, amount)
      expect(output).to.be.gte(1n)
      const outputAtBoundary = await converter.getExpectedOut(
        addresses.STETH,
        addresses.USDC,
        amount - 1n
      )
      expect(outputAtBoundary).to.equal(0n)
    })
  })

  describe('Boundary conditions', () => {
    it('should handle minimum amounts', async () => {
      const result = await converter.getExpectedOut(addresses.STETH, addresses.DAI, 1n)
      expect(result).to.be.gte(0)
    })

    it('should handle amounts near uint128 max', async () => {
      await fc.assert(
        fc.asyncProperty(fc.bigInt({ min: 2n ** 127n, max: 2n ** 128n - 1n }), async (amount) => {
          const result = await converter.getExpectedOut(addresses.STETH, addresses.DAI, amount)
          expect(result).to.be.gte(0)
        }),
        { numRuns: 20 }
      )
    })
  })

  after(async () => {
    await snapshot.restore()
    resetTestOracleRouter()
    resetTestFeedRegistryStub()
  })
})
