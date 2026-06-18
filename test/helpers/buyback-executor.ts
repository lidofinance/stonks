import { ethers, network } from 'hardhat'
import { Signer } from 'ethers'
import { time } from '@nomicfoundation/hardhat-network-helpers'

import {
  BuybackExecutorHarness,
  BuybackExecutorHarness__factory,
  ERC20Stub,
  ERC20Stub__factory,
  WstEthStub,
  WstEthStub__factory,
  CurvePoolStub,
  CurvePoolStub__factory,
  StonksStub,
  StonksStub__factory,
  OracleRouterUsdStub,
  OracleRouterUsdStub__factory,
  OrderStub__factory,
} from '../../typechain-types'
import { getContracts } from '../../utils/contracts'

// --- Scales and roles ---

export const PRICE_SCALE = 10n ** 18n
export const ALLOCATOR_ROLE = ethers.id('NEST.BuybackExecutor.ALLOCATOR_ROLE')
export const EMERGENCY_ROLE = ethers.id('NEST.BuybackExecutor.EMERGENCY_ROLE')
export const MANAGER_ROLE = ethers.id('NEST.MANAGER_ROLE')
export const DEFAULT_ADMIN_ROLE = ethers.ZeroHash

// OZ v4.9.3 `onlyRole` reverts with this exact string; addresses and roles render lowercase.
export function missingRoleMessage(account: string, role: string): string {
  return `AccessControl: account ${account.toLowerCase()} is missing role ${role}`
}

export const PAUSED_REVERT = 'Pausable: paused'
export const NOT_PAUSED_REVERT = 'Pausable: not paused'
export const REENTRANCY_REVERT = 'ReentrancyGuard: reentrant call'

// AddLiquidityStatus enum in declaration order. ethers returns the value as a bigint.
export const ADD_LIQUIDITY_STATUS = {
  ZeroLdoBalance: 0n,
  ZeroStEthBalance: 1n,
  OraclePriceUnavailable: 2n,
  InvalidOraclePrice: 3n,
  PoolPriceDivergenceTooHigh: 4n,
  DepositValueBelowMinimum: 5n,
  NotInLpMode: 6n,
  Eligible: 7n,
} as const

// Reference integer math mirroring the contract's Math library, all floor unless noted.
export const mulDiv = (a: bigint, b: bigint, denominator: bigint): bigint => (a * b) / denominator
export const ceilDiv = (numerator: bigint, denominator: bigint): bigint =>
  (numerator + denominator - 1n) / denominator
export const saturatedSub = (a: bigint, b: bigint): bigint => (a > b ? a - b : 0n)

// --- Default configuration ---

// USD prices scaled to PRICE_SCALE. With a 1.2 stETH/wstETH rate the default pool EMA sits on the
// oracle ratio, so the divergence gate is satisfied and only the cases that move it observe a revert.
export const DEFAULT_LDO_USD = 2n * PRICE_SCALE
export const DEFAULT_STETH_USD = 3500n * PRICE_SCALE
export const DEFAULT_SHARE_RATE = (12n * PRICE_SCALE) / 10n
// oracle LDO/stETH ratio = stEthUsd/ldoUsd; pool EMA (LDO/wstETH) = ratio * shareRate, so the
// converted pool EMA lands back on the oracle ratio and the default divergence is zero.
export const DEFAULT_ORACLE_LDO_PER_STETH = (DEFAULT_STETH_USD * PRICE_SCALE) / DEFAULT_LDO_USD
const DEFAULT_POOL_EMA = (DEFAULT_ORACLE_LDO_PER_STETH * DEFAULT_SHARE_RATE) / PRICE_SCALE
export const DEFAULT_ORDER_DURATION = 3600n

// Pool reserves and balanced funding the executor tests share, all derived from the default prices
// and the bootstrap floor in DEFAULT_BOUNDS.

// Reserves whose oracle-valued TVL (twice the LDO leg) sits above the 50000e18 bootstrap floor, so
// the divergence gate is enforced.
export const DEEP_LDO_RESERVE = 50_000n * PRICE_SCALE
export const POOL_TVL_AT_DEEP_RESERVE = 100_000n * PRICE_SCALE
// Reserves whose TVL lands exactly on the floor.
export const BOUNDARY_LDO_RESERVE = 25_000n * PRICE_SCALE

// Balanced funding: equal USD on both legs at the default prices, depositValueUsd 7000e18.
export const BALANCED_LDO = 1750n * PRICE_SCALE
export const BALANCED_STETH = 1n * PRICE_SCALE

// removeLiquidity scenario: held LP and the amounts the pool returns on withdrawal.
export const LP_BALANCE = 1000n * PRICE_SCALE
export const WITHDRAWN_LDO = 500n * PRICE_SCALE
export const WITHDRAWN_WSTETH = 10n * PRICE_SCALE

