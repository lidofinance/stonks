import { expect } from 'chai'
import { Log } from 'ethers'
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'

import {
  setupForkBuyback,
  fundForkExecutor,
  ForkBuybackContext,
  ADD_LIQUIDITY_STATUS,
  PRICE_UNIT,
} from '../helpers/buyback-executor'

// Seeds a deep pool sitting on the oracle ratio: the divergence gate is satisfied and TVL clears the
// 50000 USD bootstrap floor.
function deepOnOracleFixture(): Promise<ForkBuybackContext | undefined> {
  return setupForkBuyback({ seedWstEth: 80n * PRICE_UNIT })
}

// Deep pool whose EMA sits 10% off the oracle ratio, so the divergence gate fires once TVL clears the
// bootstrap floor.
function deepDivergentFixture(): Promise<ForkBuybackContext | undefined> {
  return setupForkBuyback({ seedWstEth: 80n * PRICE_UNIT, priceSkewBps: 11000n })
}

// Shallow pool whose EMA sits 10% off the oracle ratio. TVL is below the 50000 USD bootstrap floor, so
// the gate is bypassed and deposits can build the pool up.
function shallowDivergentFixture(): Promise<ForkBuybackContext | undefined> {
  return setupForkBuyback({ seedWstEth: 5n * PRICE_UNIT, priceSkewBps: 11000n })
}

// Shallow pool whose price_scale sits at twice the oracle ratio. The gate is bypassed, so the executor
// deposits a balanced pair into a pool priced far from the oracle.
function shallowFarPriceFixture(): Promise<ForkBuybackContext | undefined> {
  return setupForkBuyback({ seedWstEth: 5n * PRICE_UNIT, priceSkewBps: 20000n })
}

// PRICE_UNIT at 200x the oracle ratio with the bootstrap floor set to its maximum, so the gate stays
// bypassed and only Curve's own invariant math decides whether the deposit lands.
function extremeSkewGateOpenFixture(): Promise<ForkBuybackContext | undefined> {
  return setupForkBuyback({
    seedWstEth: 1n * PRICE_UNIT,
    priceSkewBps: 2000000n,
    bounds: { poolBootstrapMinTvlUsd: 1_000_000n * PRICE_UNIT },
  })
}

// Balanced LDO to pair with a given stETH leg at the oracle, padded so stETH is the smaller-USD side
// and the whole stETH leg deposits.
function balancedLdoFor(ctx: ForkBuybackContext, stEthAmount: bigint): bigint {
  return (stEthAmount * ctx.prices.stEthUsd * 105n) / (ctx.prices.ldoUsd * 100n)
}

// USD value of each pool leg, valued at the oracle, as an [ldoUsd, stEthUsd] pair scaled to 1e18.
async function poolLegUsdValues(ctx: ForkBuybackContext): Promise<[bigint, bigint]> {
  const ldoReserve: bigint = await ctx.pool.balances(0)
  const wstEthReserve: bigint = await ctx.pool.balances(1)
  const stEthReserve = (wstEthReserve * ctx.prices.shareRate) / PRICE_UNIT
  const ldoUsd = (ldoReserve * ctx.prices.ldoUsd) / PRICE_UNIT
  const stEthUsd = (stEthReserve * ctx.prices.stEthUsd) / PRICE_UNIT
  return [ldoUsd, stEthUsd]
}

function liquidityAddedArgs(
  ctx: ForkBuybackContext,
  logs: readonly Log[]
): { ldoAmount: bigint; wstEthAmount: bigint; lpTokensMinted: bigint } {
  const topic = ctx.buybackExecutor.interface.getEvent('LiquidityAdded')!.topicHash
  const log = logs.find((entry) => entry.topics[0] === topic)!
  const parsed = ctx.buybackExecutor.interface.parseLog({
    topics: [...log.topics],
    data: log.data,
  })!
  return {
    ldoAmount: parsed.args.ldoAmount,
    wstEthAmount: parsed.args.wstEthAmount,
    lpTokensMinted: parsed.args.lpTokensMinted,
  }
}

