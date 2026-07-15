import { ethers } from 'hardhat'
import { Contract, Signer, TransactionReceipt, ZeroAddress, parseEther } from 'ethers'
import { time } from '@nomicfoundation/hardhat-network-helpers'

import {
  BuybackAllocator,
  BuybackAllocator__factory,
  BuybackExecutor,
  BuybackExecutor__factory,
  IERC20,
  ITokenRateNotifier,
  StakingRevenueSource,
  StakingRevenueSource__factory,
  Stonks,
} from '../../typechain-types'
import { getContracts } from '../../utils/contracts'
import { QuoteDenomination } from '../../utils/oracle-router'
import { CURVE_POOL_ABI } from '../../utils/curve-twocrypto'
import { deployStonks } from '../../scripts/deployments/stonks'
import { STETH_ABI, impersonateWithBalance } from './buyback-executor'
import {
  ALLOCATOR_PARAMS,
  AMOUNT_CONVERTER_ADDRESS,
  CURVE_POOL_AND_TOKEN_ADDRESS,
  EXECUTOR_PARAMS,
  LIDO_LOCATOR_ADDRESS,
  ORACLE_ROUTER_ADDRESS,
  STONKS_PARAMS,
} from '../../scripts/nest-parameters'

// Production deployment constants and parameters, shared with the deploy scripts through
// scripts/nest-parameters.ts and re-exported as the test-side facade.
export {
  ALLOCATOR_PARAMS,
  AMOUNT_CONVERTER_ADDRESS,
  CURVE_POOL_AND_TOKEN_ADDRESS,
  EXECUTOR_PARAMS,
  LIDO_LOCATOR_ADDRESS,
  ORACLE_ROUTER_ADDRESS,
  STONKS_PARAMS,
}

/// One day and one year in seconds, mirroring the allocator's window and reserve granularity.
export const ONE_DAY = 86400n
export const ONE_YEAR = 365n * ONE_DAY

/// Generous feed staleness so live Chainlink answers survive the fork block age.
const FEED_STALENESS_SECONDS = 7 * 86400

/// ObserverKind.WithArgs on the TokenRateNotifier.
const OBSERVER_KIND_WITH_ARGS = 1n

// --- Staging helpers ---

/**
 * Configures the real (deployed but unconfigured) OracleRouter with the same feed set the fresh
 * test router gets in `utils/oracle-router.ts`: the ETH/USD bridge, stETH quoted in USD, and LDO
 * quoted in ETH. Impersonates the router admin (Aragon Voting). The ETH bridge serves both the
 * USD reads (allocator, source, executor) and the ETH-denominated reads of the real ETH-anchored
 * AmountConverter.
 *
 * Unlike the guarded governance staging steps, this deliberately re-applies over an already
 * configured router: the setters overwrite, and the generous staleness is required either way
 * because a fork block ages past any production staleness window.
 */
export async function configureRealOracleRouter(options: {
  stEth: string
  ldo: string
  stalenessSeconds?: number
}) {
  const oracleRouter = await ethers.getContractAt('OracleRouter', ORACLE_ROUTER_ADDRESS)
  const staleness = options.stalenessSeconds ?? FEED_STALENESS_SECONDS
  const routerAdmin = await impersonateWithBalance(await oracleRouter.ADMIN())

  await oracleRouter.connect(routerAdmin).setEthUsdBridge(staleness)
  await oracleRouter
    .connect(routerAdmin)
    .setTokenFeed(options.stEth, QuoteDenomination.USD, staleness, true)
  await oracleRouter
    .connect(routerAdmin)
    .setTokenFeed(options.ldo, QuoteDenomination.ETH, staleness, true)

  return oracleRouter
}

/// Binds the real Curve LDO/wstETH pool (also the LP token) via the shared minimal ABI.
export function bindRealCurvePool(signer: Signer): Contract {
  return new ethers.Contract(CURVE_POOL_AND_TOKEN_ADDRESS, CURVE_POOL_ABI, signer)
}

export interface NestStack {
  revenueSource: StakingRevenueSource
  executor: BuybackExecutor
  allocator: BuybackAllocator
  stonksLp: Stonks
  stonksTreasury: Stonks
}

export interface DeployedNestAddresses {
  name: string
  revenueSource: string
  executor: string
  allocator: string
  stonksLp: string
  stonksTreasury: string
}

