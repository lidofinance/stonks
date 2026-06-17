import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'

import { StonksStub__factory, OrderStub__factory } from '../../../../typechain-types'
import {
  deployBuybackExecutorWithStubs,
  deployBuybackExecutorTreasuryMode,
  fundExecutor,
  setPoolEma,
  setPoolReserves,
  placeTrackedOrder,
  expireOrder,
  PRICE_SCALE,
  DEFAULT_BOUNDS,
  DEFAULT_ORDER_DURATION,
  DEFAULT_ADMIN_ROLE,
  EMERGENCY_ROLE,
  missingRoleMessage,
  BuybackContext,
} from '../../../helpers/buyback-executor'

const ZERO_ADDRESS = ethers.ZeroAddress

// OZ v4.9.3 reverts with strings, not the v5 custom errors.
const PAUSED_REVERT = 'Pausable: paused'
const NOT_PAUSED_REVERT = 'Pausable: not paused'

const MIN_ORDER = DEFAULT_BOUNDS.minAllowedOrderAmount // 1e18
const MAX_ORDER = DEFAULT_BOUNDS.maxAllowedOrderAmount // 1000e18
const MIN_DEPOSIT = DEFAULT_BOUNDS.minDepositValueUsd // 100e18
const MAX_DEPOSIT = DEFAULT_BOUNDS.maxDepositValueUsd // 100000e18
const DEFAULT_TOLERANCE = DEFAULT_BOUNDS.poolPriceDivergenceToleranceBps // 100
const DEFAULT_BOOTSTRAP = DEFAULT_BOUNDS.poolBootstrapMinTvlUsd // 50000e18

// Contract upper bounds, mirrored from BuybackExecutor.
const MAX_TOLERANCE_BPS = 1000n
const MAX_BOOTSTRAP = 1_000_000n * PRICE_SCALE

// Order duration the swapped-in Stonks reports, distinct from the default so the refresh is visible.
const SWAPPED_ORDER_DURATION = 7200n

// Residual stETH left on a swept order, above the 10 wei recovery threshold.
const ORDER_RESIDUAL = 1000n

// Balanced LDO/stETH funding at the default prices, both legs worth equal USD.
const BALANCED_LDO = 1750n * PRICE_SCALE
const BALANCED_STETH = 1n * PRICE_SCALE

// LDO reserve only, valuing the pool TVL at 100000e18 at the default LDO price, above DEFAULT_BOOTSTRAP.
const DEEP_LDO_RESERVE = 50_000n * PRICE_SCALE
const POOL_TVL_AT_DEEP_RESERVE = 100_000n * PRICE_SCALE

// removeLiquidity setup: held LP and the amounts the pool returns on withdrawal.
const LP_BALANCE = 1000n * PRICE_SCALE
const WITHDRAWN_LDO = 500n * PRICE_SCALE
const WITHDRAWN_WSTETH = 10n * PRICE_SCALE

async function deployStonks(
  ctx: BuybackContext,
  receiver: string,
  duration: bigint = DEFAULT_ORDER_DURATION
): Promise<string> {
  const stonks = await new StonksStub__factory(ctx.signers.deployer).deploy()
  await stonks.connect(ctx.signers.admin).setReceiver(receiver)
  await stonks.connect(ctx.signers.admin).setOrderDuration(duration)
  return stonks.getAddress()
}

async function recoverTokenFromCalls(orderAddress: string): Promise<bigint> {
  return OrderStub__factory.connect(orderAddress, ethers.provider).recoverTokenFromCalls()
}

// Pushes the pool EMA 5% off the oracle ratio, scoring 500 bps past the 100 bps tolerance.
async function makePoolDivergent(ctx: BuybackContext): Promise<void> {
  const currentEma = await ctx.stubs.pool.priceOracleValue()
  await setPoolEma(ctx, (currentEma * 105n) / 100n)
}

