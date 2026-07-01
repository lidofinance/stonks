import { ethers } from 'hardhat'
import { expect } from 'chai'
import { Signer } from 'ethers'
import { takeSnapshot } from '@nomicfoundation/hardhat-network-helpers'
import fc from 'fast-check'

import {
  BuybackAllocator,
  BuybackAllocator__factory,
  StEthTokenStub,
  StEthTokenStub__factory,
  OracleRouterUsdStub,
  OracleRouterUsdStub__factory,
  ExecutorStub,
  ExecutorStub__factory,
  RevenueSourceStub,
  RevenueSourceStub__factory,
} from '../../typechain-types'

const PRICE_UNIT = 10n ** 18n // OracleRouterUsdStub.PRICE_UNIT
const MAX_BP = 10_000n
// Wide caps so the cap/min gates never bind in the budget/conversion properties.
const HUGE_CAP = 10n ** 30n

// Realistic-ish ceilings, kept clear of uint256 overflow in `surplus*bp` and `usd*PRICE_UNIT`.
const usdGenerator = fc.bigInt({ min: 0n, max: 10n ** 26n }) // baselines / revenue totals
const positivePriceGenerator = fc.bigInt({ min: 1n, max: 10n ** 24n })
const balanceGenerator = fc.bigInt({ min: 0n, max: 10n ** 24n })
const validBpGenerator = fc.bigInt({ min: 1n, max: MAX_BP })
// For param validation: spans invalid values (0, > MAX_BP) to exercise the revert paths.
const wideBpGenerator = fc.bigInt({ min: 0n, max: 2n * MAX_BP })
const capGenerator = fc.bigInt({ min: 0n, max: HUGE_CAP }) // includes 0 to trip the zero-cap revert

type DeployOpts = {
  bp: bigint
  reserveRate: bigint
  dailyCap: bigint
  yearlyCap: bigint
  minSpend: bigint
  minPrice: bigint
}

