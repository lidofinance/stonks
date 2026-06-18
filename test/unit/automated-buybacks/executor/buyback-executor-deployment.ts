import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'

import { BuybackExecutorHarness__factory } from '../../../../typechain-types'
import {
  deployBuybackExecutorWithStubs,
  deployBuybackExecutorTreasuryMode,
  makeBuybackFixture,
  PRICE_SCALE,
  ALLOCATOR_ROLE,
  EMERGENCY_ROLE,
  MANAGER_ROLE,
  DEFAULT_ADMIN_ROLE,
  DEFAULT_BOUNDS,
  DEFAULT_ORDER_DURATION,
  InitParams,
  BuybackSigners,
} from '../../../helpers/buyback-executor'

const ZERO_ADDRESS = ethers.ZeroAddress
const MAX_UINT256 = 2n ** 256n - 1n

const EXPECTED_MAX_BASIS_POINTS = 10000n
const EXPECTED_MAX_POOL_DIVERGENCE_TOLERANCE_BPS = 1000n
const EXPECTED_MIN_ORDER_RESIDUAL_TO_RECOVER = 10n

// Out-of-range constructor inputs for the validation reverts.
const TOLERANCE_ABOVE_MAX = EXPECTED_MAX_POOL_DIVERGENCE_TOLERANCE_BPS + 1n
const ORDER_AMOUNT_ABOVE_MAX = DEFAULT_BOUNDS.maxAllowedOrderAmount * 2n
const DEPOSIT_VALUE_ABOVE_MAX = DEFAULT_BOUNDS.maxDepositValueUsd * 2n
const POOL_BOOTSTRAP_ABOVE_MAX = 1_000_000n * PRICE_SCALE + 1n

// No-role variant. A module-level const keeps loadFixture's identity caching stable.
const deployWithoutRoles = makeBuybackFixture({ grantRoles: false })

// Fresh harness deploy from a valid base param set with field overrides, for constructor reverts.
function deployHarness(
  signers: BuybackSigners,
  params: InitParams,
  overrides: Partial<InitParams> = {}
) {
  return new BuybackExecutorHarness__factory(signers.deployer).deploy({ ...params, ...overrides })
}

