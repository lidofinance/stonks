import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'

import {
  deployBuybackExecutorWithStubs,
  deployBuybackExecutorTreasuryMode,
  fundExecutor,
  setOracleFailure,
  placeTrackedOrder,
  expireOrder,
  OracleFailureMode,
  PRICE_SCALE,
  DEFAULT_BOUNDS,
  DEFAULT_ORDER_DURATION,
  ALLOCATOR_ROLE,
  missingRoleMessage,
  BuybackContext,
} from '../../../helpers/buyback-executor'

const ZERO_ADDRESS = ethers.ZeroAddress

// OZ v4.9.3 reverts with a string, not the v5 custom error `EnforcedPause`.
const PAUSED_REVERT = 'Pausable: paused'

const MIN_ORDER = DEFAULT_BOUNDS.minAllowedOrderAmount // 1e18
const MAX_ORDER = DEFAULT_BOUNDS.maxAllowedOrderAmount // 1000e18

// Free stETH that halves (LP) or forwards whole (treasury) to a sell above MIN_ORDER.
const FREE_STETH = 100n * PRICE_SCALE
// Halves to 0.5e18, below MIN_ORDER, so an LP-mode allocation forwards nothing.
const LP_SUBTHRESHOLD_STETH = 1n * PRICE_SCALE
// Below MIN_ORDER, so a treasury-mode allocation forwards nothing.
const BELOW_MIN = PRICE_SCALE / 2n

// LDO held against the next deposit. At the default 2/3500 LDO/stETH price this reserves 2e18 stETH.
const RESERVED_LDO = 3500n * PRICE_SCALE

// Stonks stETH balance between MIN_ORDER and MAX_ORDER, so the sell sizes to the balance itself.
const SELL_BELOW_CAP = 500n * PRICE_SCALE
// Above MAX_ORDER, so the sell clamps to the cap.
const SELL_ABOVE_CAP = 2000n * PRICE_SCALE
// Non-zero trade estimate, the minBuyAmount the order carries.
const ESTIMATE = 42n * PRICE_SCALE

async function fundStonks(ctx: BuybackContext, amount: bigint): Promise<void> {
  await ctx.stubs.stEth.connect(ctx.signers.admin).mint(await ctx.stubs.stonks.getAddress(), amount)
}

async function setEstimate(ctx: BuybackContext, value: bigint): Promise<void> {
  await ctx.stubs.stonks.connect(ctx.signers.admin).setEstimatedOutput(value)
}