describe('BuybackExecutor — forked Curve pool', function () {
  this.timeout(180000)

  describe('addLiquidity and removeLiquidityAndRecoverToTreasury', function () {
    it('should add and remove liquidity against live pool reserves', async function () {
      const ctx = await loadFixture(deepOnOracleFixture)
      if (ctx === undefined) return this.skip()

      const stEthFund = 1n * PRICE_UNIT
      await fundForkExecutor(ctx, { stEth: stEthFund, ldo: balancedLdoFor(ctx, stEthFund) })

      const addReceipt = await (
        await ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
      ).wait()
      const added = liquidityAddedArgs(ctx, addReceipt!.logs)

      expect(added.lpTokensMinted).to.be.gt(0n)
      expect(await ctx.buybackExecutor.getLpTokenBalance()).to.equal(added.lpTokensMinted)

      const treasuryAddress = await ctx.signers.treasury.getAddress()
      const treasuryLdoBefore: bigint = await ctx.ldo.balanceOf(treasuryAddress)
      const treasuryStEthBefore: bigint = await ctx.stEth.balanceOf(treasuryAddress)

      const lpToRemove = await ctx.buybackExecutor.getLpTokenBalance()
      await expect(
        ctx.buybackExecutor
          .connect(ctx.signers.manager)
          .removeLiquidityAndRecoverToTreasury(lpToRemove, 1n, 1n)
      ).to.emit(ctx.buybackExecutor, 'LiquidityRemoved')

      expect(await ctx.buybackExecutor.getLpTokenBalance()).to.equal(0n)

      const expectedStEth = (added.wstEthAmount * ctx.prices.shareRate) / PRICE_UNIT
      // Balanced add then full balanced remove returns the deposited legs within crypto-pool fees.
      expect((await ctx.ldo.balanceOf(treasuryAddress)) - treasuryLdoBefore).to.be.closeTo(
        added.ldoAmount,
        added.ldoAmount / 100n
      )
      expect((await ctx.stEth.balanceOf(treasuryAddress)) - treasuryStEthBefore).to.be.closeTo(
        expectedStEth,
        expectedStEth / 100n
      )
    })

    it('should deposit balanced legs that keep the pool USD split near 50:50', async function () {
      const ctx = await loadFixture(deepOnOracleFixture)
      if (ctx === undefined) return this.skip()

      const stEthFund = 2n * PRICE_UNIT
      await fundForkExecutor(ctx, { stEth: stEthFund, ldo: balancedLdoFor(ctx, stEthFund) })

      const [ldoUsdBefore, stEthUsdBefore] = await poolLegUsdValues(ctx)
      const ldoShareBefore = (ldoUsdBefore * PRICE_UNIT) / (ldoUsdBefore + stEthUsdBefore)

      const addReceipt = await (
        await ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
      ).wait()
      const added = liquidityAddedArgs(ctx, addReceipt!.logs)

      // The deposited legs carry equal USD value at the oracle.
      const ldoLegUsd = (added.ldoAmount * ctx.prices.ldoUsd) / PRICE_UNIT
      const stEthLeg = (added.wstEthAmount * ctx.prices.shareRate) / PRICE_UNIT
      const stEthLegUsd = (stEthLeg * ctx.prices.stEthUsd) / PRICE_UNIT
      expect(ldoLegUsd).to.be.closeTo(stEthLegUsd, stEthLegUsd / 100n)

      const [ldoUsdAfter, stEthUsdAfter] = await poolLegUsdValues(ctx)
      const ldoShareAfter = (ldoUsdAfter * PRICE_UNIT) / (ldoUsdAfter + stEthUsdAfter)

      // A balanced deposit does not push the pool's USD split away from 50:50.
      const half = PRICE_UNIT / 2n
      expect(ldoShareAfter).to.be.closeTo(half, PRICE_UNIT / 100n)
      const skewBefore = ldoShareBefore > half ? ldoShareBefore - half : half - ldoShareBefore
      const skewAfter = ldoShareAfter > half ? ldoShareAfter - half : half - ldoShareAfter
      expect(skewAfter).to.be.lte(skewBefore + PRICE_UNIT / 1000n)
    })
  })

  describe('divergence gate against the real EMA', function () {
    it('should block addLiquidity past tolerance once pool TVL reaches the bootstrap floor', async function () {
      const ctx = await loadFixture(deepDivergentFixture)
      if (ctx === undefined) return this.skip()

      const evaluation = await ctx.harness.evaluatePoolPriceDivergence()
      expect(evaluation.divergenceBps).to.be.gt(ctx.params.poolPriceDivergenceToleranceBps)
      expect(evaluation.status).to.equal(ADD_LIQUIDITY_STATUS.PoolPriceDivergenceTooHigh)

      const poolTvl = await ctx.harness.poolTvlUsd(ctx.prices.ldoUsd, ctx.prices.stEthUsd)
      expect(poolTvl).to.be.gte(ctx.params.poolBootstrapMinTvlUsd)

      const stEthFund = 1n * PRICE_UNIT
      await fundForkExecutor(ctx, { stEth: stEthFund, ldo: balancedLdoFor(ctx, stEthFund) })

      expect(await ctx.buybackExecutor.canAddLiquidity()).to.equal(false)
      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
      ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'PoolPriceDivergenceTooHigh')
    })
  })

  describe('bootstrap a shallow divergent pool', function () {
    it('should bypass the gate while shallow then enforce it once TVL reaches the floor', async function () {
      const ctx = await loadFixture(shallowDivergentFixture)
      if (ctx === undefined) return this.skip()

      // The EMA is past tolerance, yet the shallow pool bypasses the gate.
      const shallowEval = await ctx.harness.evaluatePoolPriceDivergence()
      expect(shallowEval.divergenceBps).to.be.gt(ctx.params.poolPriceDivergenceToleranceBps)
      expect(shallowEval.status).to.equal(ADD_LIQUIDITY_STATUS.Eligible)
      expect(await ctx.harness.poolTvlUsd(ctx.prices.ldoUsd, ctx.prices.stEthUsd)).to.be.lt(
        ctx.params.poolBootstrapMinTvlUsd
      )

      const stEthFund = 1n * PRICE_UNIT
      await fundForkExecutor(ctx, { stEth: stEthFund, ldo: balancedLdoFor(ctx, stEthFund) })
      expect(await ctx.buybackExecutor.canAddLiquidity()).to.equal(true)
      await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()).to.emit(
        ctx.buybackExecutor,
        'LiquidityAdded'
      )

      // Grow the pool above the floor with a deposit proportional to current reserves, which leaves the
      // price, and therefore the divergence, unchanged.
      const ldoReserve: bigint = await ctx.pool.balances(0)
      const wstEthReserve: bigint = await ctx.pool.balances(1)
      const poolAddress = await ctx.pool.getAddress()
      await ctx.ldo.approve(poolAddress, ldoReserve * 3n)
      await ctx.wstEth.approve(poolAddress, wstEthReserve * 3n)
      await (await ctx.pool.add_liquidity([ldoReserve * 3n, wstEthReserve * 3n], 1n)).wait()

      // TVL now clears the floor, the EMA is still divergent, so the gate enforces.
      const deepEval = await ctx.harness.evaluatePoolPriceDivergence()
      expect(deepEval.divergenceBps).to.be.gt(ctx.params.poolPriceDivergenceToleranceBps)
      expect(await ctx.harness.poolTvlUsd(ctx.prices.ldoUsd, ctx.prices.stEthUsd)).to.be.gte(
        ctx.params.poolBootstrapMinTvlUsd
      )
      expect(deepEval.status).to.equal(ADD_LIQUIDITY_STATUS.PoolPriceDivergenceTooHigh)

      expect(await ctx.buybackExecutor.canAddLiquidity()).to.equal(false)
      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
      ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'PoolPriceDivergenceTooHigh')
    })
  })

  describe('min_mint = 1 against real invariant math', function () {
    it('should mint a fair LP claim when price_scale sits far from the oracle ratio', async function () {
      const ctx = await loadFixture(shallowFarPriceFixture)
      if (ctx === undefined) return this.skip()

      // price_scale is twice the oracle ratio. The shallow pool bypasses the gate, so the deposit lands.
      const evaluation = await ctx.harness.evaluatePoolPriceDivergence()
      expect(evaluation.divergenceBps).to.be.gt(ctx.params.poolPriceDivergenceToleranceBps)
      expect(evaluation.status).to.equal(ADD_LIQUIDITY_STATUS.Eligible)

      const stEthFund = 1n * PRICE_UNIT
      await fundForkExecutor(ctx, { stEth: stEthFund, ldo: balancedLdoFor(ctx, stEthFund) })
      const depositUsd = ((stEthFund * ctx.prices.stEthUsd) / PRICE_UNIT) * 2n

      const addReceipt = await (
        await ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
      ).wait()
      const added = liquidityAddedArgs(ctx, addReceipt!.logs)
      expect(added.lpTokensMinted).to.be.gt(0n)

      // Value the minted LP by simulating a balanced withdrawal at the oracle. min_mint = 1 did not let
      // the pool accept a dust mint: the claim tracks the deposited USD within fees and slippage.
      const withdrawn = await ctx.pool.remove_liquidity.staticCall(added.lpTokensMinted, [1n, 1n])
      const ldoOut: bigint = withdrawn[0]
      const stEthOut = (withdrawn[1] * ctx.prices.shareRate) / PRICE_UNIT
      const withdrawnUsd =
        (ldoOut * ctx.prices.ldoUsd) / PRICE_UNIT + (stEthOut * ctx.prices.stEthUsd) / PRICE_UNIT

      expect(withdrawnUsd).to.be.gte((depositUsd * 80n) / 100n)
      expect(withdrawnUsd).to.be.lte((depositUsd * 120n) / 100n)
    })
  })

  describe('graceful absorption under extreme divergence', function () {
    it('should let Curve absorb an extreme-skew deposit, leaving the gate as the protection', async function () {
      const ctx = await loadFixture(extremeSkewGateOpenFixture)
      if (ctx === undefined) return this.skip()

      // price_scale is 200x the oracle ratio, but the maxed-out bootstrap floor keeps the gate bypassed.
      const openEval = await ctx.harness.evaluatePoolPriceDivergence()
      expect(openEval.divergenceBps).to.be.gt(ctx.params.poolPriceDivergenceToleranceBps)
      expect(openEval.status).to.equal(ADD_LIQUIDITY_STATUS.Eligible)

      const stEthFund = 1n * PRICE_UNIT
      await fundForkExecutor(ctx, { stEth: stEthFund, ldo: balancedLdoFor(ctx, stEthFund) })
      const wstEthReserveBefore: bigint = await ctx.pool.balances(1)

      // Curve does not trip a convergence bound on the wildly imbalanced deposit. It absorbs it, charging
      // the dynamic imbalance fee, and mints a real LP claim.
      const addReceipt = await (
        await ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
      ).wait()
      const added = liquidityAddedArgs(ctx, addReceipt!.logs)
      expect(added.lpTokensMinted).to.be.gt(0n)
      expect(await ctx.buybackExecutor.getLpTokenBalance()).to.equal(added.lpTokensMinted)
      expect(await ctx.pool.balances(1)).to.equal(wstEthReserveBefore + added.wstEthAmount)

      // Since Curve never reverts here, the divergence gate is the only protection. Lower the floor below
      // the live TVL and the same divergent pool is blocked.
      await ctx.buybackExecutor
        .connect(ctx.signers.admin)
        .setPoolBootstrapMinTvlUsd(50_000n * PRICE_UNIT)
      await fundForkExecutor(ctx, { stEth: stEthFund, ldo: balancedLdoFor(ctx, stEthFund) })

      expect((await ctx.harness.evaluatePoolPriceDivergence()).status).to.equal(
        ADD_LIQUIDITY_STATUS.PoolPriceDivergenceTooHigh
      )
      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
      ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'PoolPriceDivergenceTooHigh')
    })
  })

  describe('pool TVL valuation', function () {
    it('should value TVL from internal balances and ignore a direct token donation', async function () {
      const ctx = await loadFixture(deepOnOracleFixture)
      if (ctx === undefined) return this.skip()

      const poolAddress = await ctx.pool.getAddress()
      const tvlBefore = await ctx.harness.poolTvlUsd(ctx.prices.ldoUsd, ctx.prices.stEthUsd)
      const reserveBefore: bigint = await ctx.pool.balances(0)

      // Donate LDO straight to the pool. This raises the pool's token balance but not its accounting.
      await ctx.ldo.transfer(poolAddress, 100_000n * PRICE_UNIT)

      expect(await ctx.pool.balances(0)).to.equal(reserveBefore)
      expect(await ctx.harness.poolTvlUsd(ctx.prices.ldoUsd, ctx.prices.stEthUsd)).to.equal(
        tvlBefore
      )
    })
  })

  describe('wrap and unwrap against the live share rate', function () {
    it('should wrap the stETH leg into wstETH at the live share rate', async function () {
      const ctx = await loadFixture(deepOnOracleFixture)
      if (ctx === undefined) return this.skip()

      const stEthFund = 2n * PRICE_UNIT
      const ldoFund = balancedLdoFor(ctx, stEthFund)
      await fundForkExecutor(ctx, { stEth: stEthFund, ldo: ldoFund })

      const stEthBalance: bigint = await ctx.stEth.balanceOf(await ctx.buybackExecutor.getAddress())
      const [, balancedStEthLeg] = await ctx.harness.computeBalancedAmounts(
        ldoFund,
        stEthBalance,
        ctx.prices.ldoUsd,
        ctx.prices.stEthUsd
      )

      const addReceipt = await (
        await ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
      ).wait()
      const added = liquidityAddedArgs(ctx, addReceipt!.logs)

      // wstETH minted equals the stETH leg divided by the live share rate, rounded down by ≤1 wei.
      const expectedWstEth = (balancedStEthLeg * PRICE_UNIT) / ctx.prices.shareRate
      expect(added.wstEthAmount).to.be.closeTo(expectedWstEth, 2n)
    })
  })
})
