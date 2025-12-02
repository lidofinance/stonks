import { ethers } from 'hardhat'
import { expect } from 'chai'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import fc from 'fast-check'
import { AmountConverterTest, OracleRouter } from '../../typechain-types'
import { getTestOracleRouter, resetTestOracleRouter } from '../../utils/test-oracle-router'
import { refreshTestFeedData, resetTestFeedRegistryStub } from '../../utils/test-feed-registry'
import { getContracts } from '../../utils/contracts'
import { QuoteDenomination } from '../../utils/oracle-router'

const addresses = getContracts()

describe('AmountConverter - Fuzz Tests', () => {
  let snapshot: SnapshotRestorer
  let router: OracleRouter
  let adminAddress: string

  const getAdminSigner = async () => {
    const adminSigner = await ethers.getImpersonatedSigner(adminAddress)
    await ethers.provider.send('hardhat_setBalance', [adminAddress, '0x1000000000000000000'])
    return adminSigner
  }

  before(async () => {
    snapshot = await takeSnapshot()

    router = await getTestOracleRouter({
      tokens: [addresses.STETH, addresses.LDO, addresses.DAI, addresses.USDC],
      useRealPrices: true,
    })

    adminAddress = await router.ADMIN()

    await refreshTestFeedData([addresses.STETH, addresses.LDO, addresses.DAI, addresses.USDC])

    const admin = await getAdminSigner()
    await router
      .connect(admin)
      .setTokenFeed(addresses.STETH, QuoteDenomination.ETH, 86400, true)
    await router.connect(admin).setTokenFeed(addresses.LDO, QuoteDenomination.ETH, 86400, true)
  })

  beforeEach(async () => {
    await refreshTestFeedData([addresses.STETH, addresses.LDO, addresses.DAI, addresses.USDC])
  })

  const testConfigs = [
    {
      mode: 'USD-anchored',
      useEthAnchor: false,
      tokenFrom: addresses.DAI,
      tokenTo: addresses.USDC,
      tokenAlt: addresses.DAI,
      getPrices: async (from: string, to: string) =>
        router.getPricesAndDecimals(from, to, QuoteDenomination.USD),
    },
    {
      mode: 'ETH-anchored',
      useEthAnchor: true,
      tokenFrom: addresses.STETH,
      tokenTo: addresses.LDO,
      tokenAlt: addresses.LDO,
      getPrices: async (from: string, to: string) =>
        router.getPricesAndDecimals(from, to, QuoteDenomination.ETH),
    },
  ]

  testConfigs.forEach(({ mode, useEthAnchor, tokenFrom, tokenTo, tokenAlt, getPrices }) => {
    describe(`${mode}`, () => {
      let converter: AmountConverterTest
      let priceFromUsd: bigint
      let priceToUsd: bigint
      let decimalsFrom: bigint
      let decimalsTo: bigint

      before(async () => {
        const factory = await ethers.getContractFactory('AmountConverterTest')
        converter = await factory.deploy(
          await router.getAddress(),
          [tokenFrom, tokenTo, tokenAlt],
          [tokenFrom, tokenTo, tokenAlt],
          useEthAnchor
        )
        await converter.waitForDeployment()

        const [priceFrom_, priceTo_, decimalsFrom_, decimalsTo_] = await getPrices(
          tokenFrom,
          tokenTo
        )
        priceFromUsd = priceFrom_
        priceToUsd = priceTo_
        decimalsFrom = decimalsFrom_
        decimalsTo = decimalsTo_
      })

      const calculateExpectedOut = (amount: bigint): bigint => {
        const decimalsDiff =
          decimalsFrom >= decimalsTo ? decimalsFrom - decimalsTo : decimalsTo - decimalsFrom

        if (decimalsFrom >= decimalsTo) {
          const grossOutput = (amount * priceFromUsd) / priceToUsd
          return decimalsDiff === 0n ? grossOutput : grossOutput / 10n ** decimalsDiff
        } else {
          const pow10 = 10n ** decimalsDiff
          const scaledAmount = amount * pow10
          return (scaledAmount * priceFromUsd) / priceToUsd
        }
      }

      describe('Decimal scaling invariants', () => {
        it('should never overflow for valid uint128 amounts', async () => {
          await fc.assert(
            fc.asyncProperty(fc.bigInt({ min: 1n, max: 2n ** 128n - 1n }), async (amount) => {
              const result = await converter.getExpectedOut(tokenFrom, tokenTo, amount)
              const expected = calculateExpectedOut(amount)
              expect(result).to.equal(expected)
            }),
            { numRuns: 50 }
          )
        })

        it('should maintain proportionality: 2x input ≈ 2x output', async () => {
          // Use higher minimum for USD mode to avoid rounding to 0 with 18→6 decimal conversions
          const minAmount = useEthAnchor ? 1000n : ethers.parseEther('0.01') // 0.01 DAI minimum
          await fc.assert(
            fc.asyncProperty(
              fc.bigInt({ min: minAmount, max: ethers.parseEther('1000') }),
              async (amount) => {
                const result1 = await converter.getExpectedOut(tokenFrom, tokenTo, amount)
                const result2 = await converter.getExpectedOut(tokenFrom, tokenTo, amount * 2n)

                if (result1 === 0n) return // Skip if amount too small to convert

                // Verify proportionality: 2x input should yield approximately 2x output
                // Allow small rounding differences due to integer division
                const tolerance = result1 / 1000n // 0.1% tolerance
                const expected2 = result1 * 2n
                const diff = result2 > expected2 ? result2 - expected2 : expected2 - result2
                expect(diff).to.be.lte(tolerance)
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
                const [priceFrom, priceTo, decimalsFrom, decimalsTo] = await getPrices(
                  tokenFrom,
                  tokenTo
                )

                const decimalsDiff =
                  decimalsFrom >= decimalsTo ? decimalsFrom - decimalsTo : decimalsTo - decimalsFrom
                const sellHasMoreOrEqualDecimals = decimalsFrom >= decimalsTo

                let expected1: bigint, expected2: bigint

                if (sellHasMoreOrEqualDecimals) {
                  const grossOutput1 = (amount1 * priceFrom) / priceTo
                  const grossOutput2 = (amount2 * priceFrom) / priceTo
                  expected1 =
                    decimalsDiff === 0n ? grossOutput1 : grossOutput1 / 10n ** BigInt(decimalsDiff)
                  expected2 =
                    decimalsDiff === 0n ? grossOutput2 : grossOutput2 / 10n ** BigInt(decimalsDiff)
                } else {
                  const pow10 = 10n ** BigInt(decimalsDiff)
                  const scaledAmount1 = amount1 * pow10
                  const scaledAmount2 = amount2 * pow10
                  const grossOutput1 = (scaledAmount1 * priceFrom) / priceTo
                  const grossOutput2 = (scaledAmount2 * priceFrom) / priceTo
                  expected1 = grossOutput1
                  expected2 = grossOutput2
                }

                if (expected1 === 0n || expected2 === 0n) {
                  return true
                }

                const actual1 = await converter.getExpectedOut(tokenFrom, tokenTo, amount1)
                const actual2 = await converter.getExpectedOut(tokenFrom, tokenTo, amount2)

                expect(actual1).to.equal(
                  expected1,
                  `Amount1: Expected ${expected1}, Got ${actual1}`
                )
                expect(actual2).to.equal(
                  expected2,
                  `Amount2: Expected ${expected2}, Got ${actual2}`
                )

                const ratio1 = (actual1 * 10000n) / amount1
                const ratio2 = (actual2 * 10000n) / amount2
                expect(ratio1).to.equal(
                  ratio2,
                  'Price ratios should be identical for same token pair'
                )
              }
            ),
            { numRuns: 100 }
          )
        })
      })

      describe('Reversibility and boundary quantization', () => {
        it('should not increase amount on round-trip conversion', async () => {
          await fc.assert(
            fc.asyncProperty(
              fc.bigInt({ min: 10n, max: ethers.parseEther('1000') }),
              async (amount) => {
                const outToTarget = await converter.getExpectedOut(tokenFrom, tokenTo, amount)
                if (outToTarget === 0n) return true
                const backToSource = await converter.getExpectedOut(tokenTo, tokenFrom, outToTarget)
                expect(backToSource).to.be.lte(amount)
              }
            ),
            { numRuns: 100 }
          )
        })

        if (decimalsFrom > decimalsTo) {
          it('quantization boundary: smallest amount that yields non-zero output', async () => {
            const decimalsDiff = decimalsFrom - decimalsTo
            const minGrossOutput = 10n ** decimalsDiff
            const amount = (minGrossOutput * priceToUsd + (priceFromUsd - 1n)) / priceFromUsd
            const output = await converter.getExpectedOut(tokenFrom, tokenAlt, amount)
            expect(output).to.be.gte(1n)
            const outputAtBoundary = await converter.getExpectedOut(
              tokenFrom,
              tokenAlt,
              amount - 1n
            )
            expect(outputAtBoundary).to.equal(0n)
          })
        }
      })

      describe('Boundary conditions', () => {
        it('should handle minimum amounts', async () => {
          const amount = 1n
          const result = await converter.getExpectedOut(tokenFrom, tokenTo, amount)
          const expected = calculateExpectedOut(amount)
          expect(result).to.equal(expected)
        })

        it('should handle amounts near uint128 max', async () => {
          await fc.assert(
            fc.asyncProperty(
              fc.bigInt({ min: 2n ** 127n, max: 2n ** 128n - 1n }),
              async (amount) => {
                const result = await converter.getExpectedOut(tokenFrom, tokenTo, amount)
                const expected = calculateExpectedOut(amount)
                expect(result).to.equal(expected)
              }
            ),
            { numRuns: 20 }
          )
        })
      })
    })
  })

  after(async () => {
    await snapshot.restore()
    resetTestOracleRouter()
    resetTestFeedRegistryStub()
  })
})
