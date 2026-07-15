import { parseEther } from 'ethers'

/**
 * Production NEST deployment parameters, shared by the deploy scripts and the fork test suites
 * (test/helpers/buyback-scenario.ts). Values here are the single source of truth: a change to the
 * deploy plan lands once and the staging fidelity of the tests follows automatically.
 *
 * Only finalized addresses live here. Addresses produced by the NEST deployment itself stay as
 * TODO fields in the individual scripts.
 */

/// Canonical LidoLocator proxy, the only stable Lido anchor. stETH, the staking router, and the
/// rebase receiver are resolved from it live, exactly as StakingRevenueSource does.
export const LIDO_LOCATOR_ADDRESS = '0xC1d0b3DE6792Bf6b4b37EccdcC24e45978Cfd2Eb'

/// OracleRouter from the Stonks v2 deploy.
export const ORACLE_ROUTER_ADDRESS = '0x79ef3a538200Fe4981D67E7e886bfb36D4Cb5a31'

/// ETH-anchored AmountConverter from the Stonks v2 deploy.
export const AMOUNT_CONVERTER_ADDRESS = '0x70dA04C5D0f325F5AF1426dE6672BF2424B4593d'

/// Pre-existing Curve LDO/wstETH TwoCrypto-NG pool (also the LP token).
export const CURVE_POOL_AND_TOKEN_ADDRESS = '0xD7f1dA0a28E39dd0dB70E6Acdc2B49846AD22760'

/// BuybackAllocator constructor limits. USD values are 1e18-scaled.
export const ALLOCATOR_PARAMS = {
  dailyCapUSD: parseEther('50000'), // $50,000
  yearlyCapUSD: parseEther('10000000'), // $10,000,000
  reserveDailyRateUSD: parseEther('109589'), // $109,589/day, $40M/yr baseline
  minStEthPriceUSD: 0n, // governance lever: 0 disables the stETH price floor
  minSpendPerCallUSD: parseEther('1000'), // $1,000 dust floor per allocation
  surplusShareBP: 5000n, // 50%
} as const

/// BuybackExecutor constructor bounds. USD values are 1e18-scaled.
export const EXECUTOR_PARAMS = {
  poolPriceDivergenceToleranceBps: 200n, // 2%
  minAllowedOrderAmount: parseEther('1'), // 1 stETH
  maxAllowedOrderAmount: parseEther('20'), // 20 stETH
  minDepositValueUsd: parseEther('1000'), // $1,000
  maxDepositValueUsd: parseEther('50000'), // $50,000
  poolBootstrapMinTvlUsd: parseEther('250000'), // $250,000
} as const

/// Buyback Stonks trade parameters, shared by the LP and treasury instances.
export const STONKS_PARAMS = {
  orderDurationInSeconds: 1800n, // 30 min
  marginInBasisPoints: 110n, // 1.10%
  priceToleranceInBasisPoints: 550n, // 5.50%
  maxImprovementInBasisPoints: 1000n, // 10.00%
  allowPartialFill: true,
} as const
