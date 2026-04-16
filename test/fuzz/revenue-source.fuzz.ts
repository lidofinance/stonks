import { ethers } from 'hardhat'
import { expect } from 'chai'
import { takeSnapshot, SnapshotRestorer, time } from '@nomicfoundation/hardhat-network-helpers'
import fc from 'fast-check'

import { RevenueSourceHarness } from '../../typechain-types'
import { TIME_CONSTANTS } from '../helpers/test-constants'

const ONE_DAY = BigInt(TIME_CONSTANTS.ONE_DAY_SECONDS)
const STALENESS_WINDOW_SECONDS = ONE_DAY
const FC_RUNS = 50

// Ceiling on `raw` so `raw × ONE_DAY` cannot overflow uint256.
const MAX_RAW = (2n ** 256n - 1n) / ONE_DAY
const MAX_GAP = ONE_DAY * 365n

// Structural invariants must hold across both gap regimes. Uniform sampling over [1, 365·ONE_DAY]
// would pick sub-day values in <0.3% of draws, so we explicitly sample sub-day OR multi-day 50/50.
const subDayGapArbitrary = fc.bigInt({ min: 1n, max: ONE_DAY - 1n })
const multiDayGapArbitrary = fc.bigInt({ min: ONE_DAY + 1n, max: MAX_GAP })
const gapArbitrary = fc.oneof(subDayGapArbitrary, multiDayGapArbitrary)

function expectedDaily(raw: bigint, period: bigint): bigint {
  return (raw * ONE_DAY) / period
}

