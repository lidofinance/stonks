import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import fc from 'fast-check'

import {
  deployBuybackExecutorWithStubs,
  fundExecutor,
  setPoolReserves,
  setPoolEmaLdoPerStEth,
  PRICE_UNIT,
  DEFAULT_BOUNDS,
  ADD_LIQUIDITY_STATUS as STATUS,
  DEFAULT_LDO_USD as LDO_USD,
  DEFAULT_STETH_USD as STETH_USD,
  DEFAULT_ORACLE_LDO_PER_STETH as ORACLE_LDO_PER_STETH,
  mulDiv,
  ceilDiv,
  saturatedSub,
} from '../helpers/buyback-executor'

const NUM_RUNS = 150

const MAX_BASIS_POINTS = 10_000n
const TOLERANCE_BPS = DEFAULT_BOUNDS.poolPriceDivergenceToleranceBps
const BOOTSTRAP_MIN_TVL = DEFAULT_BOUNDS.poolBootstrapMinTvlUsd
const MIN_DEPOSIT_VALUE = DEFAULT_BOUNDS.minDepositValueUsd
const MAX_DEPOSIT_VALUE = DEFAULT_BOUNDS.maxDepositValueUsd

interface BalancedPair {
  ldoAmount: bigint
  stEthAmount: bigint
  depositValueUsd: bigint
}

// Reference for _computeBalancedAmounts: size the pair by the smaller-USD side.
function balancedReference(
  ldoBalance: bigint,
  stEthBalance: bigint,
  ldoUsdPrice: bigint,
  stEthUsdPrice: bigint
): BalancedPair {
  const ldoUsdValue = mulDiv(ldoBalance, ldoUsdPrice, PRICE_UNIT)
  const stEthUsdValue = mulDiv(stEthBalance, stEthUsdPrice, PRICE_UNIT)

  if (ldoUsdValue <= stEthUsdValue) {
    return {
      ldoAmount: ldoBalance,
      stEthAmount: mulDiv(ldoBalance, ldoUsdPrice, stEthUsdPrice),
      depositValueUsd: ldoUsdValue * 2n,
    }
  }
  return {
    ldoAmount: mulDiv(stEthBalance, stEthUsdPrice, ldoUsdPrice),
    stEthAmount: stEthBalance,
    depositValueUsd: stEthUsdValue * 2n,
  }
}

// Reference for _evaluateAddLiquidityGates at the default eligible-divergence state. Returns the
// status and the bounded amounts the contract would store.
function evaluateGatesReference(
  ldoBalance: bigint,
  stEthBalance: bigint
): BalancedPair & { status: bigint } {
  if (ldoBalance === 0n) {
    return { status: STATUS.ZeroLdoBalance, ldoAmount: 0n, stEthAmount: 0n, depositValueUsd: 0n }
  }
  if (stEthBalance === 0n) {
    return { status: STATUS.ZeroStEthBalance, ldoAmount: 0n, stEthAmount: 0n, depositValueUsd: 0n }
  }

  const balanced = balancedReference(ldoBalance, stEthBalance, LDO_USD, STETH_USD)
  if (balanced.depositValueUsd < MIN_DEPOSIT_VALUE) {
    // The contract sets depositValueUsd before the floor check but leaves the amounts at 0.
    return {
      status: STATUS.DepositValueBelowMinimum,
      ldoAmount: 0n,
      stEthAmount: 0n,
      depositValueUsd: balanced.depositValueUsd,
    }
  }

  let { ldoAmount, stEthAmount } = balanced
  if (balanced.depositValueUsd > MAX_DEPOSIT_VALUE) {
    ldoAmount = mulDiv(ldoAmount, MAX_DEPOSIT_VALUE, balanced.depositValueUsd)
    stEthAmount = mulDiv(stEthAmount, MAX_DEPOSIT_VALUE, balanced.depositValueUsd)
  }

  return {
    status: STATUS.Eligible,
    ldoAmount,
    stEthAmount,
    depositValueUsd: balanced.depositValueUsd,
  }
}