describe('BuybackExecutor — deployment', function () {
  describe('immutables and derived state:', function () {
    it('should store WSTETH from the wstEth init address', async function () {
      const { buybackExecutor, stubs } = await loadFixture(deployBuybackExecutorWithStubs)
      expect(await buybackExecutor.WSTETH()).to.equal(await stubs.wstEth.getAddress())
    })

    it('should store STETH read via WSTETH.stETH()', async function () {
      const { buybackExecutor, stubs } = await loadFixture(deployBuybackExecutorWithStubs)
      expect(await buybackExecutor.STETH()).to.equal(await stubs.stEth.getAddress())
    })

    it('should store LDO, ORACLE_ROUTER, and CURVE_POOL_AND_TOKEN from their init addresses', async function () {
      const { buybackExecutor, stubs } = await loadFixture(deployBuybackExecutorWithStubs)
      expect(await buybackExecutor.LDO()).to.equal(await stubs.ldo.getAddress())
      expect(await buybackExecutor.ORACLE_ROUTER()).to.equal(await stubs.oracle.getAddress())
      expect(await buybackExecutor.CURVE_POOL_AND_TOKEN()).to.equal(await stubs.pool.getAddress())
    })

    it('should store PRICE_SCALE from ORACLE_ROUTER.PRICE_UNIT()', async function () {
      const { buybackExecutor } = await loadFixture(deployBuybackExecutorWithStubs)
      expect(await buybackExecutor.PRICE_SCALE()).to.equal(PRICE_SCALE)
    })

    it('should set TREASURY from the treasury init address', async function () {
      const { buybackExecutor, signers } = await loadFixture(deployBuybackExecutorWithStubs)
      expect(await buybackExecutor.TREASURY()).to.equal(await signers.treasury.getAddress())
    })

    it('should set the configurable bounds from init values', async function () {
      const { buybackExecutor } = await loadFixture(deployBuybackExecutorWithStubs)
      expect(await buybackExecutor.poolPriceDivergenceToleranceBps()).to.equal(
        DEFAULT_BOUNDS.poolPriceDivergenceToleranceBps
      )
      expect(await buybackExecutor.minAllowedOrderAmount()).to.equal(
        DEFAULT_BOUNDS.minAllowedOrderAmount
      )
      expect(await buybackExecutor.maxAllowedOrderAmount()).to.equal(
        DEFAULT_BOUNDS.maxAllowedOrderAmount
      )
      expect(await buybackExecutor.minDepositValueUsd()).to.equal(DEFAULT_BOUNDS.minDepositValueUsd)
      expect(await buybackExecutor.maxDepositValueUsd()).to.equal(DEFAULT_BOUNDS.maxDepositValueUsd)
      expect(await buybackExecutor.poolBootstrapMinTvlUsd()).to.equal(
        DEFAULT_BOUNDS.poolBootstrapMinTvlUsd
      )
    })

    it('should cache stonksOrderDurationSeconds from stonks.ORDER_DURATION_IN_SECONDS()', async function () {
      const { buybackExecutor } = await loadFixture(deployBuybackExecutorWithStubs)
      expect(await buybackExecutor.stonksOrderDurationSeconds()).to.equal(DEFAULT_ORDER_DURATION)
    })
  })

  describe('Curve coin validation:', function () {
    it('should accept the pool when coins(0) == ldo and coins(1) == wstEth', async function () {
      const { stubs, signers, params } = await loadFixture(deployBuybackExecutorTreasuryMode)
      // The constructor requires the executor to be the Stonks manager. Point the stub at the
      // address this redeploy lands on.
      const predictedExecutorAddress = ethers.getCreateAddress({
        from: await signers.deployer.getAddress(),
        nonce: await signers.deployer.getNonce(),
      })
      await stubs.stonks.connect(signers.admin).setManager(predictedExecutorAddress)
      const executor = await deployHarness(signers, params)
      await executor.waitForDeployment()
      expect(await executor.CURVE_POOL_AND_TOKEN()).to.equal(params.curvePoolAndToken)
    })

    it('should revert InvalidCurvePool(coin0, coin1) when coins(0) != ldo', async function () {
      const { buybackExecutor, stubs, signers, params } = await loadFixture(
        deployBuybackExecutorTreasuryMode
      )
      const strangerAddress = await signers.stranger.getAddress()
      await stubs.pool.connect(signers.admin).setCoins(strangerAddress, params.wstEth)

      await expect(deployHarness(signers, params))
        .to.be.revertedWithCustomError(buybackExecutor, 'InvalidCurvePool')
        .withArgs(strangerAddress, params.wstEth)
    })

    it('should revert InvalidCurvePool(coin0, coin1) when coins(1) != wstEth', async function () {
      const { buybackExecutor, stubs, signers, params } = await loadFixture(
        deployBuybackExecutorTreasuryMode
      )
      const strangerAddress = await signers.stranger.getAddress()
      await stubs.pool.connect(signers.admin).setCoins(params.ldo, strangerAddress)

      await expect(deployHarness(signers, params))
        .to.be.revertedWithCustomError(buybackExecutor, 'InvalidCurvePool')
        .withArgs(params.ldo, strangerAddress)
    })
  })

  describe('constructor reverts:', function () {
    it('should revert InvalidAdminAddress when admin is zero', async function () {
      const { buybackExecutor, signers, params } = await loadFixture(
        deployBuybackExecutorTreasuryMode
      )
      await expect(
        deployHarness(signers, params, { admin: ZERO_ADDRESS })
      ).to.be.revertedWithCustomError(buybackExecutor, 'InvalidAdminAddress')
    })

    it('should revert InvalidTreasuryAddress when treasury is zero', async function () {
      const { buybackExecutor, signers, params } = await loadFixture(
        deployBuybackExecutorTreasuryMode
      )
      await expect(
        deployHarness(signers, params, { treasury: ZERO_ADDRESS })
      ).to.be.revertedWithCustomError(buybackExecutor, 'InvalidTreasuryAddress')
    })

    it('should revert InvalidWstEthAddress when wstEth is zero', async function () {
      const { buybackExecutor, signers, params } = await loadFixture(
        deployBuybackExecutorTreasuryMode
      )
      await expect(
        deployHarness(signers, params, { wstEth: ZERO_ADDRESS })
      ).to.be.revertedWithCustomError(buybackExecutor, 'InvalidWstEthAddress')
    })

    it('should revert InvalidLdoAddress when ldo is zero', async function () {
      const { buybackExecutor, signers, params } = await loadFixture(
        deployBuybackExecutorTreasuryMode
      )
      await expect(
        deployHarness(signers, params, { ldo: ZERO_ADDRESS })
      ).to.be.revertedWithCustomError(buybackExecutor, 'InvalidLdoAddress')
    })

    it('should revert InvalidOracleRouterAddress when oracleRouter is zero', async function () {
      const { buybackExecutor, signers, params } = await loadFixture(
        deployBuybackExecutorTreasuryMode
      )
      await expect(
        deployHarness(signers, params, { oracleRouter: ZERO_ADDRESS })
      ).to.be.revertedWithCustomError(buybackExecutor, 'InvalidOracleRouterAddress')
    })

    it('should revert InvalidCurvePoolAndTokenAddress when curvePoolAndToken is zero', async function () {
      const { buybackExecutor, signers, params } = await loadFixture(
        deployBuybackExecutorTreasuryMode
      )
      await expect(
        deployHarness(signers, params, { curvePoolAndToken: ZERO_ADDRESS })
      ).to.be.revertedWithCustomError(buybackExecutor, 'InvalidCurvePoolAndTokenAddress')
    })

    it('should revert InvalidCurvePool before reading wstEth.stETH()', async function () {
      const { buybackExecutor, stubs, signers, params } = await loadFixture(
        deployBuybackExecutorTreasuryMode
      )
      const strangerAddress = await signers.stranger.getAddress()
      // Break the coin layout and the stETH read at once. The coin check precedes the wstETH
      // assignment, so its error wins.
      await stubs.pool.connect(signers.admin).setCoins(strangerAddress, params.wstEth)
      await stubs.wstEth.connect(signers.admin).setStEth(ZERO_ADDRESS)

      await expect(deployHarness(signers, params))
        .to.be.revertedWithCustomError(buybackExecutor, 'InvalidCurvePool')
        .withArgs(strangerAddress, params.wstEth)
    })

    it('should revert InvalidStEthAddress when WSTETH.stETH() returns zero', async function () {
      const { buybackExecutor, stubs, signers, params } = await loadFixture(
        deployBuybackExecutorTreasuryMode
      )
      await stubs.wstEth.connect(signers.admin).setStEth(ZERO_ADDRESS)

      await expect(deployHarness(signers, params)).to.be.revertedWithCustomError(
        buybackExecutor,
        'InvalidStEthAddress'
      )
    })

    it('should revert InvalidPoolPriceDivergenceTolerance(0) when tolerance is 0', async function () {
      const { buybackExecutor, signers, params } = await loadFixture(
        deployBuybackExecutorTreasuryMode
      )
      await expect(deployHarness(signers, params, { poolPriceDivergenceToleranceBps: 0n }))
        .to.be.revertedWithCustomError(buybackExecutor, 'InvalidPoolPriceDivergenceTolerance')
        .withArgs(0n)
    })

    it('should revert InvalidPoolPriceDivergenceTolerance(x) when tolerance exceeds 1000', async function () {
      const { buybackExecutor, signers, params } = await loadFixture(
        deployBuybackExecutorTreasuryMode
      )
      await expect(
        deployHarness(signers, params, { poolPriceDivergenceToleranceBps: TOLERANCE_ABOVE_MAX })
      )
        .to.be.revertedWithCustomError(buybackExecutor, 'InvalidPoolPriceDivergenceTolerance')
        .withArgs(TOLERANCE_ABOVE_MAX)
    })

    it('should revert InvalidOrderAmountLimits from the max setter when maxAllowedOrderAmount is 0', async function () {
      const { buybackExecutor, signers, params } = await loadFixture(
        deployBuybackExecutorTreasuryMode
      )
      await expect(deployHarness(signers, params, { maxAllowedOrderAmount: 0n }))
        .to.be.revertedWithCustomError(buybackExecutor, 'InvalidOrderAmountLimits')
        .withArgs(0n, 0n)
    })

    it('should revert InvalidOrderAmountLimits from the min setter when minAllowedOrderAmount is 0 with a valid max', async function () {
      const { buybackExecutor, signers, params } = await loadFixture(
        deployBuybackExecutorTreasuryMode
      )
      await expect(deployHarness(signers, params, { minAllowedOrderAmount: 0n }))
        .to.be.revertedWithCustomError(buybackExecutor, 'InvalidOrderAmountLimits')
        .withArgs(0n, DEFAULT_BOUNDS.maxAllowedOrderAmount)
    })

    it('should revert InvalidOrderAmountLimits when minAllowedOrderAmount >= maxAllowedOrderAmount', async function () {
      const { buybackExecutor, signers, params } = await loadFixture(
        deployBuybackExecutorTreasuryMode
      )
      await expect(
        deployHarness(signers, params, { minAllowedOrderAmount: ORDER_AMOUNT_ABOVE_MAX })
      )
        .to.be.revertedWithCustomError(buybackExecutor, 'InvalidOrderAmountLimits')
        .withArgs(ORDER_AMOUNT_ABOVE_MAX, DEFAULT_BOUNDS.maxAllowedOrderAmount)
    })

    it('should revert InvalidDepositValueLimits when maxDepositValueUsd is 0', async function () {
      const { buybackExecutor, signers, params } = await loadFixture(
        deployBuybackExecutorTreasuryMode
      )
      await expect(deployHarness(signers, params, { maxDepositValueUsd: 0n }))
        .to.be.revertedWithCustomError(buybackExecutor, 'InvalidDepositValueLimits')
        .withArgs(0n, 0n)
    })

    it('should revert InvalidDepositValueLimits from the min setter when minDepositValueUsd is 0 with a valid max', async function () {
      const { buybackExecutor, signers, params } = await loadFixture(
        deployBuybackExecutorTreasuryMode
      )
      await expect(deployHarness(signers, params, { minDepositValueUsd: 0n }))
        .to.be.revertedWithCustomError(buybackExecutor, 'InvalidDepositValueLimits')
        .withArgs(0n, DEFAULT_BOUNDS.maxDepositValueUsd)
    })

    it('should revert InvalidDepositValueLimits when minDepositValueUsd >= maxDepositValueUsd', async function () {
      const { buybackExecutor, signers, params } = await loadFixture(
        deployBuybackExecutorTreasuryMode
      )
      await expect(deployHarness(signers, params, { minDepositValueUsd: DEPOSIT_VALUE_ABOVE_MAX }))
        .to.be.revertedWithCustomError(buybackExecutor, 'InvalidDepositValueLimits')
        .withArgs(DEPOSIT_VALUE_ABOVE_MAX, DEFAULT_BOUNDS.maxDepositValueUsd)
    })

    it('should revert InvalidPoolBootstrapMinTvlUsd(0) when poolBootstrapMinTvlUsd is 0', async function () {
      const { buybackExecutor, signers, params } = await loadFixture(
        deployBuybackExecutorTreasuryMode
      )
      await expect(deployHarness(signers, params, { poolBootstrapMinTvlUsd: 0n }))
        .to.be.revertedWithCustomError(buybackExecutor, 'InvalidPoolBootstrapMinTvlUsd')
        .withArgs(0n)
    })

    it('should revert InvalidPoolBootstrapMinTvlUsd above the maximum', async function () {
      const { buybackExecutor, signers, params } = await loadFixture(
        deployBuybackExecutorTreasuryMode
      )
      await expect(
        deployHarness(signers, params, { poolBootstrapMinTvlUsd: POOL_BOOTSTRAP_ABOVE_MAX })
      )
        .to.be.revertedWithCustomError(buybackExecutor, 'InvalidPoolBootstrapMinTvlUsd')
        .withArgs(POOL_BOOTSTRAP_ABOVE_MAX)
    })

    it('should revert InvalidStonksAddress when stonks is zero', async function () {
      const { buybackExecutor, signers, params } = await loadFixture(
        deployBuybackExecutorTreasuryMode
      )
      await expect(
        deployHarness(signers, params, { stonks: ZERO_ADDRESS })
      ).to.be.revertedWithCustomError(buybackExecutor, 'InvalidStonksAddress')
    })

    it('should revert InvalidStonksReceiver(stonks, receiver) when the receiver is neither this contract nor TREASURY', async function () {
      const { buybackExecutor, stubs, signers, params } = await loadFixture(
        deployBuybackExecutorTreasuryMode
      )
      const strangerAddress = await signers.stranger.getAddress()
      await stubs.stonks.connect(signers.admin).setReceiver(strangerAddress)

      await expect(deployHarness(signers, params))
        .to.be.revertedWithCustomError(buybackExecutor, 'InvalidStonksReceiver')
        .withArgs(params.stonks, strangerAddress)
    })

    it('should revert InvalidStonksTokenPair when stonks sells a token other than stETH', async function () {
      const { buybackExecutor, stubs, signers, params } = await loadFixture(
        deployBuybackExecutorTreasuryMode
      )
      const strangerAddress = await signers.stranger.getAddress()
      await stubs.stonks.connect(signers.admin).setTokenPair(strangerAddress, params.ldo)

      await expect(deployHarness(signers, params))
        .to.be.revertedWithCustomError(buybackExecutor, 'InvalidStonksTokenPair')
        .withArgs(strangerAddress, params.ldo)
    })

    it('should revert InvalidStonksTokenPair when stonks buys a token other than LDO', async function () {
      const { buybackExecutor, stubs, signers, params } = await loadFixture(
        deployBuybackExecutorTreasuryMode
      )
      const strangerAddress = await signers.stranger.getAddress()
      const stEthAddress = await stubs.stEth.getAddress()
      await stubs.stonks.connect(signers.admin).setTokenPair(stEthAddress, strangerAddress)

      await expect(deployHarness(signers, params))
        .to.be.revertedWithCustomError(buybackExecutor, 'InvalidStonksTokenPair')
        .withArgs(stEthAddress, strangerAddress)
    })

    it('should revert InvalidStonksManager when the stonks manager is not the executor', async function () {
      const { buybackExecutor, stubs, signers, params } = await loadFixture(
        deployBuybackExecutorTreasuryMode
      )
      const strangerAddress = await signers.stranger.getAddress()
      await stubs.stonks.connect(signers.admin).setManager(strangerAddress)

      await expect(deployHarness(signers, params))
        .to.be.revertedWithCustomError(buybackExecutor, 'InvalidStonksManager')
        .withArgs(strangerAddress)
    })
  })

  describe('operating mode, approvals, roles, constants, initial state:', function () {
    it('should set lpModeEnabled true when stonks.RECEIVER() equals this contract', async function () {
      const { buybackExecutor } = await loadFixture(deployBuybackExecutorWithStubs)
      expect(await buybackExecutor.lpModeEnabled()).to.equal(true)
    })

    it('should set lpModeEnabled false when stonks.RECEIVER() equals TREASURY', async function () {
      const { buybackExecutor } = await loadFixture(deployBuybackExecutorTreasuryMode)
      expect(await buybackExecutor.lpModeEnabled()).to.equal(false)
    })

    it('should emit StonksAndOperatingModeSet(address(0), stonks, false, true) at construction', async function () {
      const { buybackExecutor, stubs } = await loadFixture(deployBuybackExecutorWithStubs)
      await expect(buybackExecutor.deploymentTransaction())
        .to.emit(buybackExecutor, 'StonksAndOperatingModeSet')
        .withArgs(ZERO_ADDRESS, await stubs.stonks.getAddress(), false, true)
    })

    it('should emit PoolBootstrapMinTvlUsdSet(0, poolBootstrapMinTvlUsd) at construction', async function () {
      const { buybackExecutor } = await loadFixture(deployBuybackExecutorWithStubs)
      await expect(buybackExecutor.deploymentTransaction())
        .to.emit(buybackExecutor, 'PoolBootstrapMinTvlUsdSet')
        .withArgs(0n, DEFAULT_BOUNDS.poolBootstrapMinTvlUsd)
    })

    it('should grant a max stETH approval to WSTETH', async function () {
      const { buybackExecutor, stubs } = await loadFixture(deployBuybackExecutorWithStubs)
      expect(
        await stubs.stEth.allowance(
          await buybackExecutor.getAddress(),
          await stubs.wstEth.getAddress()
        )
      ).to.equal(MAX_UINT256)
    })

    it('should grant DEFAULT_ADMIN_ROLE to admin', async function () {
      const { buybackExecutor, signers } = await loadFixture(deployBuybackExecutorWithStubs)
      expect(
        await buybackExecutor.hasRole(DEFAULT_ADMIN_ROLE, await signers.admin.getAddress())
      ).to.equal(true)
      expect(await buybackExecutor.getRoleMemberCount(DEFAULT_ADMIN_ROLE)).to.equal(1n)
    })

    it('should expose ALLOCATOR_ROLE as keccak256("NEST.BuybackExecutor.ALLOCATOR_ROLE") with no members at deploy', async function () {
      const { buybackExecutor } = await loadFixture(deployWithoutRoles)
      expect(await buybackExecutor.ALLOCATOR_ROLE()).to.equal(ALLOCATOR_ROLE)
      expect(await buybackExecutor.getRoleMemberCount(ALLOCATOR_ROLE)).to.equal(0n)
    })

    it('should expose EMERGENCY_ROLE as keccak256("NEST.BuybackExecutor.EMERGENCY_ROLE") with no members at deploy', async function () {
      const { buybackExecutor } = await loadFixture(deployWithoutRoles)
      expect(await buybackExecutor.EMERGENCY_ROLE()).to.equal(EMERGENCY_ROLE)
      expect(await buybackExecutor.getRoleMemberCount(EMERGENCY_ROLE)).to.equal(0n)
    })

    it('should expose MANAGER_ROLE as keccak256("NEST.MANAGER_ROLE") with no members at deploy', async function () {
      const { buybackExecutor } = await loadFixture(deployWithoutRoles)
      expect(await buybackExecutor.MANAGER_ROLE()).to.equal(MANAGER_ROLE)
      expect(await buybackExecutor.getRoleMemberCount(MANAGER_ROLE)).to.equal(0n)
    })

    it('should expose MAX_BASIS_POINTS, MAX_POOL_DIVERGENCE_TOLERANCE_BPS, and MIN_ORDER_RESIDUAL_TO_RECOVER', async function () {
      const { buybackExecutor } = await loadFixture(deployBuybackExecutorWithStubs)
      expect(await buybackExecutor.MAX_BASIS_POINTS()).to.equal(EXPECTED_MAX_BASIS_POINTS)
      expect(await buybackExecutor.MAX_POOL_DIVERGENCE_TOLERANCE_BPS()).to.equal(
        EXPECTED_MAX_POOL_DIVERGENCE_TOLERANCE_BPS
      )
      expect(await buybackExecutor.MIN_ORDER_RESIDUAL_TO_RECOVER()).to.equal(
        EXPECTED_MIN_ORDER_RESIDUAL_TO_RECOVER
      )
    })

    it('should start with lastOrderAddress == address(0), lastOrderValidTo == 0, and paused() == false', async function () {
      const { buybackExecutor } = await loadFixture(deployBuybackExecutorWithStubs)
      expect(await buybackExecutor.lastOrderAddress()).to.equal(ZERO_ADDRESS)
      expect(await buybackExecutor.lastOrderValidTo()).to.equal(0n)
      expect(await buybackExecutor.paused()).to.equal(false)
    })
  })
})