/**
 * Deploys the full NEST stack exactly as the deploy scripts stage it for mainnet: real dependency
 * addresses, production parameters, admin = Aragon Voting, treasury = Aragon Agent. Both Stonks
 * instances reuse the real ETH-anchored AmountConverter and OracleRouter. Post-deploy governance
 * wiring (role grant, setStonks, activate) is left to the caller, mirroring the on-chain flow.
 */
export async function deployNestStack(deployer: Signer): Promise<NestStack> {
  const contracts = getContracts()

  const revenueSource = await new StakingRevenueSource__factory(deployer).deploy(
    ORACLE_ROUTER_ADDRESS,
    LIDO_LOCATOR_ADDRESS
  )
  await revenueSource.waitForDeployment()

  const executor = await new BuybackExecutor__factory(deployer).deploy({
    admin: contracts.ADMIN,
    treasury: contracts.AGENT,
    wstEth: contracts.WSTETH,
    ldo: contracts.LDO,
    oracleRouter: ORACLE_ROUTER_ADDRESS,
    curvePoolAndToken: CURVE_POOL_AND_TOKEN_ADDRESS,
    ...EXECUTOR_PARAMS,
  })
  await executor.waitForDeployment()
  const executorAddress = await executor.getAddress()

  // receiver == executor => LP mode; receiver == Agent => treasury mode (the launch instance).
  const stonksLp = await deployBuybackStonks(executorAddress, executorAddress)
  const stonksTreasury = await deployBuybackStonks(executorAddress, contracts.AGENT)

  const allocator = await new BuybackAllocator__factory(deployer).deploy({
    admin: contracts.ADMIN,
    treasury: contracts.AGENT,
    stEth: contracts.STETH,
    oracleRouter: ORACLE_ROUTER_ADDRESS,
    executor: executorAddress,
    ...ALLOCATOR_PARAMS,
    revenueSources: [await revenueSource.getAddress()],
  })
  await allocator.waitForDeployment()

  return { revenueSource, executor, allocator, stonksLp, stonksTreasury }
}

/// Binds an already deployed NEST stack, the post-launch counterpart of `deployNestStack`.
export async function bindNestStack(addresses: DeployedNestAddresses): Promise<NestStack> {
  return {
    revenueSource: await ethers.getContractAt('StakingRevenueSource', addresses.revenueSource),
    executor: await ethers.getContractAt('BuybackExecutor', addresses.executor),
    allocator: await ethers.getContractAt('BuybackAllocator', addresses.allocator),
    stonksLp: await ethers.getContractAt('Stonks', addresses.stonksLp),
    stonksTreasury: await ethers.getContractAt('Stonks', addresses.stonksTreasury),
  }
}

/// Deploys one buyback Stonks with production parameters, reusing the real converter and router.
async function deployBuybackStonks(managerAddress: string, receiver: string): Promise<Stonks> {
  const contracts = getContracts()

  const { stonks } = await deployStonks({
    factoryParams: {
      admin: contracts.ADMIN,
      agent: contracts.AGENT,
      relayer: contracts.VAULT_RELAYER,
      settlement: contracts.SETTLEMENT,
      priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
      oracleRouterAddress: ORACLE_ROUTER_ADDRESS,
    },
    stonksParams: {
      tokenFrom: contracts.STETH,
      tokenTo: contracts.LDO,
      manager: managerAddress,
      amountConverterAddress: AMOUNT_CONVERTER_ADDRESS,
      orderDuration: Number(STONKS_PARAMS.orderDurationInSeconds),
      marginInBps: Number(STONKS_PARAMS.marginInBasisPoints),
      priceToleranceInBps: Number(STONKS_PARAMS.priceToleranceInBasisPoints),
      maxImprovementInBps: Number(STONKS_PARAMS.maxImprovementInBasisPoints),
      allowPartialFill: STONKS_PARAMS.allowPartialFill,
      receiver,
    },
    // Required by the params type but unused: the amountConverterAddress above selects the
    // bind-existing branch of deployStonks, which never deploys a converter.
    amountConverterParams: {
      allowedTokensToSell: [contracts.STETH],
      allowedTokensToBuy: [contracts.LDO],
    },
  })

  return stonks
}

// --- Rebase driving ---

/// Extracts hex revert data from an ethers/hardhat error. Both shapes occur: `error.data` as the
/// hex string, or a nested provider error object `{ data: '0x…', message }` in its place.
function extractRevertData(error: unknown): string | undefined {
  for (let current: any = error, depth = 0; current != null && depth < 5; ++depth) {
    if (typeof current.data === 'string') return current.data
    current = current.data
  }
  return undefined
}