describe('BuybackExecutor - Fuzz Tests', function () {
  describe('_computeBalancedAmounts', function () {
    it('should size both legs to the smaller-USD side, matching the floor reference exactly', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)

      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 0n, max: 10n ** 27n }),
          fc.bigInt({ min: 0n, max: 10n ** 27n }),
          fc.bigInt({ min: 10n ** 15n, max: 10n ** 22n }),
          fc.bigInt({ min: 10n ** 15n, max: 10n ** 22n }),
          async (ldoBalance, stEthBalance, ldoUsdPrice, stEthUsdPrice) => {
            const balanced = await ctx.harness.computeBalancedAmounts(
              ldoBalance,
              stEthBalance,
              ldoUsdPrice,
              stEthUsdPrice
            )
            const expected = balancedReference(ldoBalance, stEthBalance, ldoUsdPrice, stEthUsdPrice)

            expect(balanced.ldoAmount).to.equal(expected.ldoAmount)
            expect(balanced.stEthAmount).to.equal(expected.stEthAmount)
            expect(balanced.depositValueUsd).to.equal(expected.depositValueUsd)
          }
        ),
        { numRuns: NUM_RUNS }
      )
    })
  })

  describe('_evaluateAddLiquidityGates', function () {
    it('should bound the eligible deposit to the floor and cap, matching the reference exactly', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 0n, max: 10n ** 24n }),
          fc.bigInt({ min: 0n, max: 10n ** 21n }),
          async (ldoBalance, stEthBalance) => {
            const ctx = await loadFixture(deployBuybackExecutorWithStubs)
            await fundExecutor(ctx, { ldo: ldoBalance, stEth: stEthBalance })

            const evaluation = await ctx.harness.evaluateAddLiquidityGates()
            const expected = evaluateGatesReference(ldoBalance, stEthBalance)

            expect(evaluation.status).to.equal(expected.status)
            expect(evaluation.depositValueUsd).to.equal(expected.depositValueUsd)
            expect(evaluation.ldoAmount).to.equal(expected.ldoAmount)
            expect(evaluation.stEthAmount).to.equal(expected.stEthAmount)
          }
        ),
        { numRuns: NUM_RUNS }
      )
    })
  })

  describe('_computeLpModeFreeStEth', function () {
    it('should equal the stETH balance minus the held LDO value, saturating at 0', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 0n, max: 10n ** 24n }),
          fc.bigInt({ min: 0n, max: 10n ** 24n }),
          async (ldoBalance, stEthBalance) => {
            const ctx = await loadFixture(deployBuybackExecutorWithStubs)
            await fundExecutor(ctx, { ldo: ldoBalance, stEth: stEthBalance })

            // No order is tracked and Stonks holds no stETH, so only the held-LDO leg is subtracted.
            const ldoInStEth = ldoBalance > 0n ? mulDiv(ldoBalance, LDO_USD, STETH_USD) : 0n
            const expectedFree = saturatedSub(stEthBalance, ldoInStEth)

            expect(await ctx.harness.computeLpModeFreeStEth()).to.equal(expectedFree)
          }
        ),
        { numRuns: NUM_RUNS }
      )
    })
  })

  describe('_evaluatePoolPriceDivergence', function () {
    it('should compute divergenceBps as the rounded-up basis-point distance from the oracle ratio', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 0n, max: 2n * ORACLE_LDO_PER_STETH }),
          async (emaLdoPerStEth) => {
            const ctx = await loadFixture(deployBuybackExecutorWithStubs)
            await setPoolEmaLdoPerStEth(ctx, emaLdoPerStEth)

            const divergence = await ctx.harness.evaluatePoolPriceDivergence()

            // Derive the distance from the EMA the contract actually stored, since the share-rate
            // round-trip can shift the requested target by a wei.
            const storedEma = divergence.poolEmaLdoPerStEth
            const distance =
              storedEma >= ORACLE_LDO_PER_STETH
                ? storedEma - ORACLE_LDO_PER_STETH
                : ORACLE_LDO_PER_STETH - storedEma
            const expectedBps = ceilDiv(distance * MAX_BASIS_POINTS, ORACLE_LDO_PER_STETH)

            expect(divergence.divergenceBps).to.equal(expectedBps)
          }
        ),
        { numRuns: NUM_RUNS }
      )
    })

    it('should gate exactly when poolTvlUsd reaches the floor and divergenceBps exceeds tolerance', async function () {
      await fc.assert(
        fc.asyncProperty(
          // LDO reserve spans the floor: TVL = reserve * 2, crossing 50000e18 around reserve 25000e18.
          fc.bigInt({ min: 0n, max: 50_000n * PRICE_UNIT }),
          // EMA spans the tolerance: 0 to 1000 bps of divergence around the 100 bps tolerance.
          fc.bigInt({
            min: (ORACLE_LDO_PER_STETH * 9n) / 10n,
            max: (ORACLE_LDO_PER_STETH * 11n) / 10n,
          }),
          async (ldoReserve, emaLdoPerStEth) => {
            const ctx = await loadFixture(deployBuybackExecutorWithStubs)
            await setPoolReserves(ctx, ldoReserve, 0n)
            await setPoolEmaLdoPerStEth(ctx, emaLdoPerStEth)

            const divergence = await ctx.harness.evaluatePoolPriceDivergence()
            const poolTvlUsd = await ctx.harness.poolTvlUsd(
              divergence.ldoUsdPrice,
              divergence.stEthUsdPrice
            )

            const expectedGated =
              divergence.divergenceBps > TOLERANCE_BPS && poolTvlUsd >= BOOTSTRAP_MIN_TVL
            expect(divergence.status).to.equal(
              expectedGated ? STATUS.PoolPriceDivergenceTooHigh : STATUS.Eligible
            )
          }
        ),
        { numRuns: NUM_RUNS }
      )
    })
  })
})
