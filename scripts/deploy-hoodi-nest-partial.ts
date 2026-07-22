import { assert } from 'chai'
import { network } from 'hardhat'
import { parseEther } from 'ethers'

import fmt from '../utils/format'
import { confirmOrAbort } from '../utils/prompt'
import { getContracts } from '../utils/contracts'
import { getDeployer, saveDeployment, verify, waitForDeployment } from '../utils/deployment'
import {
  AmountConverterFactory__factory,
  BuybackAllocator__factory,
  BuybackExecutor__factory,
  ChainlinkFeedRegistryStub__factory,
  CurvePoolStub__factory,
  OracleRouter__factory,
  StakingRevenueSource__factory,
  StonksFactory__factory,
} from '../typechain-types'
import { AmountConverterDeployedEvent } from '../typechain-types/contracts/factories/AmountConverterFactory'
import { StonksDeployedEvent } from '../typechain-types/contracts/factories/StonksFactory'
import { STONKS_PARAMS } from './nest-parameters'

/**
 * Treasury-mode NEST deployment for Hoodi: real StakingRevenueSource, BuybackExecutor, Stonks and
 * BuybackAllocator. Curve is a configurable stub (LP mode is out of scope on Hoodi), CoW is the
 * settlement/relayer stub pair already deployed on Hoodi. Mirrors test/hoodi/HoodiNestPartialFork.t.sol.
 *
 * The script also pushes the registry feeds (permissionless, pre-vote). Remaining wiring is a vote:
 *  - Voting: oracleRouter.setEthUsdBridge, setTokenFeed(stETH), setTokenFeed(LDO),
 *    executor.grantRole(ALLOCATOR_ROLE, allocator), executor.setStonks(stonks), allocator.activate()
 *  - Agent: tokenRateNotifier.addObserver(revenueSource, WithArgs), fund the allocator with stETH
 */

// https://docs.lido.fi/deployed-contracts/hoodi
const LIDO_LOCATOR = '0xe2EF9536DAAAEBFf5b1c130957AB3E80056b06D8'

const ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
const USD = '0x0000000000000000000000000000000000000348'

// Dummy aggregator addresses; the stub stores them but reads prices from the stub itself.
const ETH_USD_AGGREGATOR = '0xbeEfCAFE00000000000000000000000000000000'
const STETH_ETH_AGGREGATOR = '0xcafE000000000000000000000000000000000001'
const LDO_ETH_AGGREGATOR = '0xCAFE000000000000000000000000000000000002'

/**
 * Curve `price_oracle`: LDO per wstETH. Only read by the LP-mode divergence gate, dormant in
 * treasury mode. Set to a realistic value (LDO ~$0.72, wstETH ~$1976 => ~2741) so it stays within
 * the 2% divergence tolerance if LP mode is ever exercised.
 */
const CURVE_POOL_PRICE_ORACLE = parseEther('2741')

/**
 * Allocator limits sized for Hoodi, not mainnet. Hoodi TVL is ~2.23M ETH, so real rebases yield
 * ~10-11 stETH (~$20k) of treasury revenue per day. The mainnet reserve ($109,589/day) would eat
 * all of it and the budget would never turn positive. Kept in the same 1e18-scaled USD units.
 */
const HOODI_ALLOCATOR_PARAMS = {
  dailyCapUSD: parseEther('10000'), // $10,000
  yearlyCapUSD: parseEther('1000000'), // $1,000,000
  reserveDailyRateUSD: parseEther('5000'), // $5,000/day, ~25% of daily revenue, keeps the reserve path live
  minStEthPriceUSD: parseEther('100'), // $100 floor, far below spot so it checks but never blocks
  minSpendPerCallUSD: parseEther('100'), // $100 dust floor
  surplusShareBP: 5000n, // 50%, as on mainnet
} as const

/**
 * Executor bounds sized for Hoodi. Daily budget is ~4 stETH, so the mainnet 1 stETH order floor is
 * dropped to 0.5 to keep orders reachable. Divergence gate and TVL threshold match mainnet.
 */
const HOODI_EXECUTOR_PARAMS = {
  poolPriceDivergenceToleranceBps: 200n, // 2%
  minAllowedOrderAmount: parseEther('0.5'),
  maxAllowedOrderAmount: parseEther('20'),
  minDepositValueUsd: parseEther('100'),
  maxDepositValueUsd: parseEther('10000'),
  poolBootstrapMinTvlUsd: parseEther('250000'),
} as const