describe('BuybackExecutor — allocation and orders', function () {
  describe('#onStEthAllocated', function () {
    describe('access and modifiers:', function () {
      it('should revert for a non-ALLOCATOR_ROLE caller', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        const strangerAddress = await ctx.signers.stranger.getAddress()

        await expect(
          ctx.buybackExecutor.connect(ctx.signers.stranger).onStEthAllocated()
        ).to.be.revertedWith(missingRoleMessage(strangerAddress, ALLOCATOR_ROLE))
      })

      it('should revert when paused', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await ctx.buybackExecutor.connect(ctx.signers.emergency).pause()

        await expect(
          ctx.buybackExecutor.connect(ctx.signers.allocator).onStEthAllocated()
        ).to.be.revertedWith(PAUSED_REVERT)
      })
    })

    describe('sweep first:', function () {
      it('should sweep an expired tracked order, emit StaleOrderCleared, and clear the pointer', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        const orderAddress = await placeTrackedOrder(ctx)
        await expireOrder(ctx)

        await expect(ctx.buybackExecutor.connect(ctx.signers.allocator).onStEthAllocated())
          .to.emit(ctx.buybackExecutor, 'StaleOrderCleared')
          .withArgs(orderAddress)

        expect(await ctx.buybackExecutor.lastOrderAddress()).to.equal(ZERO_ADDRESS)
      })
    })

    describe('LP mode:', function () {
      it('should forward half of the free stETH and emit AllocationProcessed', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundExecutor(ctx, { stEth: FREE_STETH })
        const executorAddress = await ctx.buybackExecutor.getAddress()
        const stonksAddress = await ctx.stubs.stonks.getAddress()

        // No LDO held, so nothing is reserved and the free amount equals the stETH balance.
        const sellAmount = FREE_STETH / 2n

        await expect(ctx.buybackExecutor.connect(ctx.signers.allocator).onStEthAllocated())
          .to.emit(ctx.buybackExecutor, 'AllocationProcessed')
          .withArgs(stonksAddress, FREE_STETH, sellAmount)

        expect(await ctx.stubs.stEth.balanceOf(stonksAddress)).to.equal(sellAmount)
        expect(await ctx.stubs.stEth.balanceOf(executorAddress)).to.equal(FREE_STETH - sellAmount)
      })

      it('should reserve held LDO from the free stETH before halving', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundExecutor(ctx, { ldo: RESERVED_LDO, stEth: FREE_STETH })
        const stonksAddress = await ctx.stubs.stonks.getAddress()

        // freeStEth excludes the stETH value of the held LDO, so it sits below the raw balance.
        const freeStEth = await ctx.harness.computeLpModeFreeStEth()
        expect(freeStEth).to.be.lessThan(FREE_STETH)
        const sellAmount = freeStEth / 2n

        await expect(ctx.buybackExecutor.connect(ctx.signers.allocator).onStEthAllocated())
          .to.emit(ctx.buybackExecutor, 'AllocationProcessed')
          .withArgs(stonksAddress, freeStEth, sellAmount)

        expect(await ctx.stubs.stEth.balanceOf(stonksAddress)).to.equal(sellAmount)
      })

      it('should forward nothing and emit a zero sell when half the free stETH is below the minimum', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundExecutor(ctx, { stEth: LP_SUBTHRESHOLD_STETH })
        const executorAddress = await ctx.buybackExecutor.getAddress()
        const stonksAddress = await ctx.stubs.stonks.getAddress()

        await expect(ctx.buybackExecutor.connect(ctx.signers.allocator).onStEthAllocated())
          .to.emit(ctx.buybackExecutor, 'AllocationProcessed')
          .withArgs(stonksAddress, LP_SUBTHRESHOLD_STETH, 0n)

        expect(await ctx.stubs.stEth.balanceOf(stonksAddress)).to.equal(0n)
        expect(await ctx.stubs.stEth.balanceOf(executorAddress)).to.equal(LP_SUBTHRESHOLD_STETH)
      })

      it('should not revert and emit a zero free amount when the oracle is unavailable', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        // LDO held forces the price read inside `_computeLpModeFreeStEth`, which returns 0 on failure.
        await fundExecutor(ctx, { ldo: RESERVED_LDO, stEth: FREE_STETH })
        await setOracleFailure(ctx, OracleFailureMode.CustomError)
        const stonksAddress = await ctx.stubs.stonks.getAddress()

        await expect(ctx.buybackExecutor.connect(ctx.signers.allocator).onStEthAllocated())
          .to.emit(ctx.buybackExecutor, 'AllocationProcessed')
          .withArgs(stonksAddress, 0n, 0n)

        expect(await ctx.stubs.stEth.balanceOf(stonksAddress)).to.equal(0n)
      })
    })

    describe('treasury mode:', function () {
      it('should forward the full stETH balance, ignoring held LDO', async function () {
        const ctx = await loadFixture(deployBuybackExecutorTreasuryMode)
        // LDO is not reserved in treasury mode, so the whole stETH balance forwards.
        await fundExecutor(ctx, { ldo: RESERVED_LDO, stEth: FREE_STETH })
        const executorAddress = await ctx.buybackExecutor.getAddress()
        const stonksAddress = await ctx.stubs.stonks.getAddress()

        await expect(ctx.buybackExecutor.connect(ctx.signers.allocator).onStEthAllocated())
          .to.emit(ctx.buybackExecutor, 'AllocationProcessed')
          .withArgs(stonksAddress, FREE_STETH, FREE_STETH)

        expect(await ctx.stubs.stEth.balanceOf(stonksAddress)).to.equal(FREE_STETH)
        expect(await ctx.stubs.stEth.balanceOf(executorAddress)).to.equal(0n)
      })

      it('should forward nothing and emit a zero sell when the balance is below the minimum', async function () {
        const ctx = await loadFixture(deployBuybackExecutorTreasuryMode)
        await fundExecutor(ctx, { stEth: BELOW_MIN })
        const executorAddress = await ctx.buybackExecutor.getAddress()
        const stonksAddress = await ctx.stubs.stonks.getAddress()

        await expect(ctx.buybackExecutor.connect(ctx.signers.allocator).onStEthAllocated())
          .to.emit(ctx.buybackExecutor, 'AllocationProcessed')
          .withArgs(stonksAddress, BELOW_MIN, 0n)

        expect(await ctx.stubs.stEth.balanceOf(stonksAddress)).to.equal(0n)
        expect(await ctx.stubs.stEth.balanceOf(executorAddress)).to.equal(BELOW_MIN)
      })
    })
  })

  describe('#placeOrder', function () {
    describe('access and modifiers:', function () {
      it('should allow any account to call', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundStonks(ctx, SELL_BELOW_CAP)
        await setEstimate(ctx, ESTIMATE)

        await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).placeOrder()).to.emit(
          ctx.buybackExecutor,
          'OrderPlaced'
        )
      })

      it('should revert when paused', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundStonks(ctx, SELL_BELOW_CAP)
        await setEstimate(ctx, ESTIMATE)
        await ctx.buybackExecutor.connect(ctx.signers.emergency).pause()

        await expect(
          ctx.buybackExecutor.connect(ctx.signers.stranger).placeOrder()
        ).to.be.revertedWith(PAUSED_REVERT)
      })
    })

    describe('sweep and live order:', function () {
      it('should sweep an expired order first and place a new one', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        const firstOrder = await placeTrackedOrder(ctx)
        await expireOrder(ctx)

        const tx = ctx.buybackExecutor.connect(ctx.signers.stranger).placeOrder()
        await expect(tx).to.emit(ctx.buybackExecutor, 'StaleOrderCleared').withArgs(firstOrder)

        const newOrder = await ctx.buybackExecutor.lastOrderAddress()
        expect(newOrder).to.equal(await ctx.stubs.stonks.lastOrder())
        expect(newOrder).to.not.equal(firstOrder)
        expect(newOrder).to.not.equal(ZERO_ADDRESS)
      })

      it('should revert LiveOrderInPlace when a still-live order survives the sweep', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        const order = await placeTrackedOrder(ctx)
        const validTo = await ctx.buybackExecutor.lastOrderValidTo()

        await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).placeOrder())
          .to.be.revertedWithCustomError(ctx.buybackExecutor, 'LiveOrderInPlace')
          .withArgs(order, validTo)
      })
    })

    describe('validation and sizing:', function () {
      it('should revert InsufficientStonksBalance when the sized sell is below the minimum', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundStonks(ctx, BELOW_MIN)
        await setEstimate(ctx, ESTIMATE)

        await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).placeOrder())
          .to.be.revertedWithCustomError(ctx.buybackExecutor, 'InsufficientStonksBalance')
          .withArgs(BELOW_MIN, MIN_ORDER)
      })

      it('should clamp the sell to maxAllowedOrderAmount when the stonks balance exceeds the cap', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundStonks(ctx, SELL_ABOVE_CAP)
        await setEstimate(ctx, ESTIMATE)

        const expectedOrder = await ctx.buybackExecutor
          .connect(ctx.signers.stranger)
          .placeOrder.staticCall()

        await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).placeOrder())
          .to.emit(ctx.buybackExecutor, 'OrderPlaced')
          .withArgs(expectedOrder, MAX_ORDER, ESTIMATE)

        expect(await ctx.stubs.stonks.lastSellAmount()).to.equal(MAX_ORDER)
      })

      it('should place when the stonks balance equals the minimum', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundStonks(ctx, MIN_ORDER)
        await setEstimate(ctx, ESTIMATE)

        const expectedOrder = await ctx.buybackExecutor
          .connect(ctx.signers.stranger)
          .placeOrder.staticCall()

        await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).placeOrder())
          .to.emit(ctx.buybackExecutor, 'OrderPlaced')
          .withArgs(expectedOrder, MIN_ORDER, ESTIMATE)
      })
    })

    describe('happy path, state, events:', function () {
      it('should place the order, record the sizing on Stonks, and emit OrderPlaced', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundStonks(ctx, SELL_BELOW_CAP)
        await setEstimate(ctx, ESTIMATE)

        const expectedOrder = await ctx.buybackExecutor
          .connect(ctx.signers.stranger)
          .placeOrder.staticCall()

        await expect(ctx.buybackExecutor.connect(ctx.signers.stranger).placeOrder())
          .to.emit(ctx.buybackExecutor, 'OrderPlaced')
          .withArgs(expectedOrder, SELL_BELOW_CAP, ESTIMATE)

        expect(await ctx.stubs.stonks.lastSellAmount()).to.equal(SELL_BELOW_CAP)
        expect(await ctx.stubs.stonks.lastMinBuyAmount()).to.equal(ESTIMATE)
        expect(await ctx.buybackExecutor.lastOrderAddress()).to.equal(expectedOrder)
      })

      it('should return the placed order address', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundStonks(ctx, SELL_BELOW_CAP)
        await setEstimate(ctx, ESTIMATE)

        const returnedOrder = await ctx.buybackExecutor
          .connect(ctx.signers.stranger)
          .placeOrder.staticCall()
        await ctx.buybackExecutor.connect(ctx.signers.stranger).placeOrder()

        expect(returnedOrder).to.equal(await ctx.buybackExecutor.lastOrderAddress())
        expect(returnedOrder).to.equal(await ctx.stubs.stonks.lastOrder())
      })

      it('should track lastOrderValidTo as the placement timestamp plus the order duration', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundStonks(ctx, SELL_BELOW_CAP)
        await setEstimate(ctx, ESTIMATE)

        const tx = await ctx.buybackExecutor.connect(ctx.signers.stranger).placeOrder()
        const receipt = await tx.wait()
        const block = await ethers.provider.getBlock(receipt!.blockNumber)

        expect(await ctx.buybackExecutor.lastOrderValidTo()).to.equal(
          BigInt(block!.timestamp) + DEFAULT_ORDER_DURATION
        )
      })

      it('should propagate the revert when estimateTradeOutput reverts', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundStonks(ctx, SELL_BELOW_CAP)
        await ctx.stubs.stonks.connect(ctx.signers.admin).setRevertEstimate(true)

        await expect(
          ctx.buybackExecutor.connect(ctx.signers.stranger).placeOrder()
        ).to.be.revertedWithCustomError(ctx.stubs.stonks, 'EstimateReverted')
      })
    })
  })

  describe('#getPlacementStatus', function () {
    it('should mirror isStonksCreationPaused and isStonksKilled from the Stonks', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await ctx.stubs.stonks.connect(ctx.signers.admin).setCreationPaused(true)
      await ctx.stubs.stonks.connect(ctx.signers.admin).setKilled(true)

      const status = await ctx.buybackExecutor.getPlacementStatus()
      expect(status.isStonksCreationPaused).to.equal(true)
      expect(status.isStonksKilled).to.equal(true)
    })

    it('should populate activeOrder and activeOrderValidTo for a live tracked order', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      const order = await placeTrackedOrder(ctx)
      const validTo = await ctx.buybackExecutor.lastOrderValidTo()

      const status = await ctx.buybackExecutor.getPlacementStatus()
      expect(status.activeOrder).to.equal(order)
      expect(status.activeOrderValidTo).to.equal(validTo)
    })

    it('should report activeOrder as the zero address for an expired tracked order', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await placeTrackedOrder(ctx)
      await expireOrder(ctx)

      const status = await ctx.buybackExecutor.getPlacementStatus()
      expect(status.activeOrder).to.equal(ZERO_ADDRESS)
      expect(status.activeOrderValidTo).to.equal(0n)
    })

    it('should size sellAmount to the stonks balance below the cap', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await fundStonks(ctx, SELL_BELOW_CAP)

      const status = await ctx.buybackExecutor.getPlacementStatus()
      expect(status.sellAmount).to.equal(SELL_BELOW_CAP)
    })

    it('should clamp sellAmount to maxAllowedOrderAmount above the cap', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await fundStonks(ctx, SELL_ABOVE_CAP)

      const status = await ctx.buybackExecutor.getPlacementStatus()
      expect(status.sellAmount).to.equal(MAX_ORDER)
    })

    it('should populate estimatedBuyAmount when the sell meets the minimum', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await fundStonks(ctx, SELL_BELOW_CAP)
      await setEstimate(ctx, ESTIMATE)

      const status = await ctx.buybackExecutor.getPlacementStatus()
      expect(status.estimatedBuyAmount).to.equal(ESTIMATE)
    })

    it('should leave estimatedBuyAmount at 0 when the sell is below the minimum', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await fundStonks(ctx, BELOW_MIN)
      await setEstimate(ctx, ESTIMATE)

      const status = await ctx.buybackExecutor.getPlacementStatus()
      expect(status.estimatedBuyAmount).to.equal(0n)
    })

    it('should soft-fail estimatedBuyAmount to 0 when estimateTradeOutput reverts', async function () {
      const ctx = await loadFixture(deployBuybackExecutorWithStubs)
      await fundStonks(ctx, SELL_BELOW_CAP)
      await ctx.stubs.stonks.connect(ctx.signers.admin).setRevertEstimate(true)

      const status = await ctx.buybackExecutor.getPlacementStatus()
      expect(status.estimatedBuyAmount).to.equal(0n)
    })

    describe('canPlace:', function () {
      it('should be true when every precondition is met', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundStonks(ctx, SELL_BELOW_CAP)
        await setEstimate(ctx, ESTIMATE)

        const status = await ctx.buybackExecutor.getPlacementStatus()
        expect(status.canPlace).to.equal(true)
      })

      it('should be false when paused', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundStonks(ctx, SELL_BELOW_CAP)
        await setEstimate(ctx, ESTIMATE)
        await ctx.buybackExecutor.connect(ctx.signers.emergency).pause()

        const status = await ctx.buybackExecutor.getPlacementStatus()
        expect(status.canPlace).to.equal(false)
      })

      it('should be false when Stonks creation is paused', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundStonks(ctx, SELL_BELOW_CAP)
        await setEstimate(ctx, ESTIMATE)
        await ctx.stubs.stonks.connect(ctx.signers.admin).setCreationPaused(true)

        const status = await ctx.buybackExecutor.getPlacementStatus()
        expect(status.canPlace).to.equal(false)
      })

      it('should be false when Stonks is killed', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundStonks(ctx, SELL_BELOW_CAP)
        await setEstimate(ctx, ESTIMATE)
        await ctx.stubs.stonks.connect(ctx.signers.admin).setKilled(true)

        const status = await ctx.buybackExecutor.getPlacementStatus()
        expect(status.canPlace).to.equal(false)
      })

      it('should be false when a live order is tracked', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await placeTrackedOrder(ctx)

        const status = await ctx.buybackExecutor.getPlacementStatus()
        expect(status.canPlace).to.equal(false)
      })

      it('should be false when the sell is below the minimum, leaving the estimate at 0', async function () {
        const ctx = await loadFixture(deployBuybackExecutorWithStubs)
        await fundStonks(ctx, BELOW_MIN)
        await setEstimate(ctx, ESTIMATE)

        const status = await ctx.buybackExecutor.getPlacementStatus()
        expect(status.canPlace).to.equal(false)
      })
    })
  })
})
