import { ethers } from 'hardhat'
import { expect } from 'chai'
import { Signer } from 'ethers'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import fc from 'fast-check'

import {
  StakingRevenueSource,
  StEthSharesStub,
  StEthSharesStub__factory,
  StakingRouterStub,
  StakingRouterStub__factory,
  OracleRouterUsdStub,
  OracleRouterUsdStub__factory,
  LidoLocatorStub,
  LidoLocatorStub__factory,
} from '../../typechain-types'

// PRICE_SCALE == OracleRouterUsdStub.PRICE_UNIT == StEthSharesStub identity rate.
const PRICE_SCALE = 10n ** 18n
const BASE_PRECISION = 10_000n

// Rebase-payload fields the source ignores (timeElapsed, pre/post shares/ether).
const PUSH_IGNORED = [1n, 1n, 1n, 1n, 1n] as const

enum OracleFailureMode {
  None = 0,
  CustomError = 1,
  EmptyRevert = 2,
}

// Bounds keep `sharesMintedAsFees_ * treasuryFee` and `pending * price` well clear of uint256
// overflow, so the only reverts are the ones the properties intend (oracle failures).
const sharesArb = fc.bigInt({ min: 0n, max: 10n ** 30n })
const sharesPosArb = fc.bigInt({ min: 10n ** 18n, max: 10n ** 30n }) // forces a non-zero treasury slice
const pricePosArb = fc.bigInt({ min: 1n, max: 10n ** 24n })
// [modulesFee, treasuryFee]. `feeArb` allows a zero split (early-return branch); `feeActiveArb`
// guarantees totalFee > 0.
const feeArb = fc.tuple(fc.bigInt({ min: 0n, max: 100_000n }), fc.bigInt({ min: 0n, max: 100_000n }))
const feeActiveArb = fc.tuple(
  fc.bigInt({ min: 0n, max: 100_000n }),
  fc.bigInt({ min: 1n, max: 100_000n })
)

// Mirrors the contract with the stub identity rate (1 share == 1 stETH).
function expectedTreasuryStEth(shares: bigint, modulesFee: bigint, treasuryFee: bigint): bigint {
  const totalFee = modulesFee + treasuryFee
  if (totalFee === 0n || shares === 0n) return 0n
  return (shares * treasuryFee) / totalFee
}

