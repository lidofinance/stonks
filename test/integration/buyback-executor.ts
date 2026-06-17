import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'

import {
  deployBuybackExecutorWithStubs,
  deployBuybackExecutorTreasuryMode,
  fundExecutor,
  setPoolReserves,
  setPoolEma,
  placeTrackedOrder,
  expireOrder,
  PRICE_SCALE,
  DEFAULT_BOUNDS,
  ALLOCATOR_ROLE,
  missingRoleMessage,
  BuybackContext,
} from '../helpers/buyback-executor'
import { StonksStub__factory, OrderStub__factory } from '../../typechain-types'

// Default oracle USD prices and share rate the stub fixture configures.
const LDO_USD = 2n * PRICE_SCALE
const STETH_USD = 3500n * PRICE_SCALE
const SHARE_RATE = (12n * PRICE_SCALE) / 10n

const MAX_DEPOSIT_USD = DEFAULT_BOUNDS.maxDepositValueUsd

// Reserves whose oracle TVL (100000e18) sits above the 50000e18 bootstrap floor, paired with the
// default EMA on the oracle ratio. This is the healthy deep pool the LP-mode deposits target.
const DEEP_LDO_RESERVE = 50_000n * PRICE_SCALE

// Pool TVL crosses the 50000e18 floor at an LDO reserve of 25000e18 (TVL = reserve * LDO_USD).
const FLOOR_LDO_RESERVE = 25_000n * PRICE_SCALE
const BELOW_FLOOR_LDO_RESERVE = FLOOR_LDO_RESERVE - 1n * PRICE_SCALE

// Small balanced funding for the divergence-gate flows. The LDO leg is the smaller-USD side, so a
// successful deposit drains the LDO balance to zero and a refund re-arms the next call.
const BOOTSTRAP_LDO = 1000n * PRICE_SCALE
const BOOTSTRAP_STETH = 10n * PRICE_SCALE

// LP seeded for the remove-while-paused flow and the amounts the pool returns on withdrawal.
const SEEDED_LP = 1000n * PRICE_SCALE
const WITHDRAWN_LDO = 500n * PRICE_SCALE
const WITHDRAWN_WSTETH = 10n * PRICE_SCALE

// Reference integer math mirroring the contract and the wstETH stub, all floor.
const mulDiv = (a: bigint, b: bigint, denominator: bigint): bigint => (a * b) / denominator
const usdValue = (amount: bigint, price: bigint): bigint => mulDiv(amount, price, PRICE_SCALE)
const wstEthFromStEth = (stEth: bigint): bigint => mulDiv(stEth, PRICE_SCALE, SHARE_RATE)
const stEthFromWstEth = (wstEth: bigint): bigint => mulDiv(wstEth, SHARE_RATE, PRICE_SCALE)

interface BalancedPair {
  ldoAmount: bigint
  stEthAmount: bigint
  depositValueUsd: bigint
}

// Balanced pair sized by the smaller-USD side, matching `_computeBalancedAmounts`.
function balancedLegs(ldoBalance: bigint, stEthBalance: bigint): BalancedPair {
  const ldoUsd = usdValue(ldoBalance, LDO_USD)
  const stEthUsd = usdValue(stEthBalance, STETH_USD)
  if (ldoUsd <= stEthUsd) {
    return {
      ldoAmount: ldoBalance,
      stEthAmount: mulDiv(ldoBalance, LDO_USD, STETH_USD),
      depositValueUsd: ldoUsd * 2n,
    }
  }
  return {
    ldoAmount: mulDiv(stEthBalance, STETH_USD, LDO_USD),
    stEthAmount: stEthBalance,
    depositValueUsd: stEthUsd * 2n,
  }
}

// Moves the pool EMA off the oracle ratio by the given percent of its current value.
async function scalePoolEma(ctx: BuybackContext, percent: bigint): Promise<void> {
  const currentEma = await ctx.stubs.pool.priceOracleValue()
  await setPoolEma(ctx, (currentEma * percent) / 100n)
}

// Sets the deep reserves the LP-mode deposits target, leaving the EMA on the oracle ratio.
async function configureDeepAlignedPool(ctx: BuybackContext): Promise<void> {
  await setPoolReserves(ctx, DEEP_LDO_RESERVE, 0n)
}