/// Decodes a revert into a notifier custom-error name, or undefined when the revert carries no
/// data the notifier ABI recognizes.
function decodeNotifierError(notifier: ITokenRateNotifier, error: unknown): string | undefined {
  const revertData = extractRevertData(error)
  if (!revertData || revertData === '0x') return undefined
  return notifier.interface.parseError(revertData)?.name
}

/**
 * Registers `sourceAddress` as a WithArgs observer when the rebase receiver supports it, and
 * reports whether the notifier fan-out path is available on this fork.
 *
 * The flavor is probed with a static two-arg `addObserver` call as the owner. The NEST
 * `TokenRateNotifier` (the core mock-upgrade in CI, or mainnet post-launch) either accepts it or
 * reverts with a typed custom error; the legacy pre-NEST notifier has no such selector, so the
 * dispatch reverts with empty data. Returns `false` only for the legacy notifier — a genuine
 * registration failure on a NEST notifier is rethrown rather than mistaken for it.
 */
export async function tryRegisterObserver(
  notifier: ITokenRateNotifier,
  sourceAddress: string
): Promise<boolean> {
  const notifierOwner = await impersonateWithBalance(await notifier.owner())

  try {
    await notifier
      .connect(notifierOwner)
      .addObserver.staticCall(sourceAddress, OBSERVER_KIND_WITH_ARGS)
  } catch (error) {
    const errorName = decodeNotifierError(notifier, error)
    // Already registered (deployed mode): the notifier path works as-is.
    if (errorName === 'ErrorAddExistedObserver') return true
    // Any other typed error comes from a NEST notifier rejecting the registration for real.
    if (errorName !== undefined) throw error
    return false
  }

  await notifier.connect(notifierOwner).addObserver(sourceAddress, OBSERVER_KIND_WITH_ARGS)
  return true
}

/**
 * Fires one fee-minting rebase report into the revenue source and returns the receipt.
 *
 * `viaNotifier: true` drives the real `TokenRateNotifier.handlePostTokenRebase` fan-out as the
 * `TOKEN_RATE_PROVIDER` (requires the fork prepared with the core mock-upgrade, see the spec
 * header). `viaNotifier: false` bypasses the notifier by impersonating the current
 * `LidoLocator.postTokenRebaseReceiver()` and calling `pushTokenRate` directly — the source only
 * authorizes against that address, so this path needs no mock-upgrade.
 */
export async function driveRebase(
  revenueSource: StakingRevenueSource,
  sharesMintedAsFees: bigint,
  options: { viaNotifier: boolean }
): Promise<TransactionReceipt> {
  const locator = await ethers.getContractAt('ILidoLocator', LIDO_LOCATOR_ADDRESS)
  const receiverAddress = await locator.postTokenRebaseReceiver()

  // Report timestamps must strictly increase past the source's replay watermark.
  const lastReportTimestamp = await revenueSource.lastReportTimestamp()
  const now = BigInt(await time.latest())
  const reportTimestamp = (lastReportTimestamp > now ? lastReportTimestamp : now) + 1n

  if (options.viaNotifier) {
    const notifier = await ethers.getContractAt('ITokenRateNotifier', receiverAddress)
    const rebaseProvider = await impersonateWithBalance(await notifier.TOKEN_RATE_PROVIDER())
    const tx = await notifier
      .connect(rebaseProvider)
      .handlePostTokenRebase(reportTimestamp, 1n, 1n, 1n, 1n, 1n, sharesMintedAsFees)
    return (await tx.wait())!
  }

  const rebaseReceiver = await impersonateWithBalance(receiverAddress)
  const tx = await revenueSource
    .connect(rebaseReceiver)
    .pushTokenRate(reportTimestamp, 1n, 1n, 1n, 1n, 1n, sharesMintedAsFees)
  return (await tx.wait())!
}

/// Treasury stETH slice of a fee mint, computed exactly as StakingRevenueSource.pushTokenRate does
/// against live fork state.
export async function expectedTreasuryStEth(sharesMintedAsFees: bigint): Promise<bigint> {
  const locator = await ethers.getContractAt('ILidoLocator', LIDO_LOCATOR_ADDRESS)
  const stakingRouter = await ethers.getContractAt('IStakingRouter', await locator.stakingRouter())
  const stEth = await ethers.getContractAt('IStETH', await locator.lido())

  const [modulesFee, treasuryFee] = await stakingRouter.getStakingFeeAggregateDistribution()
  const totalFee = modulesFee + treasuryFee
  if (totalFee === 0n) return 0n

  return stEth.getPooledEthByShares((sharesMintedAsFees * treasuryFee) / totalFee)
}