describe('RevenueSource - Fuzz Tests', () => {
  let harness: RevenueSourceHarness
  let topSnapshot: SnapshotRestorer
  let baselineTs: bigint

  before(async () => {
    topSnapshot = await takeSnapshot()
    const [admin] = await ethers.getSigners()

    const factory = await ethers.getContractFactory('RevenueSourceHarness')
    harness = await factory.deploy(await admin.getAddress(), STALENESS_WINDOW_SECONDS)
    await harness.waitForDeployment()

    baselineTs = BigInt(await time.latest()) + 1_000n
  })

  after(async () => {
    await topSnapshot.restore()
  })

  describe('gap-period normalization', () => {
    it('should apply exact daily-rate formula across sub-day gaps', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 1n, max: MAX_RAW }),
          subDayGapArbitrary,
          async (raw, gapSeconds) => {
            const localSnapshot = await takeSnapshot()

            await harness.updateRevenue(1n, baselineTs)
            await harness.updateRevenue(raw, baselineTs + gapSeconds)

            const [stored] = await harness.getRevenue()
            expect(stored).to.equal(expectedDaily(raw, gapSeconds))

            await localSnapshot.restore()
          }
        ),
        { numRuns: FC_RUNS }
      )
    })

    it('should apply exact daily-rate formula across multi-day gaps', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 1n, max: MAX_RAW }),
          multiDayGapArbitrary,
          async (raw, gapSeconds) => {
            const localSnapshot = await takeSnapshot()

            await harness.updateRevenue(1n, baselineTs)
            await harness.updateRevenue(raw, baselineTs + gapSeconds)

            const [stored] = await harness.getRevenue()
            expect(stored).to.equal(expectedDaily(raw, gapSeconds))

            await localSnapshot.restore()
          }
        ),
        { numRuns: FC_RUNS }
      )
    })

    it('should store raw verbatim when the gap equals exactly one day', async () => {
      await fc.assert(
        fc.asyncProperty(fc.bigInt({ min: 0n, max: MAX_RAW }), async (raw) => {
          const localSnapshot = await takeSnapshot()

          await harness.updateRevenue(1n, baselineTs)
          await harness.updateRevenue(raw, baselineTs + ONE_DAY)

          const [stored] = await harness.getRevenue()
          expect(stored).to.equal(raw)

          await localSnapshot.restore()
        }),
        { numRuns: FC_RUNS }
      )
    })
  })

  describe('period-scaling invariants', () => {
    it('should be monotone non-increasing in gap length for fixed raw', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 1n, max: MAX_RAW }),
          gapArbitrary,
          gapArbitrary,
          async (raw, p1, p2) => {
            const [shorter, longer] = p1 <= p2 ? [p1, p2] : [p2, p1]

            const s1 = await takeSnapshot()
            await harness.updateRevenue(1n, baselineTs)
            await harness.updateRevenue(raw, baselineTs + shorter)
            const [storedShort] = await harness.getRevenue()
            await s1.restore()

            const s2 = await takeSnapshot()
            await harness.updateRevenue(1n, baselineTs)
            await harness.updateRevenue(raw, baselineTs + longer)
            const [storedLong] = await harness.getRevenue()
            await s2.restore()

            expect(storedShort).to.be.gte(storedLong)
          }
        ),
        { numRuns: FC_RUNS }
      )
    })

    it('should halve the daily rate when the gap doubles', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 1n, max: MAX_RAW }),
          gapArbitrary,
          async (raw, gapSeconds) => {
            const s1 = await takeSnapshot()
            await harness.updateRevenue(1n, baselineTs)
            await harness.updateRevenue(raw, baselineTs + gapSeconds)
            const [storedSingle] = await harness.getRevenue()
            await s1.restore()

            const s2 = await takeSnapshot()
            await harness.updateRevenue(1n, baselineTs)
            await harness.updateRevenue(raw, baselineTs + gapSeconds * 2n)
            const [storedDouble] = await harness.getRevenue()
            await s2.restore()

            // Integer-division relation: floor((raw × D) / (2p)) == floor(floor((raw × D) / p) / 2)
            // does not hold exactly, but the tight bound is |2·storedDouble − storedSingle| ≤ 1.
            const doubled = storedDouble * 2n
            const diff = storedSingle > doubled ? storedSingle - doubled : doubled - storedSingle
            expect(diff).to.be.lte(1n)
          }
        ),
        { numRuns: FC_RUNS }
      )
    })

    it('should be linear in raw for fixed gap within integer-division bound', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 1n, max: MAX_RAW / 10n }),
          fc.bigInt({ min: 2n, max: 10n }),
          gapArbitrary,
          async (raw, k, gapSeconds) => {
            const s1 = await takeSnapshot()
            await harness.updateRevenue(1n, baselineTs)
            await harness.updateRevenue(raw, baselineTs + gapSeconds)
            const [storedRaw] = await harness.getRevenue()
            await s1.restore()

            const s2 = await takeSnapshot()
            await harness.updateRevenue(1n, baselineTs)
            await harness.updateRevenue(raw * k, baselineTs + gapSeconds)
            const [storedScaled] = await harness.getRevenue()
            await s2.restore()

            // f(k·raw) ≥ k·f(raw) and f(k·raw) ≤ k·f(raw) + (k − 1).
            expect(storedScaled).to.be.gte(storedRaw * k)
            expect(storedScaled).to.be.lte(storedRaw * k + (k - 1n))
          }
        ),
        { numRuns: FC_RUNS }
      )
    })
  })

  describe('bypass paths', () => {
    it('should store raw verbatim on the first report for any timestamp', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 0n, max: MAX_RAW }),
          fc.bigInt({ min: 1n, max: baselineTs + ONE_DAY * 365n * 100n }),
          async (raw, reportTs) => {
            const localSnapshot = await takeSnapshot()

            await harness.updateRevenue(raw, reportTs)

            const [stored, storedTs] = await harness.getRevenue()
            expect(stored).to.equal(raw)
            expect(storedTs).to.equal(reportTs)

            await localSnapshot.restore()
          }
        ),
        { numRuns: FC_RUNS }
      )
    })

    it('should store raw verbatim when the next report reuses the previous timestamp', async () => {
      await fc.assert(
        fc.asyncProperty(fc.bigInt({ min: 0n, max: MAX_RAW }), async (raw) => {
          const localSnapshot = await takeSnapshot()

          await harness.updateRevenue(1n, baselineTs)
          await harness.updateRevenue(raw, baselineTs)

          const [stored, storedTs] = await harness.getRevenue()
          expect(stored).to.equal(raw)
          expect(storedTs).to.equal(baselineTs)

          await localSnapshot.restore()
        }),
        { numRuns: FC_RUNS }
      )
    })
  })
})