describe('StakingRevenueSource - Fuzz Tests', () => {
  let admin: Signer
  let notifier: Signer // postTokenRebaseReceiver, the authorized pushTokenRate caller
  let subject: StakingRevenueSource
  let stEthStub: StEthSharesStub
  let stakingRouterStub: StakingRouterStub
  let oracleStub: OracleRouterUsdStub
  let locatorStub: LidoLocatorStub

  let suiteSnapshot: SnapshotRestorer

  async function setFee(modulesFee: bigint, treasuryFee: bigint) {
    await stakingRouterStub.setFeeDistribution(modulesFee, treasuryFee, BASE_PRECISION)
  }

  async function push(shares: bigint, reportTs: bigint) {
    return subject.connect(notifier).pushTokenRate(reportTs, ...PUSH_IGNORED, shares)
  }

  before(async () => {
    suiteSnapshot = await takeSnapshot()
    ;[admin, notifier] = await ethers.getSigners()

    stEthStub = await new StEthSharesStub__factory(admin).deploy(PRICE_SCALE) // identity rate
    stakingRouterStub = await new StakingRouterStub__factory(admin).deploy()
    oracleStub = await new OracleRouterUsdStub__factory(admin).deploy()
    locatorStub = await new LidoLocatorStub__factory(admin).deploy()

    await locatorStub.setLido(await stEthStub.getAddress())
    await locatorStub.setStakingRouter(await stakingRouterStub.getAddress())
    await locatorStub.setPostTokenRebaseReceiver(await notifier.getAddress())

    const factory = await ethers.getContractFactory('StakingRevenueSource')
    subject = await factory.deploy(await oracleStub.getAddress(), await locatorStub.getAddress())
    await subject.waitForDeployment()
  })

  after(async () => {
    await suiteSnapshot.restore()
  })

  it('should keep treasuryShares within sharesMintedAsFees_ for any fee split', async () => {
    await fc.assert(
      fc.asyncProperty(sharesArb, feeActiveArb, async (shares, [modulesFee, treasuryFee]) => {
        const snap = await takeSnapshot()
        await setFee(modulesFee, treasuryFee)
        await push(shares, 1n)

        // Identity rate: pendingRevenueStEth == treasuryShares.
        const treasuryShares = await subject.pendingRevenueStEth()
        expect(treasuryShares).to.be.lte(shares)
        expect(treasuryShares).to.equal(expectedTreasuryStEth(shares, modulesFee, treasuryFee))

        await snap.restore()
      }),
      { numRuns: 50 }
    )
  })

  it('should match pendingRevenueStEth to the summed per-push treasury stETH across random share and fee-split sequences', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(sharesArb, feeArb), { minLength: 1, maxLength: 8 }),
        async (pushes) => {
          const snap = await takeSnapshot()

          let expectedPending = 0n
          let ts = 0n
          for (const [shares, [modulesFee, treasuryFee]] of pushes) {
            await setFee(modulesFee, treasuryFee)
            ts += 1n
            await push(shares, ts)
            expectedPending += expectedTreasuryStEth(shares, modulesFee, treasuryFee)
          }

          expect(await subject.pendingRevenueStEth()).to.equal(expectedPending)

          await snap.restore()
        }
      ),
      { numRuns: 30 }
    )
  })

  it('should match revenueUSD to pending * price / PRICE_SCALE for any positive price and pending bucket', async () => {
    await fc.assert(
      fc.asyncProperty(
        sharesPosArb,
        feeActiveArb,
        pricePosArb,
        async (shares, [modulesFee, treasuryFee], price) => {
          const snap = await takeSnapshot()

          await setFee(modulesFee, treasuryFee)
          await push(shares, 1n)
          const pending = await subject.pendingRevenueStEth()
          fc.pre(pending > 0n) // skip splits that round the treasury slice to zero

          await oracleStub.setUsdPrice(price, price)
          await subject.convertPendingRevenueToUSD()

          expect(await subject.getCumulativeRevenueUSD()).to.equal((pending * price) / PRICE_SCALE)

          await snap.restore()
        }
      ),
      { numRuns: 50 }
    )
  })

  it('getCumulativeRevenueUSD() is non-decreasing across any call sequence', async () => {
    const opArb = fc.oneof(
      fc.record({ kind: fc.constant('push' as const), shares: sharesArb, fee: feeArb }),
      // price 0 makes the conversion fail (OracleReturnedZeroPrice); both paths must hold the invariant.
      fc.record({ kind: fc.constant('convert' as const), price: fc.bigInt({ min: 0n, max: 10n ** 24n }) })
    )

    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 12 }), async (ops) => {
        const snap = await takeSnapshot()

        let previous = await subject.getCumulativeRevenueUSD()
        let ts = 0n
        for (const op of ops) {
          if (op.kind === 'push') {
            await setFee(op.fee[0], op.fee[1])
            ts += 1n
            await push(op.shares, ts)
          } else {
            await oracleStub.setUsdPrice(op.price, op.price)
            try {
              await subject.convertPendingRevenueToUSD()
            } catch {
              // Zero-price conversion reverts and rolls back — the invariant must still hold.
            }
          }

          const current = await subject.getCumulativeRevenueUSD()
          expect(current).to.be.gte(previous)
          previous = current
        }

        await snap.restore()
      }),
      { numRuns: 20 }
    )
  })

  it('pendingRevenueStEth is zero immediately after a successful conversion', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(sharesArb, feeArb), { maxLength: 8 }),
        pricePosArb,
        async (pushes, price) => {
          const snap = await takeSnapshot()

          let ts = 0n
          for (const [shares, [modulesFee, treasuryFee]] of pushes) {
            await setFee(modulesFee, treasuryFee)
            ts += 1n
            await push(shares, ts)
          }

          // Positive price => conversion succeeds (no-op if the bucket was empty).
          await oracleStub.setUsdPrice(price, price)
          await subject.convertPendingRevenueToUSD()

          expect(await subject.pendingRevenueStEth()).to.equal(0n)

          await snap.restore()
        }
      ),
      { numRuns: 30 }
    )
  })

  it('a failed conversion leaves pendingRevenueStEth and the cumulative unchanged', async () => {
    // 0 -> zero price, 1 -> CustomError revert, 2 -> EmptyRevert.
    const failureArb = fc.constantFrom(0, 1, 2)

    await fc.assert(
      fc.asyncProperty(
        sharesPosArb,
        feeActiveArb,
        failureArb,
        async (shares, [modulesFee, treasuryFee], failure) => {
          const snap = await takeSnapshot()

          await setFee(modulesFee, treasuryFee)
          await push(shares, 1n)
          const pendingBefore = await subject.pendingRevenueStEth()
          const cumulativeBefore = await subject.getCumulativeRevenueUSD()
          fc.pre(pendingBefore > 0n)

          if (failure === 0) {
            await oracleStub.setUsdPrice(0n, 0n) // OracleReturnedZeroPrice
          } else if (failure === 1) {
            await oracleStub.setFailureMode(OracleFailureMode.CustomError)
          } else {
            await oracleStub.setFailureMode(OracleFailureMode.EmptyRevert)
          }

          await expect(subject.convertPendingRevenueToUSD()).to.be.reverted
          expect(await subject.pendingRevenueStEth()).to.equal(pendingBefore)
          expect(await subject.getCumulativeRevenueUSD()).to.equal(cumulativeBefore)

          await snap.restore()
        }
      ),
      { numRuns: 40 }
    )
  })

  it('pushTokenRate never touches the cumulative accumulator or the oracle', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(sharesArb, feeArb), { maxLength: 8 }), async (pushes) => {
        const snap = await takeSnapshot()

        // Poison the oracle: any read from it reverts. Pushes must still succeed and never settle USD.
        await oracleStub.setFailureMode(OracleFailureMode.CustomError)

        let ts = 0n
        for (const [shares, [modulesFee, treasuryFee]] of pushes) {
          await setFee(modulesFee, treasuryFee)
          ts += 1n
          await push(shares, ts) // would revert if pushTokenRate read the poisoned oracle
        }

        expect(await subject.getCumulativeRevenueUSD()).to.equal(0n)

        await snap.restore()
      }),
      { numRuns: 30 }
    )
  })
})
