import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'

import {
  deployBuybackExecutorWithStubs,
  deployBuybackExecutorTreasuryMode,
  fundExecutor,
  setOraclePrices,
  setOracleFailure,
  setPoolEma,
  setPoolReserves,
  setShareRate,
  setPoolEmaLdoPerStEth,
  placeTrackedOrder,
  expireOrder,
  recoverTokenFromCalls,
  OracleFailureMode,
  PRICE_UNIT,
  DEFAULT_BOUNDS,
  ADD_LIQUIDITY_STATUS as STATUS,
  DEFAULT_LDO_USD as LDO_USD,
  DEFAULT_STETH_USD as STETH_USD,
  DEFAULT_ORACLE_LDO_PER_STETH as ORACLE_LDO_PER_STETH,
  DEEP_LDO_RESERVE,
  BALANCED_LDO,
  BALANCED_STETH,
} from '../../../helpers/buyback-executor'

describe('BuybackExecutor — internal math', function () {
  describe('_evaluatePoolPriceDivergence', function () {
    it('should return OraclePriceUnavailable with all derived values 0 when prices are unavailable', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await setOracleFailure(ctx, OracleFailureMode.CustomError)

      const divergence = await ctx.harness.evaluatePoolPriceDivergence()
      expect(divergence.status).to.equal(STATUS.OraclePriceUnavailable)
      expect(divergence.ldoUsdPrice).to.equal(0n)
      expect(divergence.stEthUsdPrice).to.equal(0n)
      expect(divergence.oracleLdoPerStEth).to.equal(0n)
      expect(divergence.poolEmaLdoPerStEth).to.equal(0n)
      expect(divergence.divergenceBps).to.equal(0n)
    })

    it('should return the prices, the oracle ratio, the pool EMA, and zero divergence at the default state', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)

      const divergence = await ctx.harness.evaluatePoolPriceDivergence()
      expect(divergence.ldoUsdPrice).to.equal(LDO_USD)
      expect(divergence.stEthUsdPrice).to.equal(STETH_USD)
      expect(divergence.oracleLdoPerStEth).to.equal(ORACLE_LDO_PER_STETH)
      // Default EMA sits on the oracle ratio after the share-rate conversion, so divergence is zero.
      expect(divergence.poolEmaLdoPerStEth).to.equal(ORACLE_LDO_PER_STETH)
      expect(divergence.divergenceBps).to.equal(0n)
      // Default reserves are zero, so the TVL is below the floor and the deposit stays eligible.
      expect(divergence.status).to.equal(STATUS.Eligible)
    })

    it('should return InvalidOraclePrice when the oracle LDO/stETH ratio truncates to 0', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      // stEthUsd far below ldoUsd makes mulDiv(stEthUsd, PRICE_UNIT, ldoUsd) floor to 0.
      await setOraclePrices(ctx, 2n * PRICE_UNIT, 1n)

      const divergence = await ctx.harness.evaluatePoolPriceDivergence()
      expect(divergence.status).to.equal(STATUS.InvalidOraclePrice)
      expect(divergence.ldoUsdPrice).to.equal(2n * PRICE_UNIT)
      expect(divergence.stEthUsdPrice).to.equal(1n)
      expect(divergence.oracleLdoPerStEth).to.equal(0n)
      expect(divergence.poolEmaLdoPerStEth).to.equal(0n)
      expect(divergence.divergenceBps).to.equal(0n)
    })

    it('should compute the pool EMA as mulDiv(price_oracle, PRICE_UNIT, stEthPerToken)', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await setShareRate(ctx, 2n * PRICE_UNIT)
      await setPoolEma(ctx, 3000n * PRICE_UNIT)

      const divergence = await ctx.harness.evaluatePoolPriceDivergence()
      // 3000e18 LDO per wstETH at a 2.0 share rate is 1500e18 LDO per stETH.
      expect(divergence.poolEmaLdoPerStEth).to.equal(1500n * PRICE_UNIT)
    })

    it('should compute divergenceBps rounded up for both orderings of the pool EMA and the oracle ratio', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)

      // 1 LDO/stETH wei of divergence: 1e18 * 10000 / 1750e18 = 5.714.., rounded up to 6 bps.
      await setPoolEmaLdoPerStEth(ctx, ORACLE_LDO_PER_STETH + PRICE_UNIT)
      expect((await ctx.harness.evaluatePoolPriceDivergence()).divergenceBps).to.equal(6n)

      await setPoolEmaLdoPerStEth(ctx, ORACLE_LDO_PER_STETH - PRICE_UNIT)
      expect((await ctx.harness.evaluatePoolPriceDivergence()).divergenceBps).to.equal(6n)
    })

    it('should score max divergence when the pool EMA is 0', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await setPoolEma(ctx, 0n)

      const divergence = await ctx.harness.evaluatePoolPriceDivergence()
      expect(divergence.poolEmaLdoPerStEth).to.equal(0n)
      // Full deviation from the non-zero oracle ratio rounds to 10000 bps.
      expect(divergence.divergenceBps).to.equal(10_000n)
    })

    it('should return Eligible regardless of divergence when the pool TVL is below the floor', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      // 1925e18 vs the 1750e18 oracle ratio is 1000 bps, ten times the default tolerance.
      await setPoolEmaLdoPerStEth(ctx, 1925n * PRICE_UNIT)

      const divergence = await ctx.harness.evaluatePoolPriceDivergence()
      expect(divergence.divergenceBps).to.equal(1000n)
      // Reserves are zero, so the gate is bypassed and the deposit stays eligible.
      expect(divergence.status).to.equal(STATUS.Eligible)
    })

    it('should return PoolPriceDivergenceTooHigh past tolerance with a deep pool and Eligible at the tolerance, always carrying divergenceBps', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await setPoolReserves(ctx, DEEP_LDO_RESERVE, 0n)
      await setPoolEmaLdoPerStEth(ctx, 1925n * PRICE_UNIT)

      const gated = await ctx.harness.evaluatePoolPriceDivergence()
      expect(gated.status).to.equal(STATUS.PoolPriceDivergenceTooHigh)
      expect(gated.divergenceBps).to.equal(1000n)

      // Raising the tolerance to the exact divergence makes the same deep, divergent pool eligible.
      await ctx.buybackExecutor.connect(ctx.signers.admin).setPoolPriceDivergenceToleranceBps(1000n)
      const eligible = await ctx.harness.evaluatePoolPriceDivergence()
      expect(eligible.status).to.equal(STATUS.Eligible)
      expect(eligible.divergenceBps).to.equal(1000n)
    })
  })

  describe('_evaluateAddLiquidityGates', function () {
    it('should return NotInLpMode in treasury mode before any balance or oracle read', async function () {
      const ctx = await loadFixture(deployBuybackExecutorTreasuryMode)

      const evaluation = await ctx.harness.evaluateAddLiquidityGates()
      expect(evaluation.status).to.equal(STATUS.NotInLpMode)
      expect(evaluation.ldoAmount).to.equal(0n)
      expect(evaluation.stEthAmount).to.equal(0n)
      expect(evaluation.depositValueUsd).to.equal(0n)
    })

    it('should return ZeroLdoBalance, then ZeroStEthBalance, in that precedence order', async function () {
      const emptyCtx = await loadFixture(deployBuybackExecutorWithStubs)
      expect((await emptyCtx.harness.evaluateAddLiquidityGates()).status).to.equal(
        STATUS.ZeroLdoBalance
      )

      const ldoOnlyCtx = await loadFixture(deployBuybackExecutorWithStubs)
      await fundExecutor(ldoOnlyCtx, { ldo: BALANCED_LDO })
      expect((await ldoOnlyCtx.harness.evaluateAddLiquidityGates()).status).to.equal(
        STATUS.ZeroStEthBalance
      )
    })

    it('should propagate OraclePriceUnavailable from the divergence gate', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await fundExecutor(ctx, { ldo: BALANCED_LDO, stEth: BALANCED_STETH })
      await setOracleFailure(ctx, OracleFailureMode.CustomError)

      expect((await ctx.harness.evaluateAddLiquidityGates()).status).to.equal(
        STATUS.OraclePriceUnavailable
      )
    })

    it('should propagate InvalidOraclePrice from the divergence gate', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await fundExecutor(ctx, { ldo: BALANCED_LDO, stEth: BALANCED_STETH })
      await setOraclePrices(ctx, 2n * PRICE_UNIT, 1n)

      expect((await ctx.harness.evaluateAddLiquidityGates()).status).to.equal(
        STATUS.InvalidOraclePrice
      )
    })

    it('should propagate PoolPriceDivergenceTooHigh and carry the divergence values', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await fundExecutor(ctx, { ldo: BALANCED_LDO, stEth: BALANCED_STETH })
      await setPoolReserves(ctx, DEEP_LDO_RESERVE, 0n)
      await setPoolEmaLdoPerStEth(ctx, 1925n * PRICE_UNIT)

      const evaluation = await ctx.harness.evaluateAddLiquidityGates()
      expect(evaluation.status).to.equal(STATUS.PoolPriceDivergenceTooHigh)
      expect(evaluation.ldoPerStEth).to.equal(ORACLE_LDO_PER_STETH)
      expect(evaluation.poolEmaLdoPerStEth).to.equal(1925n * PRICE_UNIT)
      expect(evaluation.divergenceBps).to.equal(1000n)
    })

    it('should return DepositValueBelowMinimum with the under-floor value when balances are dust', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await fundExecutor(ctx, { ldo: 1n, stEth: 1n })

      const evaluation = await ctx.harness.evaluateAddLiquidityGates()
      expect(evaluation.status).to.equal(STATUS.DepositValueBelowMinimum)
      // ldoUsdValue = 2 wei is the smaller leg, so depositValueUsd = 4 wei, below the 100e18 floor.
      expect(evaluation.depositValueUsd).to.equal(4n)
    })

    it('should cap both legs by mulDiv(amount, maxDepositValueUsd, depositValueUsd) above the cap', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      // Uncapped depositValueUsd = 400000e18, four times the cap, so both balanced legs scale to a quarter.
      const ldoFunded = 100_000n * PRICE_UNIT
      const stEthFunded = 100n * PRICE_UNIT
      await fundExecutor(ctx, { ldo: ldoFunded, stEth: stEthFunded })

      const cap = DEFAULT_BOUNDS.maxDepositValueUsd
      const uncapped = await ctx.harness.computeBalancedAmounts(
        ldoFunded,
        stEthFunded,
        LDO_USD,
        STETH_USD
      )

      const evaluation = await ctx.harness.evaluateAddLiquidityGates()
      expect(evaluation.status).to.equal(STATUS.Eligible)
      expect(evaluation.depositValueUsd).to.equal(400_000n * PRICE_UNIT)
      expect(evaluation.ldoAmount).to.equal((uncapped.ldoAmount * cap) / uncapped.depositValueUsd)
      expect(evaluation.stEthAmount).to.equal(
        (uncapped.stEthAmount * cap) / uncapped.depositValueUsd
      )
    })

    it('should leave both legs unscaled at exactly the cap', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      // ldoUsdValue = 50000e18 is the smaller leg, so depositValueUsd = 100000e18 = the cap.
      const ldoFunded = 25_000n * PRICE_UNIT
      await fundExecutor(ctx, { ldo: ldoFunded, stEth: 20n * PRICE_UNIT })

      const evaluation = await ctx.harness.evaluateAddLiquidityGates()
      expect(evaluation.status).to.equal(STATUS.Eligible)
      expect(evaluation.depositValueUsd).to.equal(DEFAULT_BOUNDS.maxDepositValueUsd)
      expect(evaluation.ldoAmount).to.equal(ldoFunded)
    })

    it('should carry the prices and zero divergence into an eligible evaluation', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await fundExecutor(ctx, { ldo: BALANCED_LDO, stEth: BALANCED_STETH })

      const evaluation = await ctx.harness.evaluateAddLiquidityGates()
      expect(evaluation.status).to.equal(STATUS.Eligible)
      expect(evaluation.ldoPerStEth).to.equal(ORACLE_LDO_PER_STETH)
      expect(evaluation.poolEmaLdoPerStEth).to.equal(ORACLE_LDO_PER_STETH)
      expect(evaluation.divergenceBps).to.equal(0n)
    })
  })

  describe('_computeBalancedAmounts', function () {
    it('should size by LDO when the LDO leg holds no more USD than the stETH leg', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const ldoBalance = 100n * PRICE_UNIT
      const stEthBalance = 1n * PRICE_UNIT

      const balanced = await ctx.harness.computeBalancedAmounts(
        ldoBalance,
        stEthBalance,
        LDO_USD,
        STETH_USD
      )
      expect(balanced.ldoAmount).to.equal(ldoBalance)
      expect(balanced.stEthAmount).to.equal((ldoBalance * LDO_USD) / STETH_USD)
      expect(balanced.depositValueUsd).to.equal(((ldoBalance * LDO_USD) / PRICE_UNIT) * 2n)
    })

    it('should size by stETH when the stETH leg holds less USD', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const ldoBalance = 10_000n * PRICE_UNIT
      const stEthBalance = PRICE_UNIT / 1000n

      const balanced = await ctx.harness.computeBalancedAmounts(
        ldoBalance,
        stEthBalance,
        LDO_USD,
        STETH_USD
      )
      expect(balanced.stEthAmount).to.equal(stEthBalance)
      expect(balanced.ldoAmount).to.equal((stEthBalance * STETH_USD) / LDO_USD)
      expect(balanced.depositValueUsd).to.equal(((stEthBalance * STETH_USD) / PRICE_UNIT) * 2n)
    })

    it('should produce two USD legs equal within one stETH wei of value', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const ldoBalance = 100n * PRICE_UNIT
      const stEthBalance = 1n * PRICE_UNIT

      const balanced = await ctx.harness.computeBalancedAmounts(
        ldoBalance,
        stEthBalance,
        LDO_USD,
        STETH_USD
      )
      const ldoLegUsd = (balanced.ldoAmount * LDO_USD) / PRICE_UNIT
      const stEthLegUsd = (balanced.stEthAmount * STETH_USD) / PRICE_UNIT
      // The stETH leg truncates down by at most one stETH wei, worth STETH_USD / PRICE_UNIT in USD.
      expect(stEthLegUsd).to.be.closeTo(ldoLegUsd, STETH_USD / PRICE_UNIT)
    })

    it('should take the LDO branch when the two USD legs tie', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      // 3500 LDO at 2 USD and 2 stETH at 3500 USD both value 7000e18, an exact tie.
      const ldoBalance = 3500n * PRICE_UNIT
      const stEthBalance = 2n * PRICE_UNIT

      const balanced = await ctx.harness.computeBalancedAmounts(
        ldoBalance,
        stEthBalance,
        LDO_USD,
        STETH_USD
      )
      expect(balanced.ldoAmount).to.equal(ldoBalance)
      expect(balanced.stEthAmount).to.equal((ldoBalance * LDO_USD) / STETH_USD)
      expect(balanced.depositValueUsd).to.equal(14_000n * PRICE_UNIT)
    })
  })

  describe('_poolTvlUsd', function () {
    it('should value the LDO reserve as mulDiv(balances(0), ldoUsd, PRICE_UNIT)', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await setPoolReserves(ctx, DEEP_LDO_RESERVE, 0n)

      expect(await ctx.harness.poolTvlUsd(LDO_USD, STETH_USD)).to.equal(
        (DEEP_LDO_RESERVE * LDO_USD) / PRICE_UNIT
      )
    })

    it('should sum the LDO leg and the share-rate-converted stETH leg', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const ldoReserve = 10_000n * PRICE_UNIT
      const wstEthReserve = 5n * PRICE_UNIT
      await setPoolReserves(ctx, ldoReserve, wstEthReserve)

      const stEthReserve = await ctx.stubs.wstEth.getStETHByWstETH(wstEthReserve)
      const expectedTvl =
        (ldoReserve * LDO_USD) / PRICE_UNIT + (stEthReserve * STETH_USD) / PRICE_UNIT
      expect(await ctx.harness.poolTvlUsd(LDO_USD, STETH_USD)).to.equal(expectedTvl)
    })

    it('should read the pool internal balances, so a direct token donation does not inflate the TVL', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await setPoolReserves(ctx, DEEP_LDO_RESERVE, 0n)
      const baseline = await ctx.harness.poolTvlUsd(LDO_USD, STETH_USD)

      // Donating LDO straight to the pool moves balanceOf but not the reported reserves.
      const poolAddress = await ctx.stubs.pool.getAddress()
      await ctx.stubs.ldo.connect(ctx.signers.admin).mint(poolAddress, DEEP_LDO_RESERVE)

      expect(await ctx.harness.poolTvlUsd(LDO_USD, STETH_USD)).to.equal(baseline)
    })
  })

  describe('_computeLpModeFreeStEth', function () {
    it('should subtract the stETH value of held LDO', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const ldoBalance = 3500n * PRICE_UNIT
      const stEthBalance = 10n * PRICE_UNIT
      await fundExecutor(ctx, { ldo: ldoBalance, stEth: stEthBalance })

      // ldoInStEth = mulDiv(3500e18, 2e18, 3500e18) = 2e18, leaving 8e18 free.
      const ldoInStEth = (ldoBalance * LDO_USD) / STETH_USD
      expect(await ctx.harness.computeLpModeFreeStEth()).to.equal(stEthBalance - ldoInStEth)
    })

    it('should subtract stETH held on the Stonks', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const stEthBalance = 10n * PRICE_UNIT
      const stonksBalance = 3n * PRICE_UNIT
      await fundExecutor(ctx, { stEth: stEthBalance })
      await ctx.stubs.stEth
        .connect(ctx.signers.admin)
        .mint(await ctx.stubs.stonks.getAddress(), stonksBalance)

      expect(await ctx.harness.computeLpModeFreeStEth()).to.equal(stEthBalance - stonksBalance)
    })

    it('should subtract the residual stETH on the tracked order', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await fundExecutor(ctx, { stEth: 2000n * PRICE_UNIT })

      // placeTrackedOrder seeds the Stonks with maxAllowedOrderAmount, subtracted below the balance.
      const orderAddress = await placeTrackedOrder(ctx)
      const freeBeforeResidual = await ctx.harness.computeLpModeFreeStEth()
      expect(freeBeforeResidual).to.equal(2000n * PRICE_UNIT - DEFAULT_BOUNDS.maxAllowedOrderAmount)

      const residual = 50n * PRICE_UNIT
      await ctx.stubs.stEth.connect(ctx.signers.admin).mint(orderAddress, residual)
      expect(await ctx.harness.computeLpModeFreeStEth()).to.equal(freeBeforeResidual - residual)
    })

    it('should saturate to 0 when the subtractions exceed the stETH balance', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      // The held LDO is worth far more stETH than the small stETH balance, so free saturates to 0.
      await fundExecutor(ctx, { ldo: 100_000n * PRICE_UNIT, stEth: 1n * PRICE_UNIT })

      expect(await ctx.harness.computeLpModeFreeStEth()).to.equal(0n)
    })

    it('should return 0 when LDO is held and oracle prices are unavailable', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await fundExecutor(ctx, { ldo: 3500n * PRICE_UNIT, stEth: 10n * PRICE_UNIT })
      await setOracleFailure(ctx, OracleFailureMode.CustomError)

      expect(await ctx.harness.computeLpModeFreeStEth()).to.equal(0n)
    })

    it('should skip the price read when the LDO balance is 0', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const stEthBalance = 10n * PRICE_UNIT
      await fundExecutor(ctx, { stEth: stEthBalance })
      // Oracle reverts, yet with no LDO held the price branch is skipped and the balance is returned.
      await setOracleFailure(ctx, OracleFailureMode.CustomError)

      expect(await ctx.harness.computeLpModeFreeStEth()).to.equal(stEthBalance)
    })
  })

  describe('_sweepExpiredOrder', function () {
    it('should be a no-op when lastOrderAddress is zero', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      expect(await ctx.buybackExecutor.lastOrderAddress()).to.equal(ethers.ZeroAddress)

      // onStEthAllocated runs the sweep first. With a zero pointer it returns early, so no
      // StaleOrderCleared fires and the pointer is untouched.
      await expect(
        ctx.buybackExecutor.connect(ctx.signers.allocator).onStEthAllocated()
      ).to.not.emit(ctx.buybackExecutor, 'StaleOrderCleared')

      expect(await ctx.buybackExecutor.lastOrderAddress()).to.equal(ethers.ZeroAddress)
    })

    it('should be a no-op when the tracked order is still live', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const orderAddress = await placeTrackedOrder(ctx)
      const validTo = await ctx.buybackExecutor.lastOrderValidTo()

      // The order has not expired, so the sweep returns before clearing the pointer or recovering.
      await expect(
        ctx.buybackExecutor.connect(ctx.signers.allocator).onStEthAllocated()
      ).to.not.emit(ctx.buybackExecutor, 'StaleOrderCleared')

      expect(await ctx.buybackExecutor.lastOrderAddress()).to.equal(orderAddress)
      expect(await ctx.buybackExecutor.lastOrderValidTo()).to.equal(validTo)
      expect(await recoverTokenFromCalls(orderAddress)).to.equal(0n)
    })

    it('should clear the pointer, emit StaleOrderCleared(order), and recover the residual when expired', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const orderAddress = await placeTrackedOrder(ctx)
      await expireOrder(ctx)
      // Residual at the recovery threshold so the sweep both clears tracking and recovers.
      await ctx.stubs.stEth.connect(ctx.signers.admin).mint(orderAddress, 10n)

      await expect(ctx.buybackExecutor.connect(ctx.signers.allocator).onStEthAllocated())
        .to.emit(ctx.buybackExecutor, 'StaleOrderCleared')
        .withArgs(orderAddress)

      expect(await ctx.buybackExecutor.lastOrderAddress()).to.equal(ethers.ZeroAddress)
      expect(await ctx.buybackExecutor.lastOrderValidTo()).to.equal(0n)
      expect(await recoverTokenFromCalls(orderAddress)).to.equal(1n)
    })

    it('should clear the pointer before the external recoverTokenFrom call', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const orderAddress = await placeTrackedOrder(ctx)
      await expireOrder(ctx)
      // Residual above the recovery threshold so the sweep makes the recoverTokenFrom call.
      await ctx.stubs.stEth.connect(ctx.signers.admin).mint(orderAddress, 1000n)

      const tx = await ctx.buybackExecutor.connect(ctx.signers.allocator).onStEthAllocated()
      const receipt = await tx.wait()

      const executorAddress = await ctx.buybackExecutor.getAddress()
      const clearedTopic = ctx.buybackExecutor.interface.getEvent('StaleOrderCleared')!.topicHash

      // The sweep writes the zero pointer, emits StaleOrderCleared, then calls recoverTokenFrom.
      // StaleOrderCleared landing before the order's RecoverTokenFromCalled proves the pointer is
      // cleared before the external call.
      const sequence = receipt!.logs
        .filter(
          (log) =>
            (log.address === executorAddress && log.topics[0] === clearedTopic) ||
            log.address === orderAddress
        )
        .map((log) => (log.address === orderAddress ? 'recovered' : 'cleared'))

      expect(sequence).to.deep.equal(['cleared', 'recovered'])
      expect(await ctx.buybackExecutor.lastOrderAddress()).to.equal(ethers.ZeroAddress)
    })
  })

  describe('_sweepExpiredOrder residual boundary (via placeOrder)', function () {
    it('should skip recoverTokenFrom at residual 9 and call it at residual 10', async function () {
      const belowCtx = await loadFixture(deployBuybackExecutorWithStubs)
      const belowOrder = await placeTrackedOrder(belowCtx)
      await expireOrder(belowCtx)
      await belowCtx.stubs.stEth.connect(belowCtx.signers.admin).mint(belowOrder, 9n)
      await belowCtx.buybackExecutor.connect(belowCtx.signers.stranger).placeOrder()
      expect(await recoverTokenFromCalls(belowOrder)).to.equal(0n)

      const atCtx = await loadFixture(deployBuybackExecutorWithStubs)
      const atOrder = await placeTrackedOrder(atCtx)
      await expireOrder(atCtx)
      await atCtx.stubs.stEth.connect(atCtx.signers.admin).mint(atOrder, 10n)
      await atCtx.buybackExecutor.connect(atCtx.signers.stranger).placeOrder()
      expect(await recoverTokenFromCalls(atOrder)).to.equal(1n)
    })
  })
})
