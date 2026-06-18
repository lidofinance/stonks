import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'

import {
  deployBuybackExecutorWithStubs,
  deployBuybackExecutorTreasuryMode,
  fundExecutor,
  setOraclePrices,
  setOracleFailure,
  setPoolReserves,
  makePoolDivergent,
  OracleFailureMode,
  PRICE_SCALE,
  DEFAULT_BOUNDS,
  MANAGER_ROLE,
  missingRoleMessage,
  PAUSED_REVERT,
  REENTRANCY_REVERT,
  BALANCED_LDO,
  BALANCED_STETH,
  DEEP_LDO_RESERVE,
  BOUNDARY_LDO_RESERVE,
  LP_BALANCE,
  WITHDRAWN_LDO,
  WITHDRAWN_WSTETH,
  BuybackContext,
} from '../../../helpers/buyback-executor'

// Deterministic pool mint, decoupled from the deposit legs, for the return-value assertion.
const LP_MINT = 777n * PRICE_SCALE

async function fundBalanced(ctx: BuybackContext): Promise<void> {
  await fundExecutor(ctx, { ldo: BALANCED_LDO, stEth: BALANCED_STETH })
}

describe('BuybackExecutor — liquidity', function () {
  describe('#addLiquidity', function () {
    describe('access and modifiers:', function () {
      it('should allow any account to call', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundBalanced(ctx)

        await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()).to.emit(
          ctx.buybackExecutor,
          'LiquidityAdded'
        )
      })

      it('should revert when paused', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundBalanced(ctx)
        await ctx.buybackExecutor.connect(ctx.signers.emergency).pause()

        await expect(
          ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
        ).to.be.revertedWith(PAUSED_REVERT)
      })

      it('should revert with the reentrancy guard when the pool re-enters during add_liquidity', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundBalanced(ctx)
        const executorAddress = await ctx.buybackExecutor.getAddress()
        await ctx.stubs.pool.connect(ctx.signers.admin).armReentrancy(executorAddress, true)

        await expect(
          ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
        ).to.be.revertedWith(REENTRANCY_REVERT)
      })
    })

    describe('status to revert mapping:', function () {
      it('should revert NotInLpMode in treasury mode', async function () {
        const ctx = await loadFixture(deployBuybackExecutorTreasuryMode)
        await fundBalanced(ctx)

        await expect(
          ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
        ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'NotInLpMode')
      })

      it('should revert ZeroLdoBalance when the LDO balance is 0', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundExecutor(ctx, { stEth: BALANCED_STETH })

        await expect(
          ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
        ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'ZeroLdoBalance')
      })

      it('should revert ZeroStEthBalance when LDO is positive but the stETH balance is 0', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundExecutor(ctx, { ldo: BALANCED_LDO })

        await expect(
          ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
        ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'ZeroStEthBalance')
      })

      it('should revert OraclePriceUnavailable when getUsdPrices reverts', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundBalanced(ctx)
        await setOracleFailure(ctx, OracleFailureMode.CustomError)

        await expect(
          ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
        ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'OraclePriceUnavailable')
      })

      it('should revert OraclePriceUnavailable when an oracle price is 0', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundBalanced(ctx)
        await setOraclePrices(ctx, 0n, PRICE_SCALE)

        await expect(
          ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
        ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'OraclePriceUnavailable')
      })

      it('should revert InvalidOraclePrice when the LDO/stETH ratio truncates to 0', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundBalanced(ctx)
        // stEthUsd far below ldoUsd makes mulDiv(stEthUsd, PRICE_SCALE, ldoUsd) floor to 0.
        await setOraclePrices(ctx, 2n * PRICE_SCALE, 1n)

        await expect(
          ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
        ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'InvalidOraclePrice')
      })

      it('should revert PoolPriceDivergenceTooHigh when divergence exceeds tolerance and the pool TVL is at or above the floor', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundBalanced(ctx)
        await setPoolReserves(ctx, DEEP_LDO_RESERVE, 0n)
        await makePoolDivergent(ctx)

        const divergence = await ctx.harness.evaluatePoolPriceDivergence()
        const tolerance = await ctx.buybackExecutor.poolPriceDivergenceToleranceBps()

        await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity())
          .to.be.revertedWithCustomError(ctx.buybackExecutor, 'PoolPriceDivergenceTooHigh')
          .withArgs(
            divergence.poolEmaLdoPerStEth,
            divergence.oracleLdoPerStEth,
            divergence.divergenceBps,
            tolerance
          )
      })

      it('should revert DepositValueBelowMinimum when the balanced value is under the floor', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundExecutor(ctx, { ldo: 1n, stEth: 1n })

        // ldoUsdValue = 2 wei is the smaller leg, so depositValueUsd = 4 wei, below the 100e18 floor.
        await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity())
          .to.be.revertedWithCustomError(ctx.buybackExecutor, 'DepositValueBelowMinimum')
          .withArgs(4n, DEFAULT_BOUNDS.minDepositValueUsd)
      })
    })

    describe('happy path, state, and events:', function () {
      it('should deposit the balanced legs, wrap the stETH, and emit LiquidityAdded', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundBalanced(ctx)
        await ctx.stubs.pool.connect(ctx.signers.admin).setNextLpMint(LP_MINT)

        const evaluation = await ctx.harness.evaluateAddLiquidityGates()
        expect(evaluation.ldoAmount).to.equal(BALANCED_LDO)
        expect(evaluation.stEthAmount).to.equal(BALANCED_STETH)
        const mintedWstEth = await ctx.stubs.wstEth.getWstETHByStETH(evaluation.stEthAmount)

        const executorAddress = await ctx.buybackExecutor.getAddress()
        const poolAddress = await ctx.stubs.pool.getAddress()
        const strangerAddress = await ctx.signers.stranger.getAddress()

        await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity())
          .to.emit(ctx.buybackExecutor, 'LiquidityAdded')
          .withArgs(strangerAddress, BALANCED_LDO, mintedWstEth, LP_MINT)

        expect(await ctx.stubs.pool.lastAddLiquidityLdo()).to.equal(BALANCED_LDO)
        expect(await ctx.stubs.pool.lastAddLiquidityWstEth()).to.equal(mintedWstEth)
        expect(await ctx.stubs.pool.lastMinMint()).to.equal(1n)

        // forceApprove lets the pool pull exactly the deposit legs, emptying both executor balances.
        expect(await ctx.stubs.ldo.balanceOf(executorAddress)).to.equal(0n)
        expect(await ctx.stubs.stEth.balanceOf(executorAddress)).to.equal(0n)
        expect(await ctx.stubs.ldo.balanceOf(poolAddress)).to.equal(BALANCED_LDO)
        expect(await ctx.stubs.wstEth.balanceOf(poolAddress)).to.equal(mintedWstEth)
      })

      it('should return lpTokensMinted equal to the pool reported mint', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundBalanced(ctx)
        await ctx.stubs.pool.connect(ctx.signers.admin).setNextLpMint(LP_MINT)

        expect(
          await ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity.staticCall()
        ).to.equal(LP_MINT)
      })

      it('should deposit the wrapped wstETH amount when wrap rounds down by 1 wei', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundBalanced(ctx)
        await ctx.stubs.wstEth.connect(ctx.signers.admin).setRoundDownWrap(true)

        const evaluation = await ctx.harness.evaluateAddLiquidityGates()
        const roundedWstEth =
          (await ctx.stubs.wstEth.getWstETHByStETH(evaluation.stEthAmount)) - 1n
        const strangerAddress = await ctx.signers.stranger.getAddress()

        await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity())
          .to.emit(ctx.buybackExecutor, 'LiquidityAdded')
          .withArgs(strangerAddress, evaluation.ldoAmount, roundedWstEth, evaluation.ldoAmount + roundedWstEth)

        expect(await ctx.stubs.pool.lastAddLiquidityWstEth()).to.equal(roundedWstEth)
      })

      it('should size by the smaller-USD side and leave the larger side surplus untouched', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        // LDO is the smaller USD leg (200e18 vs 3500e18), so all LDO deposits and stETH carries over.
        const ldoFunded = 100n * PRICE_SCALE
        const stEthFunded = 1n * PRICE_SCALE
        await fundExecutor(ctx, { ldo: ldoFunded, stEth: stEthFunded })

        const divergence = await ctx.harness.evaluatePoolPriceDivergence()
        const expected = await ctx.harness.computeBalancedAmounts(
          ldoFunded,
          stEthFunded,
          divergence.ldoUsdPrice,
          divergence.stEthUsdPrice
        )

        const evaluation = await ctx.harness.evaluateAddLiquidityGates()
        expect(evaluation.ldoAmount).to.equal(ldoFunded)
        expect(evaluation.stEthAmount).to.equal(expected.stEthAmount)

        const executorAddress = await ctx.buybackExecutor.getAddress()
        await ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()

        expect(await ctx.stubs.ldo.balanceOf(executorAddress)).to.equal(0n)
        expect(await ctx.stubs.stEth.balanceOf(executorAddress)).to.equal(
          stEthFunded - evaluation.stEthAmount
        )
      })
    })

    describe('deposit value boundaries:', function () {
      it('should deposit at exactly minDepositValueUsd', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        // ldoUsdValue = 50e18 is the smaller leg, so depositValueUsd = 100e18 = the floor.
        await fundExecutor(ctx, { ldo: 25n * PRICE_SCALE, stEth: 1n * PRICE_SCALE })

        const evaluation = await ctx.harness.evaluateAddLiquidityGates()
        expect(evaluation.depositValueUsd).to.equal(DEFAULT_BOUNDS.minDepositValueUsd)

        await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()).to.emit(
          ctx.buybackExecutor,
          'LiquidityAdded'
        )
      })

      it('should deposit at exactly maxDepositValueUsd without scaling', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        // ldoUsdValue = 50000e18 is the smaller leg, so depositValueUsd = 100000e18 = the cap.
        const ldoFunded = 25_000n * PRICE_SCALE
        await fundExecutor(ctx, { ldo: ldoFunded, stEth: 20n * PRICE_SCALE })

        const evaluation = await ctx.harness.evaluateAddLiquidityGates()
        expect(evaluation.depositValueUsd).to.equal(DEFAULT_BOUNDS.maxDepositValueUsd)
        expect(evaluation.ldoAmount).to.equal(ldoFunded)

        await ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
        expect(await ctx.stubs.pool.lastAddLiquidityLdo()).to.equal(ldoFunded)
      })

      it('should scale both legs down above maxDepositValueUsd and emit the capped amounts', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        // Uncapped depositValueUsd = 400000e18, four times the cap, so both legs scale to a quarter.
        await fundExecutor(ctx, { ldo: 100_000n * PRICE_SCALE, stEth: 100n * PRICE_SCALE })

        const evaluation = await ctx.harness.evaluateAddLiquidityGates()
        expect(evaluation.ldoAmount).to.equal(25_000n * PRICE_SCALE)
        const mintedWstEth = await ctx.stubs.wstEth.getWstETHByStETH(evaluation.stEthAmount)
        const strangerAddress = await ctx.signers.stranger.getAddress()

        await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity())
          .to.emit(ctx.buybackExecutor, 'LiquidityAdded')
          .withArgs(
            strangerAddress,
            evaluation.ldoAmount,
            mintedWstEth,
            evaluation.ldoAmount + mintedWstEth
          )

        expect(await ctx.stubs.pool.lastAddLiquidityLdo()).to.equal(evaluation.ldoAmount)
      })
    })

    describe('bootstrap divergence gate:', function () {
      it('should bypass the gate and deposit when the pool TVL is below the floor, even past tolerance', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundBalanced(ctx)
        // Default reserves are zero, so the TVL is below the floor and the divergence is bypassed.
        await makePoolDivergent(ctx)

        await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()).to.emit(
          ctx.buybackExecutor,
          'LiquidityAdded'
        )
      })

      it('should deposit within tolerance at any depth, including a TVL above the floor', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundBalanced(ctx)
        // Deep pool, default EMA on the oracle ratio, so the divergence is zero and the gate passes.
        await setPoolReserves(ctx, DEEP_LDO_RESERVE, 0n)

        await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()).to.emit(
          ctx.buybackExecutor,
          'LiquidityAdded'
        )
      })

      it('should be eligible at divergence equal to tolerance and revert at tolerance plus 1 bp', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundBalanced(ctx)
        await setPoolReserves(ctx, DEEP_LDO_RESERVE, 0n)
        await makePoolDivergent(ctx)

        const divergence = await ctx.harness.evaluatePoolPriceDivergence()

        // Tolerance one below divergence makes divergence equal tolerance + 1, so the deposit reverts
        // without consuming the funded balances.
        await ctx.buybackExecutor
          .connect(ctx.signers.admin)
          .setPoolPriceDivergenceToleranceBps(divergence.divergenceBps - 1n)
        await expect(
          ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
        ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'PoolPriceDivergenceTooHigh')

        // Tolerance equal to divergence makes the same pool eligible.
        await ctx.buybackExecutor
          .connect(ctx.signers.admin)
          .setPoolPriceDivergenceToleranceBps(divergence.divergenceBps)
        await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()).to.emit(
          ctx.buybackExecutor,
          'LiquidityAdded'
        )
      })

      it('should enforce the gate when the pool TVL equals the floor and bypass at one wei below it', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundBalanced(ctx)
        await setPoolReserves(ctx, BOUNDARY_LDO_RESERVE, 0n)
        await makePoolDivergent(ctx)

        const divergence = await ctx.harness.evaluatePoolPriceDivergence()
        const poolTvl = await ctx.harness.poolTvlUsd(
          divergence.ldoUsdPrice,
          divergence.stEthUsdPrice
        )

        await ctx.buybackExecutor.connect(ctx.signers.admin).setPoolBootstrapMinTvlUsd(poolTvl)
        await expect(
          ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
        ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'PoolPriceDivergenceTooHigh')

        await ctx.buybackExecutor
          .connect(ctx.signers.admin)
          .setPoolBootstrapMinTvlUsd(poolTvl + 1n)
        await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()).to.emit(
          ctx.buybackExecutor,
          'LiquidityAdded'
        )
      })

      it('should re-evaluate the gate per call, so a pool dropping back below the floor is no longer gated', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundBalanced(ctx)
        await makePoolDivergent(ctx)
        await setPoolReserves(ctx, DEEP_LDO_RESERVE, 0n)

        await expect(
          ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
        ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'PoolPriceDivergenceTooHigh')

        await setPoolReserves(ctx, 0n, 0n)
        await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()).to.emit(
          ctx.buybackExecutor,
          'LiquidityAdded'
        )
      })
    })

    describe('external pool interactions:', function () {
      it('should bubble up a reverting add_liquidity and leave balances retryable', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundBalanced(ctx)
        const executorAddress = await ctx.buybackExecutor.getAddress()

        await ctx.stubs.pool.connect(ctx.signers.admin).setRevertOnAddLiquidity(true)
        await expect(
          ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
        ).to.be.revertedWithCustomError(ctx.stubs.pool, 'CurveAddLiquidityReverted')

        expect(await ctx.stubs.ldo.balanceOf(executorAddress)).to.equal(BALANCED_LDO)
        expect(await ctx.stubs.stEth.balanceOf(executorAddress)).to.equal(BALANCED_STETH)

        await ctx.stubs.pool.connect(ctx.signers.admin).setRevertOnAddLiquidity(false)
        await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()).to.emit(
          ctx.buybackExecutor,
          'LiquidityAdded'
        )
      })
    })
  })

  describe('#removeLiquidityAndRecoverToTreasury', function () {
    describe('access and modifiers:', function () {
      it('should revert for a non-MANAGER_ROLE caller', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        const strangerAddress = await ctx.signers.stranger.getAddress()

        await expect(
          ctx.buybackExecutor
            .connect(ctx.signers.stranger)
            .removeLiquidityAndRecoverToTreasury(LP_BALANCE, 0n, 0n)
        ).to.be.revertedWith(missingRoleMessage(strangerAddress, MANAGER_ROLE))
      })

      it('should succeed while paused', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        const executorAddress = await ctx.buybackExecutor.getAddress()
        await ctx.stubs.pool.connect(ctx.signers.admin).mint(executorAddress, LP_BALANCE)
        await ctx.stubs.pool
          .connect(ctx.signers.admin)
          .setNextWithdrawn(WITHDRAWN_LDO, WITHDRAWN_WSTETH)
        await ctx.buybackExecutor.connect(ctx.signers.emergency).pause()

        await expect(
          ctx.buybackExecutor
            .connect(ctx.signers.manager)
            .removeLiquidityAndRecoverToTreasury(LP_BALANCE, 0n, 0n)
        ).to.emit(ctx.buybackExecutor, 'LiquidityRemoved')
      })

      it('should revert with the reentrancy guard when the pool re-enters during remove_liquidity', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        const executorAddress = await ctx.buybackExecutor.getAddress()
        await ctx.stubs.pool.connect(ctx.signers.admin).mint(executorAddress, LP_BALANCE)
        await ctx.stubs.pool.connect(ctx.signers.admin).armReentrancy(executorAddress, true)

        await expect(
          ctx.buybackExecutor
            .connect(ctx.signers.manager)
            .removeLiquidityAndRecoverToTreasury(LP_BALANCE, 0n, 0n)
        ).to.be.revertedWith(REENTRANCY_REVERT)
      })
    })

    describe('validation:', function () {
      it('should revert ZeroLpAmount when lpAmount_ is 0', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)

        await expect(
          ctx.buybackExecutor
            .connect(ctx.signers.manager)
            .removeLiquidityAndRecoverToTreasury(0n, 0n, 0n)
        ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'ZeroLpAmount')
      })

      it('should revert InsufficientLpTokenBalance when the LP balance is below lpAmount_', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        const executorAddress = await ctx.buybackExecutor.getAddress()
        const held = LP_BALANCE
        const requested = LP_BALANCE + 1n
        await ctx.stubs.pool.connect(ctx.signers.admin).mint(executorAddress, held)

        await expect(
          ctx.buybackExecutor
            .connect(ctx.signers.manager)
            .removeLiquidityAndRecoverToTreasury(requested, 0n, 0n)
        )
          .to.be.revertedWithCustomError(ctx.buybackExecutor, 'InsufficientLpTokenBalance')
          .withArgs(requested, held)
      })
    })

    describe('happy path, state, events, interactions:', function () {
      it('should withdraw, unwrap, transfer to TREASURY, burn the LP, and emit LiquidityRemoved', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        const executorAddress = await ctx.buybackExecutor.getAddress()
        const treasuryAddress = await ctx.signers.treasury.getAddress()
        const managerAddress = await ctx.signers.manager.getAddress()

        await ctx.stubs.pool.connect(ctx.signers.admin).mint(executorAddress, LP_BALANCE)
        await ctx.stubs.pool
          .connect(ctx.signers.admin)
          .setNextWithdrawn(WITHDRAWN_LDO, WITHDRAWN_WSTETH)
        const expectedStEth = await ctx.stubs.wstEth.getStETHByWstETH(WITHDRAWN_WSTETH)

        const returned = await ctx.buybackExecutor
          .connect(ctx.signers.manager)
          .removeLiquidityAndRecoverToTreasury.staticCall(LP_BALANCE, 0n, 0n)
        expect(returned[0]).to.equal(WITHDRAWN_LDO)
        expect(returned[1]).to.equal(expectedStEth)

        await expect(
          ctx.buybackExecutor
            .connect(ctx.signers.manager)
            .removeLiquidityAndRecoverToTreasury(LP_BALANCE, 0n, 0n)
        )
          .to.emit(ctx.buybackExecutor, 'LiquidityRemoved')
          .withArgs(managerAddress, LP_BALANCE, WITHDRAWN_LDO, expectedStEth)

        expect(await ctx.stubs.ldo.balanceOf(treasuryAddress)).to.equal(WITHDRAWN_LDO)
        expect(await ctx.stubs.stEth.balanceOf(treasuryAddress)).to.equal(expectedStEth)
        expect(await ctx.buybackExecutor.getLpTokenBalance()).to.equal(0n)
      })

      it('should forward the caller floors, reverting when a floor exceeds the withdrawn amount', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        const executorAddress = await ctx.buybackExecutor.getAddress()
        await ctx.stubs.pool.connect(ctx.signers.admin).mint(executorAddress, LP_BALANCE)
        await ctx.stubs.pool
          .connect(ctx.signers.admin)
          .setNextWithdrawn(WITHDRAWN_LDO, WITHDRAWN_WSTETH)

        await expect(
          ctx.buybackExecutor
            .connect(ctx.signers.manager)
            .removeLiquidityAndRecoverToTreasury(LP_BALANCE, WITHDRAWN_LDO, WITHDRAWN_WSTETH + 1n)
        ).to.be.revertedWithCustomError(ctx.stubs.pool, 'CurveWithdrawalBelowFloor')
      })
    })
  })

  describe('#getAvailableLiquidity', function () {
    it('should return (0, 0) when the LDO balance is 0', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await fundExecutor(ctx, { stEth: BALANCED_STETH })

      const [ldoAmount, stEthAmount] = await ctx.buybackExecutor.getAvailableLiquidity()
      expect(ldoAmount).to.equal(0n)
      expect(stEthAmount).to.equal(0n)
    })

    it('should return (0, 0) when the stETH balance is 0', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await fundExecutor(ctx, { ldo: BALANCED_LDO })

      const [ldoAmount, stEthAmount] = await ctx.buybackExecutor.getAvailableLiquidity()
      expect(ldoAmount).to.equal(0n)
      expect(stEthAmount).to.equal(0n)
    })

    it('should return (0, 0) when the oracle reverts', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await fundBalanced(ctx)
      await setOracleFailure(ctx, OracleFailureMode.CustomError)

      const [ldoAmount, stEthAmount] = await ctx.buybackExecutor.getAvailableLiquidity()
      expect(ldoAmount).to.equal(0n)
      expect(stEthAmount).to.equal(0n)
    })

    it('should return (0, 0) when an oracle price is 0', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await fundBalanced(ctx)
      await setOraclePrices(ctx, PRICE_SCALE, 0n)

      const [ldoAmount, stEthAmount] = await ctx.buybackExecutor.getAvailableLiquidity()
      expect(ldoAmount).to.equal(0n)
      expect(stEthAmount).to.equal(0n)
    })

    it('should return the uncapped balanced amounts when balances and prices are valid', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      // depositValueUsd here is 400000e18, four times the cap, yet the view returns the full legs.
      const ldoFunded = 100_000n * PRICE_SCALE
      const stEthFunded = 100n * PRICE_SCALE
      await fundExecutor(ctx, { ldo: ldoFunded, stEth: stEthFunded })

      const divergence = await ctx.harness.evaluatePoolPriceDivergence()
      const expected = await ctx.harness.computeBalancedAmounts(
        ldoFunded,
        stEthFunded,
        divergence.ldoUsdPrice,
        divergence.stEthUsdPrice
      )

      const [ldoAmount, stEthAmount] = await ctx.buybackExecutor.getAvailableLiquidity()
      expect(ldoAmount).to.equal(expected.ldoAmount)
      expect(stEthAmount).to.equal(expected.stEthAmount)
      // The uncapped LDO leg is the full balance, far above the capped 25000e18 addLiquidity uses.
      expect(ldoAmount).to.equal(ldoFunded)
    })

    it('should size by the LDO side when the LDO leg holds less USD', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const ldoFunded = 100n * PRICE_SCALE
      const stEthFunded = 1n * PRICE_SCALE
      await fundExecutor(ctx, { ldo: ldoFunded, stEth: stEthFunded })

      const divergence = await ctx.harness.evaluatePoolPriceDivergence()
      const expected = await ctx.harness.computeBalancedAmounts(
        ldoFunded,
        stEthFunded,
        divergence.ldoUsdPrice,
        divergence.stEthUsdPrice
      )

      const [ldoAmount, stEthAmount] = await ctx.buybackExecutor.getAvailableLiquidity()
      expect(ldoAmount).to.equal(ldoFunded)
      expect(stEthAmount).to.equal(expected.stEthAmount)
    })

    it('should size by the stETH side when the stETH leg holds less USD', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const ldoFunded = 10_000n * PRICE_SCALE
      const stEthFunded = PRICE_SCALE / 1000n
      await fundExecutor(ctx, { ldo: ldoFunded, stEth: stEthFunded })

      const divergence = await ctx.harness.evaluatePoolPriceDivergence()
      const expected = await ctx.harness.computeBalancedAmounts(
        ldoFunded,
        stEthFunded,
        divergence.ldoUsdPrice,
        divergence.stEthUsdPrice
      )

      const [ldoAmount, stEthAmount] = await ctx.buybackExecutor.getAvailableLiquidity()
      expect(stEthAmount).to.equal(stEthFunded)
      expect(ldoAmount).to.equal(expected.ldoAmount)
    })
  })

  describe('#canAddLiquidity', function () {
    it('should return false when paused', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await fundBalanced(ctx)
      await ctx.buybackExecutor.connect(ctx.signers.emergency).pause()

      expect(await ctx.buybackExecutor.canAddLiquidity()).to.equal(false)
    })

    it('should return true when not paused and the gates are eligible', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await fundBalanced(ctx)

      expect(await ctx.buybackExecutor.canAddLiquidity()).to.equal(true)
    })

    it('should return false when a gate fails', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      // No LDO funded, so the ZeroLdoBalance gate fails.
      await fundExecutor(ctx, { stEth: BALANCED_STETH })

      expect(await ctx.buybackExecutor.canAddLiquidity()).to.equal(false)
    })

    it('should return true for a divergent shallow pool and false once the TVL reaches the floor', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await fundBalanced(ctx)
      await makePoolDivergent(ctx)

      expect(await ctx.buybackExecutor.canAddLiquidity()).to.equal(true)

      await setPoolReserves(ctx, DEEP_LDO_RESERVE, 0n)
      expect(await ctx.buybackExecutor.canAddLiquidity()).to.equal(false)
    })
  })

  describe('#getLpTokenBalance', function () {
    it('should return the executor Curve LP token balance', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const executorAddress = await ctx.buybackExecutor.getAddress()
      await ctx.stubs.pool.connect(ctx.signers.admin).mint(executorAddress, LP_BALANCE)

      expect(await ctx.buybackExecutor.getLpTokenBalance()).to.equal(LP_BALANCE)
    })

    it('should return 0 when none is held', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)

      expect(await ctx.buybackExecutor.getLpTokenBalance()).to.equal(0n)
    })
  })
})