assert(network.name === 'hoodi', 'This script is Hoodi-only')

async function main() {
  const contracts = getContracts()

  console.log(
    `Preparing for the treasury-mode ${fmt.name('NEST')} deployment on "${fmt.network(
      network.name
    )}" network...\n`
  )

  const deployer = await getDeployer()

  console.log(`Deployment parameters:`)
  console.log(`  * ${fmt.name('Admin (Voting)')}: ${fmt.value(contracts.ADMIN)}`)
  console.log(`  * ${fmt.name('Treasury (Agent)')}: ${fmt.value(contracts.AGENT)}`)
  console.log(`  * ${fmt.name('stETH')}: ${fmt.value(contracts.STETH)}`)
  console.log(`  * ${fmt.name('wstETH')}: ${fmt.value(contracts.WSTETH)}`)
  console.log(`  * ${fmt.name('LDO')}: ${fmt.value(contracts.LDO)}`)
  console.log(`  * ${fmt.name('OracleRouter')}: ${fmt.value(contracts.ORACLE_ROUTER)}`)
  console.log(`  * ${fmt.name('LidoLocator')}: ${fmt.value(LIDO_LOCATOR)}`)
  console.log(`  * ${fmt.name('CoW Settlement (stub)')}: ${fmt.value(contracts.SETTLEMENT)}`)
  console.log(`  * ${fmt.name('CoW VaultRelayer (stub)')}: ${fmt.value(contracts.VAULT_RELAYER)}`)
  console.log()

  await confirmOrAbort('Proceed?')

  // 1. StakingRevenueSource
  const revenueSource = await new StakingRevenueSource__factory(deployer).deploy(
    contracts.ORACLE_ROUTER,
    LIDO_LOCATOR
  )
  const revenueSourceReceipt = await waitForDeployment(revenueSource.deploymentTransaction()!)
  const revenueSourceAddress = await revenueSource.getAddress()
  console.log(`${fmt.name('StakingRevenueSource')}: ${fmt.address(revenueSourceAddress)}\n`)

  saveDeployment('stakingRevenueSource', {
    contract: 'contracts/automated-buybacks/revenue/StakingRevenueSource.sol',
    address: revenueSourceAddress,
    deployTx: revenueSourceReceipt.hash,
    constructorArgs: [contracts.ORACLE_ROUTER, LIDO_LOCATOR],
  })

  // 2. CurvePoolStub, only satisfies the executor's constructor checks (coins + price_oracle)
  const curvePool = await new CurvePoolStub__factory(deployer).deploy(contracts.LDO, contracts.WSTETH)
  const curvePoolReceipt = await waitForDeployment(curvePool.deploymentTransaction()!)
  const curvePoolAddress = await curvePool.getAddress()
  await (await curvePool.setPriceOracle(CURVE_POOL_PRICE_ORACLE)).wait(1)
  console.log(`${fmt.name('CurvePoolStub')}: ${fmt.address(curvePoolAddress)}\n`)

  saveDeployment('curvePoolStub', {
    contract: 'contracts/stubs/CurvePoolStub.sol',
    address: curvePoolAddress,
    deployTx: curvePoolReceipt.hash,
    constructorArgs: [contracts.LDO, contracts.WSTETH],
  })

  // 3. BuybackExecutor
  const executorParams = {
    admin: contracts.ADMIN,
    treasury: contracts.AGENT,
    wstEth: contracts.WSTETH,
    ldo: contracts.LDO,
    oracleRouter: contracts.ORACLE_ROUTER,
    curvePoolAndToken: curvePoolAddress,
    ...HOODI_EXECUTOR_PARAMS,
  }
  const executor = await new BuybackExecutor__factory(deployer).deploy(executorParams)
  const executorReceipt = await waitForDeployment(executor.deploymentTransaction()!)
  const executorAddress = await executor.getAddress()
  console.log(`${fmt.name('BuybackExecutor')}: ${fmt.address(executorAddress)}\n`)

  saveDeployment('buybackExecutor', {
    contract: 'contracts/automated-buybacks/BuybackExecutor.sol',
    address: executorAddress,
    deployTx: executorReceipt.hash,
    constructorArgs: [executorParams],
  })

  // 4. AmountConverterFactory + AmountConverter instance (ETH-anchored, stETH -> LDO)
  const amountConverterFactory = await new AmountConverterFactory__factory(deployer).deploy(
    contracts.ORACLE_ROUTER
  )
  const acFactoryReceipt = await waitForDeployment(amountConverterFactory.deploymentTransaction()!)
  const acFactoryAddress = await amountConverterFactory.getAddress()
  console.log(`${fmt.name('AmountConverterFactory')}: ${fmt.address(acFactoryAddress)}\n`)

  saveDeployment('amountConverterFactory', {
    contract: 'contracts/factories/AmountConverterFactory.sol',
    address: acFactoryAddress,
    deployTx: acFactoryReceipt.hash,
    constructorArgs: [contracts.ORACLE_ROUTER],
  })

  const acTx = await amountConverterFactory.deployAmountConverter(
    [contracts.STETH],
    [contracts.LDO],
    true
  )
  const acReceipt = await waitForDeployment(acTx)
  const acLog = acReceipt.logs.find(
    (log) =>
      log.topics[0] ===
      amountConverterFactory.getEvent('AmountConverterDeployed').fragment.topicHash
  ) as AmountConverterDeployedEvent.Log | undefined
  if (!acLog) throw new Error('AmountConverterDeployed event not found')
  const amountConverterAddress = acLog.args.amountConverterAddress
  const amountConverterArgs = [contracts.ORACLE_ROUTER, [contracts.STETH], [contracts.LDO], true]
  console.log(`${fmt.name('AmountConverter')}: ${fmt.address(amountConverterAddress)}\n`)

  saveDeployment('amountConverterEthAnchored', {
    contract: 'contracts/AmountConverter.sol',
    address: amountConverterAddress,
    deployTx: acReceipt.hash,
    constructorArgs: amountConverterArgs,
  })

  // 5. StonksFactory + Stonks treasury instance (receiver == Agent)
  const stonksFactory = await new StonksFactory__factory(deployer).deploy(
    contracts.ADMIN,
    contracts.AGENT,
    contracts.SETTLEMENT,
    contracts.VAULT_RELAYER
  )
  const stonksFactoryReceipt = await waitForDeployment(stonksFactory.deploymentTransaction()!)
  const stonksFactoryAddress = await stonksFactory.getAddress()
  const orderSample = await stonksFactory.ORDER_SAMPLE()
  console.log(`${fmt.name('StonksFactory')}: ${fmt.address(stonksFactoryAddress)}`)
  console.log(`${fmt.name('OrderSample')}: ${fmt.address(orderSample)}\n`)

  saveDeployment('stonksFactory', {
    contract: 'contracts/factories/StonksFactory.sol',
    address: stonksFactoryAddress,
    deployTx: stonksFactoryReceipt.hash,
    constructorArgs: [contracts.ADMIN, contracts.AGENT, contracts.SETTLEMENT, contracts.VAULT_RELAYER],
  })

  const stonksTx = await stonksFactory.deployStonks(
    executorAddress,
    contracts.STETH,
    contracts.LDO,
    amountConverterAddress,
    STONKS_PARAMS.orderDurationInSeconds,
    STONKS_PARAMS.marginInBasisPoints,
    STONKS_PARAMS.priceToleranceInBasisPoints,
    STONKS_PARAMS.maxImprovementInBasisPoints,
    STONKS_PARAMS.allowPartialFill,
    contracts.AGENT
  )
  const stonksReceipt = await waitForDeployment(stonksTx)
  const stonksLog = stonksReceipt.logs.find(
    (log) => log.topics[0] === stonksFactory.getEvent('StonksDeployed').fragment.topicHash
  ) as StonksDeployedEvent.Log | undefined
  if (!stonksLog) throw new Error('StonksDeployed event not found')
  const stonksAddress = stonksLog.args.stonksAddress
  const stonksArgs = [
    {
      admin: contracts.ADMIN,
      agent: contracts.AGENT,
      manager: executorAddress,
      tokenFrom: contracts.STETH,
      tokenTo: contracts.LDO,
      amountConverter: amountConverterAddress,
      orderSample,
      orderDurationInSeconds: STONKS_PARAMS.orderDurationInSeconds,
      marginInBasisPoints: STONKS_PARAMS.marginInBasisPoints,
      priceToleranceInBasisPoints: STONKS_PARAMS.priceToleranceInBasisPoints,
      maxImprovementInBasisPoints: STONKS_PARAMS.maxImprovementInBasisPoints,
      allowPartialFill: STONKS_PARAMS.allowPartialFill,
      receiver: contracts.AGENT,
    },
  ]
  console.log(`${fmt.name('Stonks (treasury)')}: ${fmt.address(stonksAddress)}\n`)

  saveDeployment('buybackStonksTreasury', {
    contract: 'contracts/Stonks.sol',
    address: stonksAddress,
    deployTx: stonksReceipt.hash,
    constructorArgs: stonksArgs,
  })

  // 6. BuybackAllocator
  const allocatorParams = {
    admin: contracts.ADMIN,
    treasury: contracts.AGENT,
    stEth: contracts.STETH,
    oracleRouter: contracts.ORACLE_ROUTER,
    executor: executorAddress,
    dailyCapUSD: HOODI_ALLOCATOR_PARAMS.dailyCapUSD,
    yearlyCapUSD: HOODI_ALLOCATOR_PARAMS.yearlyCapUSD,
    reserveDailyRateUSD: HOODI_ALLOCATOR_PARAMS.reserveDailyRateUSD,
    minStEthPriceUSD: HOODI_ALLOCATOR_PARAMS.minStEthPriceUSD,
    minSpendPerCallUSD: HOODI_ALLOCATOR_PARAMS.minSpendPerCallUSD,
    surplusShareBP: HOODI_ALLOCATOR_PARAMS.surplusShareBP,
    revenueSources: [revenueSourceAddress],
  }

  const allocator = await new BuybackAllocator__factory(deployer).deploy(allocatorParams)
  const allocatorReceipt = await waitForDeployment(allocator.deploymentTransaction()!)
  const allocatorAddress = await allocator.getAddress()
  console.log(`${fmt.name('BuybackAllocator')}: ${fmt.address(allocatorAddress)}\n`)

  saveDeployment('buybackAllocator', {
    contract: 'contracts/automated-buybacks/BuybackAllocator.sol',
    address: allocatorAddress,
    deployTx: allocatorReceipt.hash,
    constructorArgs: [allocatorParams],
  })

  // 7. Pre-vote oracle config (permissionless, not a governance step). Push feeds to the registry
  // the router actually reads, resolved live from OracleRouter.FEED_REGISTRY() rather than the
  // (stale) address in utils/contracts.ts. Timestamps stamped now so the feeds are fresh.
  const router = OracleRouter__factory.connect(contracts.ORACLE_ROUTER, deployer)
  const feedRegistryAddress = await router.FEED_REGISTRY()
  const feedRegistry = ChainlinkFeedRegistryStub__factory.connect(feedRegistryAddress, deployer)
  const now = BigInt((await deployer.provider!.getBlock('latest'))!.timestamp)
  console.log(`${fmt.name('FeedRegistry')}: ${fmt.address(feedRegistryAddress)}`)

  const feeds = [
    { base: ETH, quote: USD, aggregator: ETH_USD_AGGREGATOR, decimals: 8, answer: 192_326_070_000n },
    { base: contracts.STETH, quote: ETH, aggregator: STETH_ETH_AGGREGATOR, decimals: 18, answer: 999_805_027_725_356_100n },
    { base: contracts.LDO, quote: ETH, aggregator: LDO_ETH_AGGREGATOR, decimals: 18, answer: 375_000_000_000_000n },
  ]
  for (const f of feeds) {
    await (
      await feedRegistry.setFeed(f.base, f.quote, {
        aggregator: f.aggregator,
        roundId: 1n,
        answeredInRound: 1n,
        decimals: f.decimals,
        startedAt: now,
        updatedAt: now,
        answer: f.answer,
      })
    ).wait(1)
    console.log(`  * feed ${fmt.value(f.base)}/${fmt.value(f.quote)} set`)
  }
  console.log()

  await verify(revenueSourceAddress, [contracts.ORACLE_ROUTER, LIDO_LOCATOR], revenueSourceReceipt)
  await verify(curvePoolAddress, [contracts.LDO, contracts.WSTETH], curvePoolReceipt)
  await verify(executorAddress, [executorParams], executorReceipt)
  await verify(acFactoryAddress, [contracts.ORACLE_ROUTER], acFactoryReceipt)
  await verify(amountConverterAddress, amountConverterArgs, acReceipt)
  await verify(
    stonksFactoryAddress,
    [contracts.ADMIN, contracts.AGENT, contracts.SETTLEMENT, contracts.VAULT_RELAYER],
    stonksFactoryReceipt
  )
  await verify(stonksAddress, stonksArgs, stonksReceipt)
  await verify(allocatorAddress, [allocatorParams], allocatorReceipt)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