export type InitParamOverrides = Partial<{
  poolPriceDivergenceToleranceBps: bigint
  minAllowedOrderAmount: bigint
  maxAllowedOrderAmount: bigint
  minDepositValueUsd: bigint
  maxDepositValueUsd: bigint
  poolBootstrapMinTvlUsd: bigint
}>

export const DEFAULT_BOUNDS = {
  poolPriceDivergenceToleranceBps: 100n,
  minAllowedOrderAmount: 1n * PRICE_SCALE,
  maxAllowedOrderAmount: 1000n * PRICE_SCALE,
  minDepositValueUsd: 100n * PRICE_SCALE,
  maxDepositValueUsd: 100_000n * PRICE_SCALE,
  poolBootstrapMinTvlUsd: 50_000n * PRICE_SCALE,
} as const

export enum OracleFailureMode {
  None = 0,
  CustomError = 1,
  EmptyRevert = 2,
}

export interface BuybackStubs {
  ldo: ERC20Stub
  stEth: ERC20Stub
  wstEth: WstEthStub
  pool: CurvePoolStub
  oracle: OracleRouterUsdStub
  stonks: StonksStub
}

export interface BuybackSigners {
  deployer: Signer
  admin: Signer
  treasury: Signer
  allocator: Signer
  manager: Signer
  emergency: Signer
  stranger: Signer
}

export interface BuybackContext {
  buybackExecutor: BuybackExecutorHarness
  // Same deployed instance, surfaced under the harness name for the internal-math file.
  harness: BuybackExecutorHarness
  stubs: BuybackStubs
  signers: BuybackSigners
  params: InitParams
}

export interface InitParams {
  admin: string
  treasury: string
  wstEth: string
  ldo: string
  oracleRouter: string
  curvePoolAndToken: string
  poolPriceDivergenceToleranceBps: bigint
  minAllowedOrderAmount: bigint
  maxAllowedOrderAmount: bigint
  minDepositValueUsd: bigint
  maxDepositValueUsd: bigint
  poolBootstrapMinTvlUsd: bigint
  stonks: string
}

interface CoreOverrides {
  lpMode?: boolean
  grantRoles?: boolean
  initParams?: InitParamOverrides
}

// --- Stub deployment ---

// Deploys every stub from `deployer` and applies the default configuration from `configurer`,
// keeping `deployer`'s nonce free for the executor deploy so the LP-mode receiver can be predicted.
async function deployBuybackStubs(deployer: Signer, configurer: Signer): Promise<BuybackStubs> {
  const ldo = await new ERC20Stub__factory(deployer).deploy('LDO stub', 'LDOstub')
  const stEth = await new ERC20Stub__factory(deployer).deploy('stETH stub', 'stETHstub')
  const wstEth = await new WstEthStub__factory(deployer).deploy(await stEth.getAddress())
  const pool = await new CurvePoolStub__factory(deployer).deploy(
    await ldo.getAddress(),
    await wstEth.getAddress()
  )
  const oracle = await new OracleRouterUsdStub__factory(deployer).deploy()
  const stonks = await new StonksStub__factory(deployer).deploy()

  await oracle.connect(configurer).setUsdPrice(DEFAULT_LDO_USD, DEFAULT_STETH_USD)
  await wstEth.connect(configurer).setStEthPerToken(DEFAULT_SHARE_RATE)
  await pool.connect(configurer).setPriceOracle(DEFAULT_POOL_EMA)
  await stonks.connect(configurer).setOrderDuration(DEFAULT_ORDER_DURATION)
  await stonks.connect(configurer).setTokenPair(await stEth.getAddress(), await ldo.getAddress())

  return { ldo, stEth, wstEth, pool, oracle, stonks }
}

export async function buildInitParams(
  stubs: BuybackStubs,
  signers: BuybackSigners,
  overrides: InitParamOverrides = {}
): Promise<InitParams> {
  return {
    admin: await signers.admin.getAddress(),
    treasury: await signers.treasury.getAddress(),
    wstEth: await stubs.wstEth.getAddress(),
    ldo: await stubs.ldo.getAddress(),
    oracleRouter: await stubs.oracle.getAddress(),
    curvePoolAndToken: await stubs.pool.getAddress(),
    stonks: await stubs.stonks.getAddress(),
    ...DEFAULT_BOUNDS,
    ...overrides,
  }
}

// --- Fixtures ---

