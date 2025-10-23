import { ethers } from 'hardhat'
import { expect } from 'chai'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import fc from 'fast-check'
import { AmountConverterTest } from '../../typechain-types'
import { getTestOracleRouter, resetTestOracleRouter } from '../../utils/test-oracle-router'
import { refreshTestFeedData } from '../../utils/test-feed-registry'
import { getContracts } from '../../utils/contracts'

const addresses = getContracts()

describe('AmountConverter - Fuzz Tests', () => {
  let converter: AmountConverterTest
  let snapshot: SnapshotRestorer

  before(async () => {
    snapshot = await takeSnapshot()

    const router = await getTestOracleRouter({
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

  describe('Decimal scaling invariants', () => {
    it('should never overflow for valid uint128 amounts', async () => {
      await fc.assert(
        fc.asyncProperty(fc.bigInt({ min: 1n, max: 2n ** 128n - 1n }), async (amount) => {
          const result = await converter.getExpectedOut(addresses.STETH, addresses.DAI, amount)
          expect(result).to.be.gte(0)
        }),
        { numRuns: 20 }
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

            const expected = result1 * 2n
            const diff = result2 > expected ? result2 - expected : expected - result2
            expect(diff).to.be.lte(2n)
          }
        ),
        { numRuns: 20 }
      )
    })

    it('should handle cross-decimal conversions (18→6)', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: ethers.parseUnits('1', 6), max: ethers.parseEther('100') }),
          async (amount) => {
            const stethToUsdc = await converter.getExpectedOut(
              addresses.STETH,
              addresses.USDC,
              amount
            )
            expect(stethToUsdc).to.be.lte(amount / 10n ** 11n)
          }
        ),
        { numRuns: 20 }
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
            const result1 = await converter.getExpectedOut(addresses.STETH, addresses.DAI, amount1)
            const result2 = await converter.getExpectedOut(addresses.STETH, addresses.DAI, amount2)

            if (result1 === 0n || result2 === 0n) return true

            const ratio1 = (result1 * 10000n) / amount1
            const ratio2 = (result2 * 10000n) / amount2
            const diff = ratio1 > ratio2 ? ratio1 - ratio2 : ratio2 - ratio1
            expect(diff).to.be.lte((ratio1 + ratio2) / 200n)
          }
        ),
        { numRuns: 20 }
      )
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
        { numRuns: 5 }
      )
    })
  })

  after(async () => {
    await snapshot.restore()
    resetTestOracleRouter()
  })
})
