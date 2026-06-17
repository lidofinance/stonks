import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'

import {
  deployBuybackExecutorWithStubs,
  fundExecutor,
  setOracleFailure,
  setPoolEma,
  setPoolReserves,
  placeTrackedOrder,
  expireOrder,
  OracleFailureMode,
  PRICE_SCALE,
  DEFAULT_BOUNDS,
  BuybackContext,
} from '../helpers/buyback-executor'

const ZERO_ADDRESS = ethers.ZeroAddress

// Default oracle USD prices the stub fixture configures.
const LDO_USD = 2n * PRICE_SCALE
const STETH_USD = 3500n * PRICE_SCALE

const MIN_DEPOSIT_USD = DEFAULT_BOUNDS.minDepositValueUsd
const MAX_DEPOSIT_USD = DEFAULT_BOUNDS.maxDepositValueUsd
const MIN_ORDER = DEFAULT_BOUNDS.minAllowedOrderAmount
const MAX_ORDER = DEFAULT_BOUNDS.maxAllowedOrderAmount

// Reserves whose oracle-valued TVL (100000e18) sits above the 50000e18 bootstrap floor, so the
// divergence gate is enforced. The EMA stays on the oracle ratio unless a test moves it.
const DEEP_LDO_RESERVE = 50_000n * PRICE_SCALE

// LP held and the amounts the pool returns on a withdrawal.
const LP_BALANCE = 1000n * PRICE_SCALE
const WITHDRAWN_LDO = 500n * PRICE_SCALE
const WITHDRAWN_WSTETH = 10n * PRICE_SCALE

// Reference integer math mirroring the contract, all floor.
const usdValue = (amount: bigint, price: bigint): bigint => (amount * price) / PRICE_SCALE
const saturatedSub = (a: bigint, b: bigint): bigint => (a > b ? a - b : 0n)
const withinInclusive = (value: bigint, low: bigint, high: bigint): boolean =>
  value >= low && value <= high

// USD value of a balanced deposit pair at the default prices.
const depositUsdFromLegs = (ldoLeg: bigint, stEthLeg: bigint): bigint =>
  usdValue(ldoLeg, LDO_USD) + usdValue(stEthLeg, STETH_USD)

// Moves the pool EMA off the oracle ratio by the given multiplier, scaled by 100.
async function scalePoolEma(ctx: BuybackContext, percent: bigint): Promise<void> {
  const currentEma = await ctx.stubs.pool.priceOracleValue()
  await setPoolEma(ctx, (currentEma * percent) / 100n)
}