/**
 * Reserve accrued at `timestamp`, mirroring `BuybackAllocator._reserveCurrentUSD`: zero while the
 * anchor is still in the future (every checkpoint moves the cursor to the next day's midnight),
 * otherwise one daily rate for the anchor day plus one per full day since.
 */
export function reserveAccruedUSD(rate: bigint, anchorTS: bigint, timestamp: bigint): bigint {
  return timestamp < anchorTS ? 0n : rate * ((timestamp - anchorTS) / ONE_DAY + 1n)
}

/**
 * Spend-window end after `BuybackAllocator._rollWindow` runs at `timestamp`: unchanged while the
 * window is still open, otherwise advanced to the next activation-aligned duration boundary past
 * `timestamp`. Windows align to the activation timestamp, not to calendar days.
 */
export function rolledWindowEndTS(
  activationTS: bigint,
  windowDuration: bigint,
  currentEndTS: bigint,
  timestamp: bigint
): bigint {
  if (timestamp < currentEndTS) {
    return currentEndTS
  }
  return activationTS + ((timestamp - activationTS) / windowDuration + 1n) * windowDuration
}

/// Pre-allocation snapshot of the executor's tracked order, for the free-stETH mirror.
export interface TrackedOrderState {
  address: string
  validTo: bigint
  stEthBalance: bigint
  /// Stonks that created the order — an expired-order sweep recovers the residual there.
  recoveryStonks: string
}

/**
 * Captures the executor's tracked order, or `null` when none is tracked. `onStEthAllocated`
 * first sweeps an expired tracked order (residual recovered to its creating Stonks) and then, in
 * LP mode, reserves a live order's balance against the free stETH — this snapshot lets the test
 * mirror both effects. Fresh staging tracks no order; the terms activate over deployed contracts.
 */
export async function captureTrackedOrderState(
  executor: BuybackExecutor
): Promise<TrackedOrderState | null> {
  const orderAddress = await executor.lastOrderAddress()
  if (orderAddress === ZeroAddress) {
    return null
  }

  const order = await ethers.getContractAt('Order', orderAddress)
  const stEth = await ethers.getContractAt('IERC20', getContracts().STETH)

  return {
    address: orderAddress,
    validTo: await executor.lastOrderValidTo(),
    stEthBalance: await stEth.balanceOf(orderAddress),
    recoveryStonks: await order.stonks(),
  }
}

// --- Settlement and funding ---

/**
 * Imitates a full CoW settlement of `order`: the impersonated vault relayer pulls the order's
 * stETH (using the allowance the order armed at initialization), then `ldoHolder` delivers the
 * buy-side LDO to `receiver`, as a winning solver would.
 */
export async function simulateCowFill(options: {
  orderAddress: string
  buyAmount: bigint
  receiver: string
  ldoHolder: Signer
}): Promise<void> {
  const contracts = getContracts()
  const stEth: IERC20 = await ethers.getContractAt('IERC20', contracts.STETH)

  // Hardhat lets an impersonated contract account send transactions directly, so the relayer's
  // real bytecode stays in place; the transfer below only exercises its stETH allowance.
  const relayer = await impersonateWithBalance(contracts.VAULT_RELAYER)
  await stEth
    .connect(relayer)
    .transferFrom(
      options.orderAddress,
      contracts.VAULT_RELAYER,
      await stEth.balanceOf(options.orderAddress)
    )

  const ldo: IERC20 = await ethers.getContractAt('IERC20', contracts.LDO)
  await ldo.connect(options.ldoHolder).transfer(options.receiver, options.buyAmount)
}

/// Mints stETH by staking ETH from `staker` and transfers `stEthAmount` to `receiver`.
export async function fundStEth(
  staker: Signer,
  receiver: string,
  stEthAmount: bigint
): Promise<void> {
  const contracts = getContracts()
  const lido = new ethers.Contract(contracts.STETH, STETH_ABI, staker)
  await lido.submit(ZeroAddress, { value: stEthAmount + parseEther('1') })

  const stEth: IERC20 = await ethers.getContractAt('IERC20', contracts.STETH)
  await stEth.connect(staker).transfer(receiver, stEthAmount)
}