describe('BuybackExecutor — end-to-end lifecycles', function () {
  describe('LP-mode lifecycle', function () {
    it('should run allocation, order placement, settlement, deposit, and recovery to TREASURY', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await configureDeepAlignedPool(ctx)

      const executorAddress = await ctx.buybackExecutor.getAddress()
      const stonksAddress = await ctx.stubs.stonks.getAddress()
      const treasuryAddress = await ctx.signers.treasury.getAddress()
      const managerAddress = await ctx.signers.manager.getAddress()

      // 1. The allocator pushes stETH. In LP mode half is forwarded to Stonks and half is reserved
      //    to pair with the bought LDO on deposit.
      const allocatedStEth = 100n * PRICE_SCALE
      await fundExecutor(ctx, { stEth: allocatedStEth })
      const forwarded = allocatedStEth / 2n

      await expect(ctx.buybackExecutor.connect(ctx.signers.allocator).onStEthAllocated())
        .to.emit(ctx.buybackExecutor, 'AllocationProcessed')
        .withArgs(stonksAddress, allocatedStEth, forwarded)
      expect(await ctx.stubs.stEth.balanceOf(stonksAddress)).to.equal(forwarded)
      expect(await ctx.stubs.stEth.balanceOf(executorAddress)).to.equal(allocatedStEth - forwarded)

      // 2. A keeper places the order selling the forwarded stETH.
      await ctx.stubs.stonks.connect(ctx.signers.admin).setEstimatedOutput(1n)
      await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).placeOrder()).to.emit(
        ctx.buybackExecutor,
        'OrderPlaced'
      )
      expect(await ctx.stubs.stonks.lastSellAmount()).to.equal(forwarded)
      expect(await ctx.buybackExecutor.lastOrderAddress()).to.not.equal(ethers.ZeroAddress)

      // 3. CoW settles the order, delivering LDO to the executor.
      const settledLdo = 1000n * PRICE_SCALE
      await fundExecutor(ctx, { ldo: settledLdo })

      // 4. The deposit pairs the LDO with its balanced stETH share against the deep aligned pool.
      const heldStEth = allocatedStEth - forwarded
      const balanced = balancedLegs(settledLdo, heldStEth)
      const wstEthMinted = wstEthFromStEth(balanced.stEthAmount)
      const lpMinted = balanced.ldoAmount + wstEthMinted

      await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity())
        .to.emit(ctx.buybackExecutor, 'LiquidityAdded')
        .withArgs(
          await ctx.signers.stranger.getAddress(),
          balanced.ldoAmount,
          wstEthMinted,
          lpMinted
        )
      expect(await ctx.stubs.ldo.balanceOf(executorAddress)).to.equal(0n)
      expect(await ctx.stubs.stEth.balanceOf(executorAddress)).to.equal(
        heldStEth - balanced.stEthAmount
      )
      expect(await ctx.buybackExecutor.getLpTokenBalance()).to.equal(lpMinted)

      // 5. The manager unwinds the LP claim entirely to the treasury.
      await ctx.stubs.pool
        .connect(ctx.signers.admin)
        .setNextWithdrawn(WITHDRAWN_LDO, WITHDRAWN_WSTETH)
      const recoveredStEth = stEthFromWstEth(WITHDRAWN_WSTETH)

      await expect(
        ctx.buybackExecutor
          .connect(ctx.signers.manager)
          .removeLiquidityAndRecoverToTreasury(lpMinted, 0n, 0n)
      )
        .to.emit(ctx.buybackExecutor, 'LiquidityRemoved')
        .withArgs(managerAddress, lpMinted, WITHDRAWN_LDO, recoveredStEth)

      expect(await ctx.stubs.ldo.balanceOf(treasuryAddress)).to.equal(WITHDRAWN_LDO)
      expect(await ctx.stubs.stEth.balanceOf(treasuryAddress)).to.equal(recoveredStEth)
      expect(await ctx.buybackExecutor.getLpTokenBalance()).to.equal(0n)
    })

    it('should split a balance above maxDepositValueUsd across calls and carry the stETH surplus', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await configureDeepAlignedPool(ctx)
      const executorAddress = await ctx.buybackExecutor.getAddress()

      // Uncapped value 400000e18 is four times the cap, so the LDO leg drains over four full-cap
      // calls while the larger stETH leg keeps the surplus the deposits never consume.
      const initialLdo = 100_000n * PRICE_SCALE
      const initialStEth = 100n * PRICE_SCALE
      await fundExecutor(ctx, { ldo: initialLdo, stEth: initialStEth })

      let depositedStEth = 0n
      for (let call = 0; call < 4; call += 1) {
        const evaluation = await ctx.buybackExecutor.evaluateAddLiquidityGates()
        const ldoBefore = await ctx.stubs.ldo.balanceOf(executorAddress)

        await ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()

        // The capped LDO leg leaves the balance and the deposit never exceeds the cap.
        expect(await ctx.stubs.pool.lastAddLiquidityLdo()).to.equal(evaluation.ldoAmount)
        expect(await ctx.stubs.ldo.balanceOf(executorAddress)).to.equal(
          ldoBefore - evaluation.ldoAmount
        )
        const depositedUsd =
          usdValue(evaluation.ldoAmount, LDO_USD) + usdValue(evaluation.stEthAmount, STETH_USD)
        expect(depositedUsd <= MAX_DEPOSIT_USD).to.equal(true)

        depositedStEth += evaluation.stEthAmount
      }

      // The LDO leg is fully drained, the stETH surplus remains, and a further call has no LDO.
      expect(await ctx.stubs.ldo.balanceOf(executorAddress)).to.equal(0n)
      expect(await ctx.stubs.stEth.balanceOf(executorAddress)).to.equal(
        initialStEth - depositedStEth
      )
      expect(initialStEth - depositedStEth > 0n).to.equal(true)
      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
      ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'ZeroLdoBalance')
    })
  })

  describe('treasury-mode lifecycle', function () {
    it('should forward all stETH to Stonks, settle LDO to TREASURY, and never accumulate LDO', async function () {
      const ctx = await loadFixture(deployBuybackExecutorTreasuryMode)
      const executorAddress = await ctx.buybackExecutor.getAddress()
      const stonksAddress = await ctx.stubs.stonks.getAddress()
      const treasuryAddress = await ctx.signers.treasury.getAddress()

      // The allocator pushes stETH. In treasury mode the whole balance forwards to Stonks.
      const allocatedStEth = 100n * PRICE_SCALE
      await fundExecutor(ctx, { stEth: allocatedStEth })

      await expect(ctx.buybackExecutor.connect(ctx.signers.allocator).onStEthAllocated())
        .to.emit(ctx.buybackExecutor, 'AllocationProcessed')
        .withArgs(stonksAddress, allocatedStEth, allocatedStEth)
      expect(await ctx.stubs.stEth.balanceOf(stonksAddress)).to.equal(allocatedStEth)
      expect(await ctx.stubs.stEth.balanceOf(executorAddress)).to.equal(0n)

      // The keeper places the order for the full forwarded balance.
      await ctx.stubs.stonks.connect(ctx.signers.admin).setEstimatedOutput(1n)
      await ctx.buybackExecutor.connect(ctx.signers.stranger).placeOrder()
      expect(await ctx.stubs.stonks.lastSellAmount()).to.equal(allocatedStEth)

      // CoW settles LDO straight to the treasury, never to the executor.
      const settledLdo = 1000n * PRICE_SCALE
      await ctx.stubs.ldo.connect(ctx.signers.admin).mint(treasuryAddress, settledLdo)
      expect(await ctx.stubs.ldo.balanceOf(treasuryAddress)).to.equal(settledLdo)
      expect(await ctx.stubs.ldo.balanceOf(executorAddress)).to.equal(0n)

      // The deposit path is closed in treasury mode.
      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
      ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'NotInLpMode')
    })
  })

  describe('mode switching', function () {
    it('should sweep an expired order and recover its residual to the previous Stonks on switch', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const orderAddress = await placeTrackedOrder(ctx)

      // The order carries residual stETH worth recovering once it expires.
      const residual = 1000n
      await ctx.stubs.stEth.connect(ctx.signers.admin).mint(orderAddress, residual)
      await expireOrder(ctx)

      const previousStonks = await ctx.stubs.stonks.getAddress()
      const newStonks = await new StonksStub__factory(ctx.signers.deployer).deploy()
      await newStonks.setReceiver(await ctx.buybackExecutor.getAddress())
      await newStonks.setOrderDuration(3600n)
      const newStonksAddress = await newStonks.getAddress()

      await expect(
        ctx.buybackExecutor.connect(ctx.signers.admin).setStonksAndOperatingMode(newStonksAddress)
      )
        .to.emit(ctx.buybackExecutor, 'StaleOrderCleared')
        .withArgs(orderAddress)
        .and.to.emit(ctx.buybackExecutor, 'StonksAndOperatingModeSet')
        .withArgs(previousStonks, newStonksAddress, true, true)

      const order = OrderStub__factory.connect(orderAddress, ctx.signers.deployer)
      expect(await order.recoverTokenFromCalls()).to.equal(1n)
      expect(await ctx.buybackExecutor.lastOrderAddress()).to.equal(ethers.ZeroAddress)
      expect(await ctx.buybackExecutor.stonks()).to.equal(newStonksAddress)
    })

    it('should leave a live order stranded and unrecovered on switch', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const orderAddress = await placeTrackedOrder(ctx)
      const validTo = await ctx.buybackExecutor.lastOrderValidTo()

      // Residual on a still-live order proves the switch abandons it without recovering.
      await ctx.stubs.stEth.connect(ctx.signers.admin).mint(orderAddress, 1000n)

      const newStonks = await new StonksStub__factory(ctx.signers.deployer).deploy()
      await newStonks.setReceiver(await ctx.buybackExecutor.getAddress())
      await newStonks.setOrderDuration(3600n)
      const newStonksAddress = await newStonks.getAddress()

      const tx = ctx.buybackExecutor
        .connect(ctx.signers.admin)
        .setStonksAndOperatingMode(newStonksAddress)
      await expect(tx)
        .to.emit(ctx.buybackExecutor, 'OrderAbandoned')
        .withArgs(orderAddress, validTo)
      await expect(tx).to.not.emit(ctx.buybackExecutor, 'StaleOrderCleared')

      const order = OrderStub__factory.connect(orderAddress, ctx.signers.deployer)
      expect(await order.recoverTokenFromCalls()).to.equal(0n)
      expect(await ctx.buybackExecutor.lastOrderAddress()).to.equal(ethers.ZeroAddress)
    })
  })

  describe('pause lifecycle', function () {
    it('should block add, allocate, and place while paused, keep remove working, and restore on unpause', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await configureDeepAlignedPool(ctx)
      const executorAddress = await ctx.buybackExecutor.getAddress()
      const treasuryAddress = await ctx.signers.treasury.getAddress()
      const managerAddress = await ctx.signers.manager.getAddress()

      await fundExecutor(ctx, { ldo: BOOTSTRAP_LDO, stEth: BOOTSTRAP_STETH })
      await ctx.stubs.pool.connect(ctx.signers.admin).mint(executorAddress, SEEDED_LP)
      await ctx.stubs.pool
        .connect(ctx.signers.admin)
        .setNextWithdrawn(WITHDRAWN_LDO, WITHDRAWN_WSTETH)

      await expect(ctx.buybackExecutor.connect(ctx.signers.emergency).pause()).to.emit(
        ctx.buybackExecutor,
        'Paused'
      )
      expect(await ctx.buybackExecutor.paused()).to.equal(true)

      // The deposit, allocation, and placement paths are all gated by `whenNotPaused`.
      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
      ).to.be.revertedWith('Pausable: paused')
      await expect(
        ctx.buybackExecutor.connect(ctx.signers.allocator).onStEthAllocated()
      ).to.be.revertedWith('Pausable: paused')
      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).placeOrder()
      ).to.be.revertedWith('Pausable: paused')

      // Removal stays open so the committee can unwind under an emergency.
      const recoveredStEth = stEthFromWstEth(WITHDRAWN_WSTETH)
      await expect(
        ctx.buybackExecutor
          .connect(ctx.signers.manager)
          .removeLiquidityAndRecoverToTreasury(SEEDED_LP, 0n, 0n)
      )
        .to.emit(ctx.buybackExecutor, 'LiquidityRemoved')
        .withArgs(managerAddress, SEEDED_LP, WITHDRAWN_LDO, recoveredStEth)
      expect(await ctx.stubs.ldo.balanceOf(treasuryAddress)).to.equal(WITHDRAWN_LDO)
      expect(await ctx.stubs.stEth.balanceOf(treasuryAddress)).to.equal(recoveredStEth)

      // Unpausing restores the deposit path.
      await ctx.buybackExecutor.connect(ctx.signers.emergency).unpause()
      expect(await ctx.buybackExecutor.paused()).to.equal(false)
      await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()).to.emit(
        ctx.buybackExecutor,
        'LiquidityAdded'
      )
    })
  })

  describe('allocator handoff', function () {
    it('should drive allocation only through the ALLOCATOR_ROLE holder end to end', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const stonksAddress = await ctx.stubs.stonks.getAddress()

      const allocatedStEth = 100n * PRICE_SCALE
      await fundExecutor(ctx, { stEth: allocatedStEth })

      // A non-holder cannot push the allocation.
      const strangerAddress = await ctx.signers.stranger.getAddress()
      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).onStEthAllocated()
      ).to.be.revertedWith(missingRoleMessage(strangerAddress, ALLOCATOR_ROLE))

      // The allocator drives it, forwarding half to Stonks for the keeper to sell.
      const forwarded = allocatedStEth / 2n
      await expect(ctx.buybackExecutor.connect(ctx.signers.allocator).onStEthAllocated())
        .to.emit(ctx.buybackExecutor, 'AllocationProcessed')
        .withArgs(stonksAddress, allocatedStEth, forwarded)
      expect(await ctx.stubs.stEth.balanceOf(stonksAddress)).to.equal(forwarded)

      await ctx.stubs.stonks.connect(ctx.signers.admin).setEstimatedOutput(1n)
      await ctx.buybackExecutor.connect(ctx.signers.stranger).placeOrder()
      expect(await ctx.stubs.stonks.lastSellAmount()).to.equal(forwarded)
      expect(await ctx.buybackExecutor.lastOrderAddress()).to.not.equal(ethers.ZeroAddress)
    })
  })

  describe('divergence-gate lifecycles', function () {
    // Refunds the drained LDO leg so the next deposit attempt is funded again.
    async function refundBootstrapLdo(ctx: BuybackContext): Promise<void> {
      await fundExecutor(ctx, { ldo: BOOTSTRAP_LDO })
    }

    it('should bootstrap a shallow divergent pool until TVL reaches the floor, then enforce the gate', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const executorAddress = await ctx.buybackExecutor.getAddress()
      await fundExecutor(ctx, { ldo: BOOTSTRAP_LDO, stEth: BOOTSTRAP_STETH })

      // A 5% EMA deviation scores 500 bps, well past the 100 bps tolerance, for every call below.
      await scalePoolEma(ctx, 105n)

      // Empty pool: divergence is bypassed and the deposit seeds it.
      await setPoolReserves(ctx, 0n, 0n)
      await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()).to.emit(
        ctx.buybackExecutor,
        'LiquidityAdded'
      )
      expect(await ctx.stubs.ldo.balanceOf(executorAddress)).to.equal(0n)

      // Still just below the floor: divergence is bypassed and the deposit goes through.
      await refundBootstrapLdo(ctx)
      await setPoolReserves(ctx, BELOW_FLOOR_LDO_RESERVE, 0n)
      await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()).to.emit(
        ctx.buybackExecutor,
        'LiquidityAdded'
      )
      expect(await ctx.stubs.ldo.balanceOf(executorAddress)).to.equal(0n)

      // The pool reaches the floor: the gate engages and blocks the next divergent deposit.
      await refundBootstrapLdo(ctx)
      await setPoolReserves(ctx, FLOOR_LDO_RESERVE, 0n)
      const ldoBefore = await ctx.stubs.ldo.balanceOf(executorAddress)
      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
      ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'PoolPriceDivergenceTooHigh')
      expect(await ctx.stubs.ldo.balanceOf(executorAddress)).to.equal(ldoBefore)
    })

    it('should re-open the bypass when a deep pool falls back below the floor', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const executorAddress = await ctx.buybackExecutor.getAddress()
      await fundExecutor(ctx, { ldo: BOOTSTRAP_LDO, stEth: BOOTSTRAP_STETH })
      await scalePoolEma(ctx, 105n)

      // Deep and divergent: gated.
      await setPoolReserves(ctx, DEEP_LDO_RESERVE, 0n)
      const ldoBefore = await ctx.stubs.ldo.balanceOf(executorAddress)
      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
      ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'PoolPriceDivergenceTooHigh')
      expect(await ctx.stubs.ldo.balanceOf(executorAddress)).to.equal(ldoBefore)

      // Drained back below the floor: the gate is recomputed and the bypass re-opens.
      await setPoolReserves(ctx, BELOW_FLOOR_LDO_RESERVE, 0n)
      await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()).to.emit(
        ctx.buybackExecutor,
        'LiquidityAdded'
      )
      expect(await ctx.stubs.ldo.balanceOf(executorAddress)).to.equal(0n)

      // Refilled to the floor: the gate engages again, holding no memory of the prior bypass.
      await refundBootstrapLdo(ctx)
      await setPoolReserves(ctx, FLOOR_LDO_RESERVE, 0n)
      const ldoBeforeRefill = await ctx.stubs.ldo.balanceOf(executorAddress)
      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
      ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'PoolPriceDivergenceTooHigh')
      expect(await ctx.stubs.ldo.balanceOf(executorAddress)).to.equal(ldoBeforeRefill)
    })

    it('should block only the deposit whose own pre-deposit TVL reaches the floor, leaving no gated state', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const executorAddress = await ctx.buybackExecutor.getAddress()
      await fundExecutor(ctx, { ldo: BOOTSTRAP_LDO, stEth: BOOTSTRAP_STETH })
      await scalePoolEma(ctx, 105n)

      // Shallow: the deposit clears.
      await setPoolReserves(ctx, BELOW_FLOOR_LDO_RESERVE, 0n)
      await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()).to.emit(
        ctx.buybackExecutor,
        'LiquidityAdded'
      )
      expect(await ctx.stubs.ldo.balanceOf(executorAddress)).to.equal(0n)

      // Deep: only this deposit is blocked.
      await refundBootstrapLdo(ctx)
      await setPoolReserves(ctx, FLOOR_LDO_RESERVE, 0n)
      const ldoBefore = await ctx.stubs.ldo.balanceOf(executorAddress)
      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
      ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'PoolPriceDivergenceTooHigh')
      expect(await ctx.stubs.ldo.balanceOf(executorAddress)).to.equal(ldoBefore)

      // Shallow again: the blocked call left no gated state, so this deposit clears.
      await setPoolReserves(ctx, BELOW_FLOOR_LDO_RESERVE, 0n)
      await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()).to.emit(
        ctx.buybackExecutor,
        'LiquidityAdded'
      )
      expect(await ctx.stubs.ldo.balanceOf(executorAddress)).to.equal(0n)
    })
  })

  describe('transient pool failure', function () {
    it('should bubble an add_liquidity revert with no fund loss, then deposit the carried balance once the pool accepts it', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await configureDeepAlignedPool(ctx)
      const executorAddress = await ctx.buybackExecutor.getAddress()
      await fundExecutor(ctx, { ldo: BOOTSTRAP_LDO, stEth: BOOTSTRAP_STETH })

      const ldoBefore = await ctx.stubs.ldo.balanceOf(executorAddress)
      const stEthBefore = await ctx.stubs.stEth.balanceOf(executorAddress)

      // The pool rejects the deposit on a transient state. The revert bubbles and rolls back the
      // wrap, so no funds leave the executor.
      await ctx.stubs.pool.connect(ctx.signers.admin).setRevertOnAddLiquidity(true)
      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
      ).to.be.revertedWithCustomError(ctx.stubs.pool, 'CurveAddLiquidityReverted')
      expect(await ctx.stubs.ldo.balanceOf(executorAddress)).to.equal(ldoBefore)
      expect(await ctx.stubs.stEth.balanceOf(executorAddress)).to.equal(stEthBefore)

      // Once the pool accepts deposits again the carried balance is deposited unchanged.
      await ctx.stubs.pool.connect(ctx.signers.admin).setRevertOnAddLiquidity(false)
      const balanced = balancedLegs(ldoBefore, stEthBefore)
      const wstEthMinted = wstEthFromStEth(balanced.stEthAmount)
      await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity())
        .to.emit(ctx.buybackExecutor, 'LiquidityAdded')
        .withArgs(
          await ctx.signers.stranger.getAddress(),
          balanced.ldoAmount,
          wstEthMinted,
          balanced.ldoAmount + wstEthMinted
        )
      expect(await ctx.stubs.ldo.balanceOf(executorAddress)).to.equal(0n)
    })
  })
})