describe('BuybackExecutor — admin, mode, setters', function () {
  describe('#setStonksAndOperatingMode', function () {
    it('should revert for a non-DEFAULT_ADMIN_ROLE caller', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const strangerAddress = await ctx.signers.stranger.getAddress()
      const newStonks = await deployStonks(ctx, await ctx.buybackExecutor.getAddress())

      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).setStonksAndOperatingMode(newStonks)
      ).to.be.revertedWith(missingRoleMessage(strangerAddress, DEFAULT_ADMIN_ROLE))
    })

    it('should revert InvalidStonksAddress when the new Stonks is the zero address', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)

      await expect(
        ctx.buybackExecutor.connect(ctx.signers.admin).setStonksAndOperatingMode(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'InvalidStonksAddress')
    })

    it('should revert InvalidStonksReceiver when the receiver is neither this contract nor TREASURY', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const strangerAddress = await ctx.signers.stranger.getAddress()
      const newStonks = await deployStonks(ctx, strangerAddress)

      await expect(
        ctx.buybackExecutor.connect(ctx.signers.admin).setStonksAndOperatingMode(newStonks)
      )
        .to.be.revertedWithCustomError(ctx.buybackExecutor, 'InvalidStonksReceiver')
        .withArgs(newStonks, strangerAddress)
    })

    it('should derive LP mode and refresh stonks and order duration when the receiver is this contract', async function () {
      const ctx = await loadFixture(deployBuybackExecutorTreasuryMode)
      const executorAddress = await ctx.buybackExecutor.getAddress()
      const newStonks = await deployStonks(ctx, executorAddress, SWAPPED_ORDER_DURATION)

      await ctx.buybackExecutor.connect(ctx.signers.admin).setStonksAndOperatingMode(newStonks)

      expect(await ctx.buybackExecutor.lpModeEnabled()).to.equal(true)
      expect(await ctx.buybackExecutor.stonks()).to.equal(newStonks)
      expect(await ctx.buybackExecutor.stonksOrderDurationSeconds()).to.equal(SWAPPED_ORDER_DURATION)
    })

    it('should derive treasury mode when the receiver is TREASURY', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const treasuryAddress = await ctx.signers.treasury.getAddress()
      const newStonks = await deployStonks(ctx, treasuryAddress)

      await ctx.buybackExecutor.connect(ctx.signers.admin).setStonksAndOperatingMode(newStonks)

      expect(await ctx.buybackExecutor.lpModeEnabled()).to.equal(false)
      expect(await ctx.buybackExecutor.stonks()).to.equal(newStonks)
    })

    it('should sweep an expired tracked order, recover its residual, and clear tracking', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const orderAddress = await placeTrackedOrder(ctx)
      await ctx.stubs.stEth.connect(ctx.signers.admin).mint(orderAddress, ORDER_RESIDUAL)
      await expireOrder(ctx)
      const sameStonks = await ctx.stubs.stonks.getAddress()

      await expect(
        ctx.buybackExecutor.connect(ctx.signers.admin).setStonksAndOperatingMode(sameStonks)
      )
        .to.emit(ctx.buybackExecutor, 'StaleOrderCleared')
        .withArgs(orderAddress)

      expect(await ctx.buybackExecutor.lastOrderAddress()).to.equal(ZERO_ADDRESS)
      expect(await recoverTokenFromCalls(orderAddress)).to.equal(1n)
    })

    it('should abandon a still-live order, clearing tracking without recovering it', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const orderAddress = await placeTrackedOrder(ctx)
      const validTo = await ctx.buybackExecutor.lastOrderValidTo()
      const sameStonks = await ctx.stubs.stonks.getAddress()

      await expect(
        ctx.buybackExecutor.connect(ctx.signers.admin).setStonksAndOperatingMode(sameStonks)
      )
        .to.emit(ctx.buybackExecutor, 'OrderAbandoned')
        .withArgs(orderAddress, validTo)

      expect(await ctx.buybackExecutor.lastOrderAddress()).to.equal(ZERO_ADDRESS)
      expect(await recoverTokenFromCalls(orderAddress)).to.equal(0n)
    })

    it('should emit StonksAndOperatingModeSet with the previous and new Stonks and modes', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const previousStonks = await ctx.stubs.stonks.getAddress()
      const treasuryAddress = await ctx.signers.treasury.getAddress()
      const newStonks = await deployStonks(ctx, treasuryAddress)

      await expect(
        ctx.buybackExecutor.connect(ctx.signers.admin).setStonksAndOperatingMode(newStonks)
      )
        .to.emit(ctx.buybackExecutor, 'StonksAndOperatingModeSet')
        .withArgs(previousStonks, newStonks, true, false)
    })
  })

  describe('#pause and #unpause', function () {
    it('should revert pause for a non-EMERGENCY_ROLE caller', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const strangerAddress = await ctx.signers.stranger.getAddress()

      await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).pause()).to.be.revertedWith(
        missingRoleMessage(strangerAddress, EMERGENCY_ROLE)
      )
    })

    it('should revert pause when already paused', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await ctx.buybackExecutor.connect(ctx.signers.emergency).pause()

      await expect(ctx.buybackExecutor.connect(ctx.signers.emergency).pause()).to.be.revertedWith(
        PAUSED_REVERT
      )
    })

    it('should revert unpause for a non-EMERGENCY_ROLE caller', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const strangerAddress = await ctx.signers.stranger.getAddress()
      await ctx.buybackExecutor.connect(ctx.signers.emergency).pause()

      await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).unpause()).to.be.revertedWith(
        missingRoleMessage(strangerAddress, EMERGENCY_ROLE)
      )
    })

    it('should revert unpause when not paused', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)

      await expect(
        ctx.buybackExecutor.connect(ctx.signers.emergency).unpause()
      ).to.be.revertedWith(NOT_PAUSED_REVERT)
    })

    it('should block addLiquidity, onStEthAllocated, and placeOrder while paused', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await ctx.buybackExecutor.connect(ctx.signers.emergency).pause()

      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
      ).to.be.revertedWith(PAUSED_REVERT)
      await expect(
        ctx.buybackExecutor.connect(ctx.signers.allocator).onStEthAllocated()
      ).to.be.revertedWith(PAUSED_REVERT)
      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).placeOrder()
      ).to.be.revertedWith(PAUSED_REVERT)
    })

    it('should leave removeLiquidityAndRecoverToTreasury callable while paused', async function () {
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

    it('should emit Paused on pause and Unpaused on unpause with the caller', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const emergencyAddress = await ctx.signers.emergency.getAddress()

      await expect(ctx.buybackExecutor.connect(ctx.signers.emergency).pause())
        .to.emit(ctx.buybackExecutor, 'Paused')
        .withArgs(emergencyAddress)
      await expect(ctx.buybackExecutor.connect(ctx.signers.emergency).unpause())
        .to.emit(ctx.buybackExecutor, 'Unpaused')
        .withArgs(emergencyAddress)
    })
  })

  describe('Stonks forwarding', function () {
    it('should revert all four forwards for a non-EMERGENCY_ROLE caller', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const strangerAddress = await ctx.signers.stranger.getAddress()
      const message = missingRoleMessage(strangerAddress, EMERGENCY_ROLE)
      const executor = ctx.buybackExecutor.connect(ctx.signers.stranger)

      await expect(executor.pauseStonksCreation()).to.be.revertedWith(message)
      await expect(executor.unpauseStonksCreation()).to.be.revertedWith(message)
      await expect(executor.pauseStonksSignatures()).to.be.revertedWith(message)
      await expect(executor.unpauseStonksSignatures()).to.be.revertedWith(message)
    })

    it('should forward pauseCreation to the active Stonks', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await ctx.buybackExecutor.connect(ctx.signers.emergency).pauseStonksCreation()

      expect(await ctx.stubs.stonks.pauseCreationCalls()).to.equal(1n)
    })

    it('should forward unpauseCreation to the active Stonks', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await ctx.buybackExecutor.connect(ctx.signers.emergency).unpauseStonksCreation()

      expect(await ctx.stubs.stonks.unpauseCreationCalls()).to.equal(1n)
    })

    it('should forward pauseSignatures to the active Stonks', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await ctx.buybackExecutor.connect(ctx.signers.emergency).pauseStonksSignatures()

      expect(await ctx.stubs.stonks.pauseSignaturesCalls()).to.equal(1n)
    })

    it('should forward unpauseSignatures to the active Stonks', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await ctx.buybackExecutor.connect(ctx.signers.emergency).unpauseStonksSignatures()

      expect(await ctx.stubs.stonks.unpauseSignaturesCalls()).to.equal(1n)
    })

    it('should propagate the Stonks revert when this contract lacks the manager rights', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await ctx.stubs.stonks.connect(ctx.signers.admin).setRevertOnRightsCall(true)
      const executor = ctx.buybackExecutor.connect(ctx.signers.emergency)

      await expect(executor.pauseStonksCreation()).to.be.revertedWithCustomError(
        ctx.stubs.stonks,
        'MissingStonksRights'
      )
      await expect(executor.unpauseStonksCreation()).to.be.revertedWithCustomError(
        ctx.stubs.stonks,
        'MissingStonksRights'
      )
      await expect(executor.pauseStonksSignatures()).to.be.revertedWithCustomError(
        ctx.stubs.stonks,
        'MissingStonksRights'
      )
      await expect(executor.unpauseStonksSignatures()).to.be.revertedWithCustomError(
        ctx.stubs.stonks,
        'MissingStonksRights'
      )
    })
  })

  describe('#setPoolPriceDivergenceToleranceBps', function () {
    it('should revert for a non-DEFAULT_ADMIN_ROLE caller', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const strangerAddress = await ctx.signers.stranger.getAddress()

      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).setPoolPriceDivergenceToleranceBps(50n)
      ).to.be.revertedWith(missingRoleMessage(strangerAddress, DEFAULT_ADMIN_ROLE))
    })

    it('should revert InvalidPoolPriceDivergenceTolerance when zero', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)

      await expect(
        ctx.buybackExecutor.connect(ctx.signers.admin).setPoolPriceDivergenceToleranceBps(0n)
      )
        .to.be.revertedWithCustomError(ctx.buybackExecutor, 'InvalidPoolPriceDivergenceTolerance')
        .withArgs(0n)
    })

    it('should revert InvalidPoolPriceDivergenceTolerance above the maximum', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const aboveMax = MAX_TOLERANCE_BPS + 1n

      await expect(
        ctx.buybackExecutor
          .connect(ctx.signers.admin)
          .setPoolPriceDivergenceToleranceBps(aboveMax)
      )
        .to.be.revertedWithCustomError(ctx.buybackExecutor, 'InvalidPoolPriceDivergenceTolerance')
        .withArgs(aboveMax)
    })

    it('should set and emit at the upper boundary', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)

      await expect(
        ctx.buybackExecutor
          .connect(ctx.signers.admin)
          .setPoolPriceDivergenceToleranceBps(MAX_TOLERANCE_BPS)
      )
        .to.emit(ctx.buybackExecutor, 'PoolPriceDivergenceToleranceBpsSet')
        .withArgs(DEFAULT_TOLERANCE, MAX_TOLERANCE_BPS)

      expect(await ctx.buybackExecutor.poolPriceDivergenceToleranceBps()).to.equal(MAX_TOLERANCE_BPS)
    })

    it('should set and emit at the lower boundary of one', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)

      await expect(
        ctx.buybackExecutor.connect(ctx.signers.admin).setPoolPriceDivergenceToleranceBps(1n)
      )
        .to.emit(ctx.buybackExecutor, 'PoolPriceDivergenceToleranceBpsSet')
        .withArgs(DEFAULT_TOLERANCE, 1n)

      expect(await ctx.buybackExecutor.poolPriceDivergenceToleranceBps()).to.equal(1n)
    })
  })

  describe('#setMinAllowedOrderAmount', function () {
    it('should revert for a non-DEFAULT_ADMIN_ROLE caller', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const strangerAddress = await ctx.signers.stranger.getAddress()

      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).setMinAllowedOrderAmount(2n * MIN_ORDER)
      ).to.be.revertedWith(missingRoleMessage(strangerAddress, DEFAULT_ADMIN_ROLE))
    })

    it('should revert InvalidOrderAmountLimits when zero', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)

      await expect(ctx.buybackExecutor.connect(ctx.signers.admin).setMinAllowedOrderAmount(0n))
        .to.be.revertedWithCustomError(ctx.buybackExecutor, 'InvalidOrderAmountLimits')
        .withArgs(0n, MAX_ORDER)
    })

    it('should revert InvalidOrderAmountLimits when not below the maximum', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)

      await expect(
        ctx.buybackExecutor.connect(ctx.signers.admin).setMinAllowedOrderAmount(MAX_ORDER)
      )
        .to.be.revertedWithCustomError(ctx.buybackExecutor, 'InvalidOrderAmountLimits')
        .withArgs(MAX_ORDER, MAX_ORDER)
    })

    it('should set and emit at the upper boundary one below the maximum', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const newMin = MAX_ORDER - 1n

      await expect(ctx.buybackExecutor.connect(ctx.signers.admin).setMinAllowedOrderAmount(newMin))
        .to.emit(ctx.buybackExecutor, 'MinAllowedOrderAmountSet')
        .withArgs(MIN_ORDER, newMin)

      expect(await ctx.buybackExecutor.minAllowedOrderAmount()).to.equal(newMin)
    })
  })

  describe('#setMaxAllowedOrderAmount', function () {
    it('should revert for a non-DEFAULT_ADMIN_ROLE caller', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const strangerAddress = await ctx.signers.stranger.getAddress()

      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).setMaxAllowedOrderAmount(2n * MAX_ORDER)
      ).to.be.revertedWith(missingRoleMessage(strangerAddress, DEFAULT_ADMIN_ROLE))
    })

    it('should revert InvalidOrderAmountLimits when zero', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)

      await expect(ctx.buybackExecutor.connect(ctx.signers.admin).setMaxAllowedOrderAmount(0n))
        .to.be.revertedWithCustomError(ctx.buybackExecutor, 'InvalidOrderAmountLimits')
        .withArgs(MIN_ORDER, 0n)
    })

    it('should revert InvalidOrderAmountLimits when not above the minimum', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)

      await expect(
        ctx.buybackExecutor.connect(ctx.signers.admin).setMaxAllowedOrderAmount(MIN_ORDER)
      )
        .to.be.revertedWithCustomError(ctx.buybackExecutor, 'InvalidOrderAmountLimits')
        .withArgs(MIN_ORDER, MIN_ORDER)
    })

    it('should set and emit at the lower boundary one above the minimum', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const newMax = MIN_ORDER + 1n

      await expect(ctx.buybackExecutor.connect(ctx.signers.admin).setMaxAllowedOrderAmount(newMax))
        .to.emit(ctx.buybackExecutor, 'MaxAllowedOrderAmountSet')
        .withArgs(MAX_ORDER, newMax)

      expect(await ctx.buybackExecutor.maxAllowedOrderAmount()).to.equal(newMax)
    })
  })

  describe('#setMinDepositValueUsd', function () {
    it('should revert for a non-DEFAULT_ADMIN_ROLE caller', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const strangerAddress = await ctx.signers.stranger.getAddress()

      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).setMinDepositValueUsd(2n * MIN_DEPOSIT)
      ).to.be.revertedWith(missingRoleMessage(strangerAddress, DEFAULT_ADMIN_ROLE))
    })

    it('should revert InvalidDepositValueLimits when zero', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)

      await expect(ctx.buybackExecutor.connect(ctx.signers.admin).setMinDepositValueUsd(0n))
        .to.be.revertedWithCustomError(ctx.buybackExecutor, 'InvalidDepositValueLimits')
        .withArgs(0n, MAX_DEPOSIT)
    })

    it('should revert InvalidDepositValueLimits when not below the maximum', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)

      await expect(
        ctx.buybackExecutor.connect(ctx.signers.admin).setMinDepositValueUsd(MAX_DEPOSIT)
      )
        .to.be.revertedWithCustomError(ctx.buybackExecutor, 'InvalidDepositValueLimits')
        .withArgs(MAX_DEPOSIT, MAX_DEPOSIT)
    })

    it('should set and emit at the upper boundary one below the maximum', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const newMin = MAX_DEPOSIT - 1n

      await expect(ctx.buybackExecutor.connect(ctx.signers.admin).setMinDepositValueUsd(newMin))
        .to.emit(ctx.buybackExecutor, 'MinDepositValueUsdSet')
        .withArgs(MIN_DEPOSIT, newMin)

      expect(await ctx.buybackExecutor.minDepositValueUsd()).to.equal(newMin)
    })
  })

  describe('#setMaxDepositValueUsd', function () {
    it('should revert for a non-DEFAULT_ADMIN_ROLE caller', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const strangerAddress = await ctx.signers.stranger.getAddress()

      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).setMaxDepositValueUsd(2n * MAX_DEPOSIT)
      ).to.be.revertedWith(missingRoleMessage(strangerAddress, DEFAULT_ADMIN_ROLE))
    })

    it('should revert InvalidDepositValueLimits when zero', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)

      await expect(ctx.buybackExecutor.connect(ctx.signers.admin).setMaxDepositValueUsd(0n))
        .to.be.revertedWithCustomError(ctx.buybackExecutor, 'InvalidDepositValueLimits')
        .withArgs(MIN_DEPOSIT, 0n)
    })

    it('should revert InvalidDepositValueLimits when not above the minimum', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)

      await expect(
        ctx.buybackExecutor.connect(ctx.signers.admin).setMaxDepositValueUsd(MIN_DEPOSIT)
      )
        .to.be.revertedWithCustomError(ctx.buybackExecutor, 'InvalidDepositValueLimits')
        .withArgs(MIN_DEPOSIT, MIN_DEPOSIT)
    })

    it('should set and emit at the lower boundary one above the minimum', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const newMax = MIN_DEPOSIT + 1n

      await expect(ctx.buybackExecutor.connect(ctx.signers.admin).setMaxDepositValueUsd(newMax))
        .to.emit(ctx.buybackExecutor, 'MaxDepositValueUsdSet')
        .withArgs(MAX_DEPOSIT, newMax)

      expect(await ctx.buybackExecutor.maxDepositValueUsd()).to.equal(newMax)
    })
  })

  describe('#setPoolBootstrapMinTvlUsd', function () {
    it('should revert for a non-DEFAULT_ADMIN_ROLE caller', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const strangerAddress = await ctx.signers.stranger.getAddress()

      await expect(
        ctx.buybackExecutor
          .connect(ctx.signers.stranger)
          .setPoolBootstrapMinTvlUsd(DEFAULT_BOOTSTRAP)
      ).to.be.revertedWith(missingRoleMessage(strangerAddress, DEFAULT_ADMIN_ROLE))
    })

    it('should revert InvalidPoolBootstrapMinTvlUsd when zero', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)

      await expect(ctx.buybackExecutor.connect(ctx.signers.admin).setPoolBootstrapMinTvlUsd(0n))
        .to.be.revertedWithCustomError(ctx.buybackExecutor, 'InvalidPoolBootstrapMinTvlUsd')
        .withArgs(0n)
    })

    it('should revert InvalidPoolBootstrapMinTvlUsd above the maximum', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const aboveMax = MAX_BOOTSTRAP + 1n

      await expect(
        ctx.buybackExecutor.connect(ctx.signers.admin).setPoolBootstrapMinTvlUsd(aboveMax)
      )
        .to.be.revertedWithCustomError(ctx.buybackExecutor, 'InvalidPoolBootstrapMinTvlUsd')
        .withArgs(aboveMax)
    })

    it('should set and emit at the upper boundary', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)

      await expect(
        ctx.buybackExecutor.connect(ctx.signers.admin).setPoolBootstrapMinTvlUsd(MAX_BOOTSTRAP)
      )
        .to.emit(ctx.buybackExecutor, 'PoolBootstrapMinTvlUsdSet')
        .withArgs(DEFAULT_BOOTSTRAP, MAX_BOOTSTRAP)

      expect(await ctx.buybackExecutor.poolBootstrapMinTvlUsd()).to.equal(MAX_BOOTSTRAP)
    })

    it('should re-open the divergence bypass when raised above the current pool TVL', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await fundExecutor(ctx, { ldo: BALANCED_LDO, stEth: BALANCED_STETH })
      await makePoolDivergent(ctx)
      await setPoolReserves(ctx, DEEP_LDO_RESERVE, 0n)

      // At the default bootstrap the TVL clears the floor, so the divergence gate enforces.
      await expect(
        ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()
      ).to.be.revertedWithCustomError(ctx.buybackExecutor, 'PoolPriceDivergenceTooHigh')

      const aboveTvl = POOL_TVL_AT_DEEP_RESERVE + 1n
      await ctx.buybackExecutor.connect(ctx.signers.admin).setPoolBootstrapMinTvlUsd(aboveTvl)

      await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).addLiquidity()).to.emit(
        ctx.buybackExecutor,
        'LiquidityAdded'
      )
    })
  })
})