describe('BuybackExecutor — invariants', function () {
  describe('deposit value bounds', function () {
    it('should cap every addLiquidity at maxDepositValueUsd while draining a large balance', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      // Uncapped value 400000e18 is four times the cap, so four successive calls each deposit the
      // cap and the fourth drains the LDO leg to zero.
      await fundExecutor(ctx, { ldo: 100_000n * PRICE_SCALE, stEth: 100n * PRICE_SCALE })
      await setPoolReserves(ctx, DEEP_LDO_RESERVE, 0n)
      const executorAddress = await ctx.buybackExecutor.getAddress()

      // The cap scales the LDO leg to 25000e18 on each of the four full-cap calls.
      const cappedLdoLeg = 25_000n * PRICE_SCALE

      for (let call = 0; call < 4; call += 1) {
        const evaluation = await ctx.harness.evaluateAddLiquidityGates()
        const depositedUsd = depositUsdFromLegs(evaluation.ldoAmount, evaluation.stEthAmount)

        expect(evaluation.ldoAmount).to.equal(cappedLdoLeg)
        expect(withinInclusive(depositedUsd, MIN_DEPOSIT_USD, MAX_DEPOSIT_USD)).to.equal(true)

        await ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
      }

      expect(await ctx.stubs.ldo.balanceOf(executorAddress)).to.equal(0n)
      expect(await ctx.buybackExecutor.canAddLiquidity()).to.equal(false)
    })

    it('should reject any deposit whose balanced value is below minDepositValueUsd', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      // ldoUsdValue = 2 wei is the smaller leg, so the balanced value is 4 wei, far below the floor.
      await fundExecutor(ctx, { ldo: 1n, stEth: 1n })
      await setPoolReserves(ctx, DEEP_LDO_RESERVE, 0n)

      await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity())
        .to.be.revertedWithCustomError(ctx.buybackExecutor, 'DepositValueBelowMinimum')
        .withArgs(4n, MIN_DEPOSIT_USD)
    })
  })

  describe('free stETH accounting', function () {
    it('should keep _computeLpModeFreeStEth at or below the stETH balance across funding states', async function () {
      const stEthBalance = 100n * PRICE_SCALE
      const ldoBalance = 3500n * PRICE_SCALE
      const stonksStEth = 10n * PRICE_SCALE

      // Only stETH: nothing is reserved, so the free amount equals the balance.
      const onlyStEth = await loadFixture(deployBuybackExecutorWithStubs)
      await fundExecutor(onlyStEth, { stEth: stEthBalance })
      const onlyStEthFree = await onlyStEth.harness.computeLpModeFreeStEth()
      expect(onlyStEthFree).to.equal(stEthBalance)
      expect(onlyStEthFree <= stEthBalance).to.equal(true)

      // Held LDO is reserved in stETH terms before the balance is freed.
      const withLdo = await loadFixture(deployBuybackExecutorWithStubs)
      await fundExecutor(withLdo, { ldo: ldoBalance, stEth: stEthBalance })
      const ldoInStEth = (ldoBalance * LDO_USD) / STETH_USD
      const withLdoExpected = saturatedSub(stEthBalance, ldoInStEth)
      const withLdoFree = await withLdo.harness.computeLpModeFreeStEth()
      expect(withLdoFree).to.equal(withLdoExpected)
      expect(withLdoFree <= stEthBalance).to.equal(true)

      // stETH parked on Stonks is also subtracted from the free amount.
      const withStonks = await loadFixture(deployBuybackExecutorWithStubs)
      await fundExecutor(withStonks, { ldo: ldoBalance, stEth: stEthBalance })
      await withStonks.stubs.stEth
        .connect(withStonks.signers.admin)
        .mint(await withStonks.stubs.stonks.getAddress(), stonksStEth)
      const withStonksExpected = saturatedSub(saturatedSub(stEthBalance, ldoInStEth), stonksStEth)
      const withStonksFree = await withStonks.harness.computeLpModeFreeStEth()
      expect(withStonksFree).to.equal(withStonksExpected)
      expect(withStonksFree <= stEthBalance).to.equal(true)

      // A missing oracle price collapses the reserve calculation to zero free stETH.
      const oracleDown = await loadFixture(deployBuybackExecutorWithStubs)
      await fundExecutor(oracleDown, { ldo: ldoBalance, stEth: stEthBalance })
      await setOracleFailure(oracleDown, OracleFailureMode.CustomError)
      const oracleDownFree = await oracleDown.harness.computeLpModeFreeStEth()
      expect(oracleDownFree).to.equal(0n)
      expect(oracleDownFree <= stEthBalance).to.equal(true)
    })
  })

  describe('single tracked order', function () {
    it('should never track a second live order while one is in place', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const firstOrder = await placeTrackedOrder(ctx)
      const firstValidTo = await ctx.buybackExecutor.lastOrderValidTo()

      // A live order blocks placement, so the tracked pointer cannot split into two.
      await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).placeOrder())
        .to.be.revertedWithCustomError(ctx.buybackExecutor, 'LiveOrderInPlace')
        .withArgs(firstOrder, firstValidTo)
      expect(await ctx.buybackExecutor.lastOrderAddress()).to.equal(firstOrder)

      // Once expired the pointer is replaced, never appended to.
      await expireOrder(ctx)
      const secondOrder = await placeTrackedOrder(ctx)
      expect(secondOrder).to.not.equal(firstOrder)
      expect(secondOrder).to.not.equal(ZERO_ADDRESS)
      expect(await ctx.buybackExecutor.lastOrderAddress()).to.equal(secondOrder)
    })
  })

  describe('removal recipient', function () {
    it('should send withdrawn LDO and stETH only to TREASURY', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const executorAddress = await ctx.buybackExecutor.getAddress()
      const treasuryAddress = await ctx.signers.treasury.getAddress()
      const managerAddress = await ctx.signers.manager.getAddress()
      const stonksAddress = await ctx.stubs.stonks.getAddress()

      await ctx.stubs.pool.connect(ctx.signers.admin).mint(executorAddress, LP_BALANCE)
      await ctx.stubs.pool
        .connect(ctx.signers.admin)
        .setNextWithdrawn(WITHDRAWN_LDO, WITHDRAWN_WSTETH)
      const expectedStEth = await ctx.stubs.wstEth.getStETHByWstETH(WITHDRAWN_WSTETH)

      await ctx.buybackExecutor
        .connect(ctx.signers.manager)
        .removeLiquidityAndRecoverToTreasury(LP_BALANCE, 0n, 0n)

      expect(await ctx.stubs.ldo.balanceOf(treasuryAddress)).to.equal(WITHDRAWN_LDO)
      expect(await ctx.stubs.stEth.balanceOf(treasuryAddress)).to.equal(expectedStEth)

      // The executor passes the assets through and no other party receives any.
      expect(await ctx.stubs.ldo.balanceOf(executorAddress)).to.equal(0n)
      expect(await ctx.stubs.stEth.balanceOf(executorAddress)).to.equal(0n)
      expect(await ctx.stubs.ldo.balanceOf(managerAddress)).to.equal(0n)
      expect(await ctx.stubs.stEth.balanceOf(managerAddress)).to.equal(0n)
      expect(await ctx.stubs.ldo.balanceOf(stonksAddress)).to.equal(0n)
      expect(await ctx.stubs.stEth.balanceOf(stonksAddress)).to.equal(0n)
    })
  })

  describe('order sizing bounds', function () {
    it('should keep every placed order sellAmount within [minAllowedOrderAmount, maxAllowedOrderAmount]', async function () {
      const stonksBalances = [MIN_ORDER, 500n * PRICE_SCALE, 2000n * PRICE_SCALE]

      for (const balance of stonksBalances) {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await ctx.stubs.stEth
          .connect(ctx.signers.admin)
          .mint(await ctx.stubs.stonks.getAddress(), balance)
        await ctx.stubs.stonks.connect(ctx.signers.admin).setEstimatedOutput(1n)

        await ctx.buybackExecutor.connect(ctx.signers.stranger).placeOrder()

        const expectedSell = balance > MAX_ORDER ? MAX_ORDER : balance
        const sellAmount = await ctx.stubs.stonks.lastSellAmount()
        expect(sellAmount).to.equal(expectedSell)
        expect(withinInclusive(sellAmount, MIN_ORDER, MAX_ORDER)).to.equal(true)
      }
    })

    it('should reject placement when the sized sell is below minAllowedOrderAmount', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const belowMin = MIN_ORDER - 1n
      await ctx.stubs.stEth
        .connect(ctx.signers.admin)
        .mint(await ctx.stubs.stonks.getAddress(), belowMin)
      await ctx.stubs.stonks.connect(ctx.signers.admin).setEstimatedOutput(1n)

      await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).placeOrder())
        .to.be.revertedWithCustomError(ctx.buybackExecutor, 'InsufficientStonksBalance')
        .withArgs(belowMin, MIN_ORDER)
    })
  })

  describe('limit ordering', function () {
    it('should keep min strictly below max for orders and deposits after any setter sequence', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const admin = ctx.signers.admin

      const assertOrdering = async (): Promise<void> => {
        const minOrder = await ctx.buybackExecutor.minAllowedOrderAmount()
        const maxOrder = await ctx.buybackExecutor.maxAllowedOrderAmount()
        const minDeposit = await ctx.buybackExecutor.minDepositValueUsd()
        const maxDeposit = await ctx.buybackExecutor.maxDepositValueUsd()
        expect(minOrder < maxOrder).to.equal(true)
        expect(minDeposit < maxDeposit).to.equal(true)
      }

      await ctx.buybackExecutor.connect(admin).setMaxAllowedOrderAmount(2000n * PRICE_SCALE)
      await assertOrdering()
      await ctx.buybackExecutor.connect(admin).setMinAllowedOrderAmount(5n * PRICE_SCALE)
      await assertOrdering()
      await ctx.buybackExecutor.connect(admin).setMaxDepositValueUsd(200_000n * PRICE_SCALE)
      await assertOrdering()
      await ctx.buybackExecutor.connect(admin).setMinDepositValueUsd(50_000n * PRICE_SCALE)
      await assertOrdering()

      // A setter that would break the ordering reverts and leaves the bounds intact.
      const maxOrder = await ctx.buybackExecutor.maxAllowedOrderAmount()
      await expect(
        ctx.buybackExecutor.connect(admin).setMinAllowedOrderAmount(maxOrder)
      ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'InvalidOrderAmountLimits')
      const minDeposit = await ctx.buybackExecutor.minDepositValueUsd()
      await expect(
        ctx.buybackExecutor.connect(admin).setMaxDepositValueUsd(minDeposit)
      ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'InvalidDepositValueLimits')

      await assertOrdering()
    })
  })

  describe('divergence gate', function () {
    it('should never deposit when divergence exceeds tolerance and the pool TVL reaches the floor', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await fundExecutor(ctx, { ldo: 1750n * PRICE_SCALE, stEth: 1n * PRICE_SCALE })
      await setPoolReserves(ctx, DEEP_LDO_RESERVE, 0n)

      // A 5% deviation scores 500 bps, well past the 100 bps tolerance, on a deep pool.
      await scalePoolEma(ctx, 105n)
      expect(await ctx.buybackExecutor.canAddLiquidity()).to.equal(false)
      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
      ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'PoolPriceDivergenceTooHigh')

      // A far larger deviation is gated just the same.
      await scalePoolEma(ctx, 300n)
      expect(await ctx.buybackExecutor.canAddLiquidity()).to.equal(false)
      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
      ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'PoolPriceDivergenceTooHigh')
    })

    it('should never let divergence block a deposit while the pool TVL is below the floor', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      // Default reserves are zero, so the TVL is below the floor and divergence is bypassed.
      await fundExecutor(ctx, { ldo: 1750n * PRICE_SCALE, stEth: 1n * PRICE_SCALE })

      await scalePoolEma(ctx, 105n)
      await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()).to.emit(
        ctx.buybackExecutor,
        'LiquidityAdded'
      )

      await fundExecutor(ctx, { ldo: 1750n * PRICE_SCALE, stEth: 1n * PRICE_SCALE })
      await scalePoolEma(ctx, 300n)
      await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()).to.emit(
        ctx.buybackExecutor,
        'LiquidityAdded'
      )
    })

    it('should decide the gate from current TVL and divergence alone, holding no state across calls', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await fundExecutor(ctx, { ldo: 1750n * PRICE_SCALE, stEth: 1n * PRICE_SCALE })
      await scalePoolEma(ctx, 105n)

      // Deep and divergent: gated.
      await setPoolReserves(ctx, DEEP_LDO_RESERVE, 0n)
      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
      ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'PoolPriceDivergenceTooHigh')

      // Same divergence, shallow again: the prior gated call left no latch, so it deposits.
      await setPoolReserves(ctx, 0n, 0n)
      await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()).to.emit(
        ctx.buybackExecutor,
        'LiquidityAdded'
      )

      // Deep and divergent again: the prior bypassed call left no latch, so it is gated again.
      await fundExecutor(ctx, { ldo: 1750n * PRICE_SCALE, stEth: 1n * PRICE_SCALE })
      await setPoolReserves(ctx, DEEP_LDO_RESERVE, 0n)
      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
      ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'PoolPriceDivergenceTooHigh')
    })
  })
})
