import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'

import {
  deployBuybackExecutorWithStubs,
  fundExecutor,
  setOracleFailure,
  setPoolReserves,
  scalePoolEma,
  placeTrackedOrder,
  expireOrder,
  OracleFailureMode,
  PRICE_UNIT,
  DEFAULT_BOUNDS,
  DEFAULT_LDO_USD as LDO_USD,
  DEFAULT_STETH_USD as STETH_USD,
  DEEP_LDO_RESERVE,
  LP_BALANCE,
  WITHDRAWN_LDO,
  WITHDRAWN_WSTETH,
  saturatedSub,
} from '../helpers/buyback-executor'

const ZERO_ADDRESS = ethers.ZeroAddress

const MIN_DEPOSIT_USD = DEFAULT_BOUNDS.minDepositValueUsd
const MIN_ORDER = DEFAULT_BOUNDS.minAllowedOrderAmount
const MAX_ORDER = DEFAULT_BOUNDS.maxAllowedOrderAmount

describe('BuybackExecutor — invariants', function () {
  describe('deposit value bounds', function () {
    it('should cap every addLiquidity at maxDepositValueUsd while draining a large balance', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      // Uncapped value 400000e18 is four times the cap, so four successive calls each deposit the
      // cap and the fourth drains the LDO leg to zero.
      await fundExecutor(ctx, { ldo: 100_000n * PRICE_UNIT, stEth: 100n * PRICE_UNIT })
      await setPoolReserves(ctx, DEEP_LDO_RESERVE, 0n)
      const executorAddress = await ctx.buybackExecutor.getAddress()

      // The cap scales the LDO leg to 25000e18 on each of the four full-cap calls.
      const cappedLdoLeg = 25_000n * PRICE_UNIT

      for (let call = 0; call < 4; call += 1) {
        const evaluation = await ctx.harness.evaluateAddLiquidityGates()

        // The capped LDO leg of 25000e18 is exactly half the 100000e18 cap, so the balanced deposit
        // lands on maxDepositValueUsd. Asserting the leg pins the cap without a bound comparison.
        expect(evaluation.ldoAmount).to.equal(cappedLdoLeg)

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
      const stEthBalance = 100n * PRICE_UNIT
      const ldoBalance = 3500n * PRICE_UNIT
      const stonksStEth = 10n * PRICE_UNIT

      // Only stETH: nothing is reserved, so the free amount equals the balance.
      const onlyStEth = await loadFixture(deployBuybackExecutorWithStubs)
      await fundExecutor(onlyStEth, { stEth: stEthBalance })
      const onlyStEthFree = await onlyStEth.harness.computeLpModeFreeStEth()
      expect(onlyStEthFree).to.equal(stEthBalance)

      // Held LDO is reserved in stETH terms before the balance is freed.
      const withLdo = await loadFixture(deployBuybackExecutorWithStubs)
      await fundExecutor(withLdo, { ldo: ldoBalance, stEth: stEthBalance })
      const ldoInStEth = (ldoBalance * LDO_USD) / STETH_USD
      const withLdoExpected = saturatedSub(stEthBalance, ldoInStEth)
      const withLdoFree = await withLdo.harness.computeLpModeFreeStEth()
      expect(withLdoFree).to.equal(withLdoExpected)

      // stETH parked on Stonks is also subtracted from the free amount.
      const withStonks = await loadFixture(deployBuybackExecutorWithStubs)
      await fundExecutor(withStonks, { ldo: ldoBalance, stEth: stEthBalance })
      await withStonks.stubs.stEth
        .connect(withStonks.signers.admin)
        .mint(await withStonks.stubs.stonks.getAddress(), stonksStEth)
      const withStonksExpected = saturatedSub(saturatedSub(stEthBalance, ldoInStEth), stonksStEth)
      const withStonksFree = await withStonks.harness.computeLpModeFreeStEth()
      expect(withStonksFree).to.equal(withStonksExpected)

      // A missing oracle price collapses the reserve calculation to zero free stETH.
      const oracleDown = await loadFixture(deployBuybackExecutorWithStubs)
      await fundExecutor(oracleDown, { ldo: ldoBalance, stEth: stEthBalance })
      await setOracleFailure(oracleDown, OracleFailureMode.CustomError)
      const oracleDownFree = await oracleDown.harness.computeLpModeFreeStEth()
      expect(oracleDownFree).to.equal(0n)
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
    async function placedSellAmount(balance: bigint): Promise<bigint> {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await ctx.stubs.stEth
        .connect(ctx.signers.admin)
        .mint(await ctx.stubs.stonks.getAddress(), balance)
      await ctx.stubs.stonks.connect(ctx.signers.admin).setEstimatedOutput(1n)

      await ctx.buybackExecutor.connect(ctx.signers.stranger).placeOrder()
      return ctx.stubs.stonks.lastSellAmount()
    }

    it('should size the order to the stonks balance at the minimum', async function () {
      expect(await placedSellAmount(MIN_ORDER)).to.equal(MIN_ORDER)
    })

    it('should size the order to a stonks balance between the bounds', async function () {
      const balance = 500n * PRICE_UNIT
      expect(await placedSellAmount(balance)).to.equal(balance)
    })

    it('should clamp a stonks balance above the cap to maxAllowedOrderAmount', async function () {
      expect(await placedSellAmount(2000n * PRICE_UNIT)).to.equal(MAX_ORDER)
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

      const NEW_MAX_ORDER = 2000n * PRICE_UNIT
      const NEW_MIN_ORDER = 5n * PRICE_UNIT
      const NEW_MAX_DEPOSIT = 200_000n * PRICE_UNIT
      const NEW_MIN_DEPOSIT = 50_000n * PRICE_UNIT

      // Each setter lands the exact value while leaving its counterpart strictly on the other side,
      // so min stays below max by construction across the sequence.
      await ctx.buybackExecutor.connect(admin).setMaxAllowedOrderAmount(NEW_MAX_ORDER)
      expect(await ctx.buybackExecutor.maxAllowedOrderAmount()).to.equal(NEW_MAX_ORDER)
      expect(await ctx.buybackExecutor.minAllowedOrderAmount()).to.equal(MIN_ORDER)

      await ctx.buybackExecutor.connect(admin).setMinAllowedOrderAmount(NEW_MIN_ORDER)
      expect(await ctx.buybackExecutor.minAllowedOrderAmount()).to.equal(NEW_MIN_ORDER)

      await ctx.buybackExecutor.connect(admin).setMaxDepositValueUsd(NEW_MAX_DEPOSIT)
      expect(await ctx.buybackExecutor.maxDepositValueUsd()).to.equal(NEW_MAX_DEPOSIT)

      await ctx.buybackExecutor.connect(admin).setMinDepositValueUsd(NEW_MIN_DEPOSIT)
      expect(await ctx.buybackExecutor.minDepositValueUsd()).to.equal(NEW_MIN_DEPOSIT)

      // A setter that would meet its counterpart reverts and leaves the bounds intact.
      await expect(
        ctx.buybackExecutor.connect(admin).setMinAllowedOrderAmount(NEW_MAX_ORDER)
      ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'InvalidOrderAmountLimits')
      await expect(
        ctx.buybackExecutor.connect(admin).setMaxDepositValueUsd(NEW_MIN_DEPOSIT)
      ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'InvalidDepositValueLimits')

      expect(await ctx.buybackExecutor.minAllowedOrderAmount()).to.equal(NEW_MIN_ORDER)
      expect(await ctx.buybackExecutor.maxAllowedOrderAmount()).to.equal(NEW_MAX_ORDER)
      expect(await ctx.buybackExecutor.minDepositValueUsd()).to.equal(NEW_MIN_DEPOSIT)
      expect(await ctx.buybackExecutor.maxDepositValueUsd()).to.equal(NEW_MAX_DEPOSIT)
    })
  })

  describe('divergence gate', function () {
    it('should never deposit when divergence exceeds tolerance and the pool TVL reaches the floor', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await fundExecutor(ctx, { ldo: 1750n * PRICE_UNIT, stEth: 1n * PRICE_UNIT })
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
      await fundExecutor(ctx, { ldo: 1750n * PRICE_UNIT, stEth: 1n * PRICE_UNIT })

      await scalePoolEma(ctx, 105n)
      await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()).to.emit(
        ctx.buybackExecutor,
        'LiquidityAdded'
      )

      await fundExecutor(ctx, { ldo: 1750n * PRICE_UNIT, stEth: 1n * PRICE_UNIT })
      await scalePoolEma(ctx, 300n)
      await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()).to.emit(
        ctx.buybackExecutor,
        'LiquidityAdded'
      )
    })

    it('should decide the gate from current TVL and divergence alone, holding no state across calls', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await fundExecutor(ctx, { ldo: 1750n * PRICE_UNIT, stEth: 1n * PRICE_UNIT })
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
      await fundExecutor(ctx, { ldo: 1750n * PRICE_UNIT, stEth: 1n * PRICE_UNIT })
      await setPoolReserves(ctx, DEEP_LDO_RESERVE, 0n)
      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
      ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'PoolPriceDivergenceTooHigh')
    })
  })
})