async function deployBuybackExecutorCore(overrides: CoreOverrides = {}): Promise<BuybackContext> {
  const lpMode = overrides.lpMode ?? true
  const grantRoles = overrides.grantRoles ?? true

  const [deployer, admin, treasury, allocator, manager, emergency, stranger] =
    await ethers.getSigners()
  const signers: BuybackSigners = {
    deployer,
    admin,
    treasury,
    allocator,
    manager,
    emergency,
    stranger,
  }

  // `admin` runs every stub-config tx so `deployer`'s next tx is the executor deploy.
  const stubs = await deployBuybackStubs(deployer, admin)

  // The constructor reads `stonks.RECEIVER()`. For LP mode it must equal the executor address,
  // which is the deployer's next CREATE. Predict it, then point the receiver at it.
  const predictedExecutorAddress = ethers.getCreateAddress({
    from: deployer.address,
    nonce: await deployer.getNonce(),
  })
  const receiver = lpMode ? predictedExecutorAddress : await treasury.getAddress()
  await stubs.stonks.connect(admin).setReceiver(receiver)
  // The constructor requires the executor to be the Stonks manager, in both modes.
  await stubs.stonks.connect(admin).setManager(predictedExecutorAddress)

  const params = await buildInitParams(stubs, signers, overrides.initParams)
  const buybackExecutor = await new BuybackExecutorHarness__factory(deployer).deploy(params)
  await buybackExecutor.waitForDeployment()

  if ((await buybackExecutor.getAddress()) !== predictedExecutorAddress) {
    throw new Error('executor address prediction missed; a deployer tx slipped in before deploy')
  }

  if (grantRoles) {
    await buybackExecutor.connect(admin).grantRole(ALLOCATOR_ROLE, await allocator.getAddress())
    await buybackExecutor.connect(admin).grantRole(EMERGENCY_ROLE, await emergency.getAddress())
    await buybackExecutor.connect(admin).grantRole(MANAGER_ROLE, await manager.getAddress())
  }

  return { buybackExecutor, harness: buybackExecutor, stubs, signers, params }
}

/// LP-mode executor with roles granted and default bounds. The primary `loadFixture` target.
export function deployBuybackExecutorWithStubs(): Promise<BuybackContext> {
  return deployBuybackExecutorCore()
}

/// Treasury-mode executor with roles granted and default bounds.
export function deployBuybackExecutorTreasuryMode(): Promise<BuybackContext> {
  return deployBuybackExecutorCore({ lpMode: false })
}

/// Parameterized fixture builder for tests that need custom bounds or no role grants. The returned
/// function is named so `loadFixture` accepts it and caches it by identity.
export function makeBuybackFixture(overrides: CoreOverrides): () => Promise<BuybackContext> {
  return function deployBuybackExecutorWithOverrides() {
    return deployBuybackExecutorCore(overrides)
  }
}

// --- Stub-action helpers ---

export async function setOraclePrices(
  ctx: BuybackContext,
  ldoUsdPrice: bigint,
  stEthUsdPrice: bigint
): Promise<void> {
  await ctx.stubs.oracle.connect(ctx.signers.admin).setUsdPrice(ldoUsdPrice, stEthUsdPrice)
}

export async function setOracleFailure(
  ctx: BuybackContext,
  mode: OracleFailureMode
): Promise<void> {
  await ctx.stubs.oracle.connect(ctx.signers.admin).setFailureMode(mode)
}

/// Sets the pool EMA (`price_oracle`, LDO per wstETH).
export async function setPoolEma(ctx: BuybackContext, ldoPerWstEth: bigint): Promise<void> {
  await ctx.stubs.pool.connect(ctx.signers.admin).setPriceOracle(ldoPerWstEth)
}

/// Sets the reserves the TVL gate reads, independent of token balances.
export async function setPoolReserves(
  ctx: BuybackContext,
  ldoReserve: bigint,
  wstEthReserve: bigint
): Promise<void> {
  await ctx.stubs.pool.connect(ctx.signers.admin).setBalances(ldoReserve, wstEthReserve)
}

export async function setShareRate(ctx: BuybackContext, stEthPerToken: bigint): Promise<void> {
  await ctx.stubs.wstEth.connect(ctx.signers.admin).setStEthPerToken(stEthPerToken)
}

export async function fundExecutor(
  ctx: BuybackContext,
  amounts: { ldo?: bigint; stEth?: bigint }
): Promise<void> {
  const executorAddress = await ctx.buybackExecutor.getAddress()
  if (amounts.ldo !== undefined) {
    await ctx.stubs.ldo.connect(ctx.signers.admin).mint(executorAddress, amounts.ldo)
  }
  if (amounts.stEth !== undefined) {
    await ctx.stubs.stEth.connect(ctx.signers.admin).mint(executorAddress, amounts.stEth)
  }
}