describe('BuybackAllocator - Fuzz Tests', () => {
  let deployer: Signer
  let deployerAddr: string
  let stEth: StEthTokenStub
  let oracle: OracleRouterUsdStub
  let executor: ExecutorStub
  let source: RevenueSourceStub

  async function deployAllocator(opts: DeployOpts): Promise<BuybackAllocator> {
    const allocator = await new BuybackAllocator__factory(deployer).deploy({
      admin: deployerAddr,
      treasury: deployerAddr,
      stEth: await stEth.getAddress(),
      oracleRouter: await oracle.getAddress(),
      executor: await executor.getAddress(),
      dailyCapUSD: opts.dailyCap,
      yearlyCapUSD: opts.yearlyCap,
      reserveDailyRateUSD: opts.reserveRate,
      minStEthPriceUSD: opts.minPrice,
      minSpendPerCallUSD: opts.minSpend,
      surplusShareBP: opts.bp,
      revenueSources: [await source.getAddress()],
    })
    await allocator.waitForDeployment()
    return allocator
  }

  before(async () => {
    ;[deployer] = await ethers.getSigners()
    deployerAddr = await deployer.getAddress()

    stEth = await new StEthTokenStub__factory(deployer).deploy()
    oracle = await new OracleRouterUsdStub__factory(deployer).deploy()
    executor = await new ExecutorStub__factory(deployer).deploy()
    source = await new RevenueSourceStub__factory(deployer).deploy()

    await oracle.setUsdPrice(3500n * PRICE_UNIT, 3500n * PRICE_UNIT)
  })

  // The budget delta at a checkpoint is (revenue - baseline - reserve) * bp / 10000, signed.
  it('budget delta = (revenue - baseline) * surplusShareBP / 10000, signed', async () => {
    // Fix the activation baseline mid-range so fuzzed revenue lands on both sides (signed delta).
    const baseline = 10n ** 26n / 2n

    const allocator = await deployAllocator({
      bp: MAX_BP,
      reserveRate: 0n,
      dailyCap: HUGE_CAP,
      yearlyCap: HUGE_CAP,
      minSpend: 1n,
      minPrice: 0n,
    })
    await source.setCumulativeRevenueUSD(baseline)
    await allocator.activate() // baseline recorded

    await fc.assert(
      fc.asyncProperty(validBpGenerator, usdGenerator, async (bp, revenue) => {
        const snap = await takeSnapshot()

        await allocator.setSurplusShareBP(bp) // checkpoint is a no-op here (revenue == baseline)
        await source.setCumulativeRevenueUSD(revenue)
        await allocator.allocate() // checkpoints; no stETH so nothing is spent

        const expected = ((revenue - baseline) * bp) / MAX_BP // truncates toward zero, like int256
        expect(await allocator.budgetUSD()).to.equal(expected)

        await snap.restore()
      }),
      { numRuns: 400 }
    )
  })

  // Conversion: allocationStEth == min(mulDiv(USD, 1e18, price), balance) and the restated USD ==
  // mulDiv(allocationStEth, price, 1e18), for any positive price.
  it('converts USD <-> stETH as min(mulDiv(...), balance) with restated USD', async () => {
    const allocator = await deployAllocator({
      bp: MAX_BP, // 100% so available budget == revenue
      reserveRate: 0n,
      dailyCap: HUGE_CAP,
      yearlyCap: HUGE_CAP,
      minSpend: 1n,
      minPrice: 0n,
    })
    await source.setCumulativeRevenueUSD(0n)
    await allocator.activate() // baseline 0
    const allocatorAddr = await allocator.getAddress()

    await fc.assert(
      fc.asyncProperty(
        usdGenerator,
        positivePriceGenerator,
        balanceGenerator,
        async (revenue, price, balance) => {
          const expectedStEth = min((revenue * PRICE_UNIT) / price, balance)
          const expectedUSD = (expectedStEth * price) / PRICE_UNIT
          fc.pre(expectedUSD >= 1n) // below minSpend the contract reports AllocationBelowMin (0, 0)

          const snap = await takeSnapshot()

          await oracle.setUsdPrice(price, price)
          await stEth.mint(allocatorAddr, balance)
          await source.setCumulativeRevenueUSD(revenue) // available budget == revenue

          const [status, spendableUSD, spendableStEth] = await allocator.spendable()
          expect(status).to.equal(0n) // Eligible
          expect(spendableStEth).to.equal(expectedStEth)
          expect(spendableUSD).to.equal(expectedUSD)

          await snap.restore()
        }
      ),
      { numRuns: 400 }
    )
  })

  // No sequence of cap / share setters can break the ordering invariants — each setter either
  // succeeds preserving them, or reverts leaving state untouched.
  it('keeps minSpend <= dailyCap <= yearlyCap and bp in (0, 10000] under any setter sequence', async () => {
    const setterOpGenerator = fc.oneof(
      fc.record({ kind: fc.constant('daily' as const), value: capGenerator }),
      fc.record({ kind: fc.constant('yearly' as const), value: capGenerator }),
      fc.record({ kind: fc.constant('minSpend' as const), value: capGenerator }),
      fc.record({ kind: fc.constant('bp' as const), value: wideBpGenerator })
    )

    const allocator = await deployAllocator({
      bp: 5_000n,
      reserveRate: 0n,
      dailyCap: 1_000_000n * PRICE_UNIT,
      yearlyCap: 100_000_000n * PRICE_UNIT,
      minSpend: PRICE_UNIT,
      minPrice: 0n,
    })
    await allocator.activate() // setSurplusShareBP is whenActivated

    await fc.assert(
      fc.asyncProperty(fc.array(setterOpGenerator, { maxLength: 15 }), async (ops) => {
        const snap = await takeSnapshot()

        for (const op of ops) {
          try {
            if (op.kind === 'daily') await allocator.setDailyCapUSD(op.value)
            else if (op.kind === 'yearly') await allocator.setYearlyCapUSD(op.value)
            else if (op.kind === 'minSpend') await allocator.setMinSpendPerCallUSD(op.value)
            else await allocator.setSurplusShareBP(op.value)
          } catch {
            // Validation revert — state must be unchanged, so the invariant below still holds.
          }

          const daily = await allocator.dailyCapUSD()
          const yearly = await allocator.yearlyCapUSD()
          const minSpend = await allocator.minSpendPerCallUSD()
          const bp = await allocator.surplusShareBP()

          expect(minSpend > 0n && minSpend <= daily, 'minSpend <= daily').to.equal(true)
          expect(daily > 0n && daily <= yearly, 'daily <= yearly').to.equal(true)
          expect(bp >= 1n && bp <= MAX_BP, 'bp in (0, 10000]').to.equal(true)
        }

        await snap.restore()
      }),
      { numRuns: 300 }
    )
  })
})

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}