export async function setStonksReceiver(ctx: BuybackContext, receiver: string): Promise<void> {
  await ctx.stubs.stonks.connect(ctx.signers.admin).setReceiver(receiver)
}

// Sets the pool EMA so the share-rate-converted value equals the target LDO per stETH. price_oracle
// is LDO per wstETH, which the contract divides by the share rate to reach LDO per stETH.
export async function setPoolEmaLdoPerStEth(
  ctx: BuybackContext,
  ldoPerStEth: bigint
): Promise<void> {
  const shareRate = await ctx.stubs.wstEth.stEthPerToken()
  await setPoolEma(ctx, (ldoPerStEth * shareRate) / PRICE_SCALE)
}

// Scales the current pool EMA by percent/100, moving it off the oracle ratio.
export async function scalePoolEma(ctx: BuybackContext, percent: bigint): Promise<void> {
  const currentEma = await ctx.stubs.pool.priceOracleValue()
  await setPoolEma(ctx, (currentEma * percent) / 100n)
}

// Pushes the pool EMA 5% off the oracle ratio, scoring 500 bps past the 100 bps default tolerance.
export function makePoolDivergent(ctx: BuybackContext): Promise<void> {
  return scalePoolEma(ctx, 105n)
}

// Number of recoverTokenFrom calls an OrderStub recorded.
export function recoverTokenFromCalls(orderAddress: string): Promise<bigint> {
  return OrderStub__factory.connect(orderAddress, ethers.provider).recoverTokenFromCalls()
}

// Deploys a fresh StonksStub for the swap-in tests. Defaults to the stETH/LDO pair, this executor
// as manager, and the default order duration, the wiring the executor's validation requires.
// Each field is overridable so a test can drive a single validation revert.
export async function deployStonksStub(
  ctx: BuybackContext,
  options: {
    receiver: string
    duration?: bigint
    tokenFrom?: string
    tokenTo?: string
    manager?: string
  }
): Promise<StonksStub> {
  const stonks = await new StonksStub__factory(ctx.signers.deployer).deploy()
  await stonks.connect(ctx.signers.admin).setReceiver(options.receiver)
  await stonks
    .connect(ctx.signers.admin)
    .setOrderDuration(options.duration ?? DEFAULT_ORDER_DURATION)
  await stonks
    .connect(ctx.signers.admin)
    .setTokenPair(
      options.tokenFrom ?? (await ctx.stubs.stEth.getAddress()),
      options.tokenTo ?? (await ctx.stubs.ldo.getAddress())
    )
  await stonks
    .connect(ctx.signers.admin)
    .setManager(options.manager ?? (await ctx.buybackExecutor.getAddress()))
  return stonks
}

/// Funds Stonks, places an order through the public path, and returns the tracked order address.
export async function placeTrackedOrder(
  ctx: BuybackContext,
  sellSeed: bigint = DEFAULT_BOUNDS.maxAllowedOrderAmount
): Promise<string> {
  await ctx.stubs.stEth
    .connect(ctx.signers.admin)
    .mint(await ctx.stubs.stonks.getAddress(), sellSeed)
  await ctx.stubs.stonks.connect(ctx.signers.admin).setEstimatedOutput(1n)

  await ctx.buybackExecutor.connect(ctx.signers.stranger).placeOrder()
  return ctx.buybackExecutor.lastOrderAddress()
}

/// Advances time past the tracked order's `validTo` so the next sweep clears it.
export async function expireOrder(ctx: BuybackContext): Promise<void> {
  const validTo = await ctx.buybackExecutor.lastOrderValidTo()
  await time.increaseTo(validTo + 1n)
}

// --- Fork environment ---

const FORK_NETWORKS = ['hardhat', 'mainnet', 'localhost']

/// LDO/wstETH TwoCrypto pool address from the registry, or undefined when it is not yet listed.
/// Fork and acceptance files skip while this is undefined.
export function getBuybackPoolAddress(): string | undefined {
  try {
    const contracts = getContracts() as Record<string, string>
    return contracts.CURVE_LDO_WSTETH_POOL
  } catch {
    return undefined
  }
}

export interface ForkBuybackEnvironment {
  ldo: string
  stEth: string
  wstEth: string
  pool: string
}

/// Returns the real token and pool addresses for fork tests, or undefined when the pool is absent
/// from the registry or the current network is not a fork target.
export function setupForkBuybackEnvironment(): ForkBuybackEnvironment | undefined {
  if (!FORK_NETWORKS.includes(network.name)) {
    return undefined
  }

  const pool = getBuybackPoolAddress()
  if (pool === undefined) {
    return undefined
  }

  const contracts = getContracts()
  return { ldo: contracts.LDO, stEth: contracts.STETH, wstEth: contracts.WSTETH, pool }
}
