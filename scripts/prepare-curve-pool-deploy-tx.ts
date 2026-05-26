import { ethers, network } from 'hardhat'
import { writeFileSync } from 'node:fs'

import fmt from '../utils/format'
import { getContracts } from '../utils/contracts'
import { fetchFeedData, type FeedData } from '../utils/chainlink-helpers'

const POOL_CONFIG = {
  name: 'Curve.fi LDO/wstETH',
  symbol: 'LDOwstETH-f',
  implementationId: 0n, // default TwoCrypto-NG implementation
  A: 400_000n, // 4e5
  gamma: 145_000_000_000_000n, // 1.45e14
  midFee: 500_000n, // 0.5 bps (5e5)
  outFee: 5_000_000n, // 5 bps (5e6)
  feeGamma: 230_000_000_000_000n, // 2.3e14
  allowedExtraProfit: 2_000_000_000_000n, // 2e12
  adjustmentStep: 146_000_000_000_000n, // 1.46e14
  maExpTime: 866n, // ~600s EMA half-life
  // initial_price is computed at runtime
} as const

const MAX_FEED_AGE_SECONDS = BigInt(25 * 60 * 60) // 25h

const POOL_FACTORY_ABI = [
  'function deploy_pool(string _name, string _symbol, address[2] _coins, uint256 implementation_id, uint256 A, uint256 gamma, uint256 mid_fee, uint256 out_fee, uint256 fee_gamma, uint256 allowed_extra_profit, uint256 adjustment_step, uint256 ma_exp_time, uint256 initial_price) returns (address)',
  'function pool_implementations(uint256 id) view returns (address)',
  'function math_implementation() view returns (address)',
  'function get_market_counts(address coin_a, address coin_b) view returns (uint256)',
] as const

const WSTETH_ABI = [
  'function getStETHByWstETH(uint256 wstEthAmount) view returns (uint256)',
] as const

function assertFeed(label: string, feed: FeedData) {
  if (!feed.exists) {
    throw new Error(`${label}: feed not found in registry`)
  }
  if (feed.answer <= 0n) {
    throw new Error(`${label}: non-positive answer ${feed.answer}`)
  }

  const now = BigInt(Math.floor(Date.now() / 1000))
  const age = now - feed.updatedAt
  if (age > MAX_FEED_AGE_SECONDS) {
    throw new Error(`${label}: feed stale: age ${age}s > max ${MAX_FEED_AGE_SECONDS}s`)
  }
}

// initial_price = wstETH_ETH / LDO_ETH * 1e18, where X is any common quote currency
function computeInitialPrice(ldoEth: FeedData, stEthEth: FeedData, stEthPerWstEth: bigint): bigint {
  const num = stEthEth.answer * stEthPerWstEth * 10n ** BigInt(ldoEth.decimals)
  const den = ldoEth.answer * 10n ** BigInt(stEthEth.decimals)
  return num / den
}

const MAX_FEE = 10n * 10n ** 9n // 1e10
const ONE_E18 = 10n ** 18n
const ONE_E6 = 10n ** 6n
const ONE_E30 = 10n ** 30n

// EMA half-life = ma_exp_time * ln(2). The factory's bounds correspond to a
// minimum half-life of ~1 minute and a maximum of ~7 days.
const MA_EXP_TIME_MIN = 86n // floor(60 / ln(2)) -> ~1-minute half-life
const MA_EXP_TIME_MAX = 872_542n // ceil(7 * 86400 / ln(2)) -> ~7-day half-life
// Sanity checks for pool config params
function assertParamsInFactoryBounds(initialPrice: bigint, coins: readonly [string, string]) {
  if (!(POOL_CONFIG.midFee < MAX_FEE - 1n)) {
    throw new Error('mid_fee >= MAX_FEE-1')
  }

  if (!(POOL_CONFIG.outFee >= POOL_CONFIG.midFee)) {
    throw new Error('out_fee < mid_fee')
  }

  if (!(POOL_CONFIG.outFee < MAX_FEE - 1n)) {
    throw new Error('out_fee >= MAX_FEE-1')
  }

  if (!(POOL_CONFIG.feeGamma > 0n && POOL_CONFIG.feeGamma <= ONE_E18)) {
    throw new Error('fee_gamma out of (0, 1e18]')
  }

  if (!(POOL_CONFIG.allowedExtraProfit <= ONE_E18)) {
    throw new Error('allowed_extra_profit > 1e18')
  }

  if (!(POOL_CONFIG.adjustmentStep > 0n && POOL_CONFIG.adjustmentStep <= ONE_E18)) {
    throw new Error('adjustment_step out of (0, 1e18]')
  }

  if (!(POOL_CONFIG.maExpTime > MA_EXP_TIME_MIN && POOL_CONFIG.maExpTime < MA_EXP_TIME_MAX)) {
    throw new Error('ma_exp_time out of bounds')
  }

  if (!(initialPrice > ONE_E6 && initialPrice < ONE_E30)) {
    throw new Error('initial_price out of factory bounds')
  }

  if (coins[0].toLowerCase() === coins[1].toLowerCase()) {
    throw new Error('duplicate coins')
  }
}

// Reproduces Safe Transaction Builder's batch-file checksum (keccak256 over a
// sorted-keys serialization with meta.name nulled). Matching the algorithm lets
// the Safe UI verify the file wasn't edited after generation, suppressing the
// "batch contains some changed properties" warning. Algorithm mirrored from:
// https://github.com/safe-global/safe-react-apps/blob/main/apps/tx-builder/src/lib/checksum.ts
const stringifyReplacer = (_: string, v: unknown) => (v === undefined ? null : v)

function serializeForChecksum(json: unknown): string {
  if (Array.isArray(json)) {
    return `[${json.map((el) => serializeForChecksum(el)).join(',')}]`
  }
  if (typeof json === 'object' && json !== null) {
    const obj = json as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    let acc = `{${JSON.stringify(keys, stringifyReplacer)}`
    for (const k of keys) {
      acc += `${serializeForChecksum(obj[k])},`
    }
    return `${acc}}`
  }
  return JSON.stringify(json, stringifyReplacer)
}

function computeSafeBatchChecksum(batch: { meta: Record<string, unknown> }): string {
  const serialized = serializeForChecksum({
    ...batch,
    meta: { ...batch.meta, name: null },
  })
  return ethers.keccak256(ethers.toUtf8Bytes(serialized))
}

// Make sure the factory is wired up and warn on existing LDO/wstETH pools
async function preflight(factoryAddress: string, ldo: string, wstEth: string) {
  const factory = new ethers.Contract(factoryAddress, POOL_FACTORY_ABI, ethers.provider)

  const implAddr: string = await factory.pool_implementations(POOL_CONFIG.implementationId)
  if (implAddr === ethers.ZeroAddress) {
    throw new Error(`factory has no pool implementation at id=${POOL_CONFIG.implementationId}`)
  }

  const mathImpl: string = await factory.math_implementation()
  if (mathImpl === ethers.ZeroAddress) {
    throw new Error('factory has no math implementation set')
  }

  const existingCount: bigint = await factory.get_market_counts(ldo, wstEth)
  if (existingCount > 0n) {
    console.warn(
      `${existingCount} existing pools already deployed. This script will deploy another one. Confirm this is intended.`
    )
  }

  return { implAddr, mathImpl }
}

async function main() {
  const contracts = getContracts()

  if (contracts.CURVE_TWOCRYPTO_NG_FACTORY === ethers.ZeroAddress) {
    throw new Error(`Curve TwoCrypto-NG factory address is not set for network "${network.name}"`)
  }

  if (contracts.WSTETH === ethers.ZeroAddress) {
    throw new Error(`wstETH address is not set for network "${network.name}".`)
  }

  const SAFE_ADDRESS = process.env.SAFE_ADDRESS
  if (!SAFE_ADDRESS) {
    throw new Error(`SAFE_ADDRESS is not set in the environment variables.`)
  }

  if (!ethers.isAddress(SAFE_ADDRESS)) {
    throw new Error(`SAFE_ADDRESS is not a valid address: ${SAFE_ADDRESS}`)
  }

  console.log(
    `Preparing Curve TwoCrypto-NG ${fmt.name('LDO/wstETH')} deploy bundle on ` +
      `"${fmt.network(network.name)}"...\n`
  )

  const coins: readonly [string, string] = [contracts.LDO, contracts.WSTETH]

  // 1. Preflight: factory configured, watch for accidental duplicates
  const { implAddr, mathImpl } = await preflight(
    contracts.CURVE_TWOCRYPTO_NG_FACTORY,
    coins[0],
    coins[1]
  )

  // 2. Read prices from Chainlink via the project's FeedRegistry helper, and
  //    the wstETH-to-stETH conversion rate on-chain from the wstETH contract.
  //    ETH-quoted feeds: LDO/USD isn't in the FeedRegistry on mainnet; the
  //    final ratio is currency-invariant so this produces the same number.
  const wstEth = new ethers.Contract(contracts.WSTETH, WSTETH_ABI, ethers.provider)
  const [ldoEth, stEthEth, stEthPerWstEth] = await Promise.all([
    fetchFeedData(contracts.LDO, contracts.CHAINLINK_ETH_QUOTE),
    fetchFeedData(contracts.STETH, contracts.CHAINLINK_ETH_QUOTE),
    wstEth.getStETHByWstETH(10n ** 18n) as Promise<bigint>,
  ])
  assertFeed('LDO/ETH', ldoEth)
  assertFeed('stETH/ETH', stEthEth)

  if (stEthPerWstEth <= 0n) {
    throw new Error(`wstETH.getStETHByWstETH(1e18) returned non-positive: ${stEthPerWstEth}`)
  }
  const initialPrice = computeInitialPrice(ldoEth, stEthEth, stEthPerWstEth)

  // 3. Validate everything before encoding.
  assertParamsInFactoryBounds(initialPrice, coins)

  // 4. Encode deploy_pool calldata.
  const iface = new ethers.Interface(POOL_FACTORY_ABI)
  const data = iface.encodeFunctionData('deploy_pool', [
    POOL_CONFIG.name,
    POOL_CONFIG.symbol,
    coins,
    POOL_CONFIG.implementationId,
    POOL_CONFIG.A,
    POOL_CONFIG.gamma,
    POOL_CONFIG.midFee,
    POOL_CONFIG.outFee,
    POOL_CONFIG.feeGamma,
    POOL_CONFIG.allowedExtraProfit,
    POOL_CONFIG.adjustmentStep,
    POOL_CONFIG.maExpTime,
    initialPrice,
  ])

  // 5. Simulate from the Safe so we know the tx will succeed and where the
  //    pool will land. deploy_pool on the Curve factory is permissionless, so
  //    an eth_call from `SAFE_ADDRESS` returns the deterministic address the
  //    real tx would mint.
  const returnData = await ethers.provider.call({
    from: SAFE_ADDRESS,
    to: contracts.CURVE_TWOCRYPTO_NG_FACTORY,
    data,
  })

  if (!returnData || returnData === '0x') {
    throw new Error('simulation returned empty data')
  }

  // 6. Emit a Safe Transaction Builder JSON.
  const safeTxJson = {
    version: '1.0',
    chainId: '1',
    createdAt: Date.now(),
    meta: {
      name: 'NEST: deploy Curve LDO/wstETH TwoCrypto-NG pool',
      createdFromSafeAddress: SAFE_ADDRESS,
    },
    transactions: [
      {
        to: contracts.CURVE_TWOCRYPTO_NG_FACTORY,
        value: '0',
        data,
        contractMethod: {
          name: 'deploy_pool',
          payable: false,
          inputs: [
            { name: '_name', type: 'string', internalType: 'string' },
            { name: '_symbol', type: 'string', internalType: 'string' },
            { name: '_coins', type: 'address[2]', internalType: 'address[2]' },
            { name: 'implementation_id', type: 'uint256', internalType: 'uint256' },
            { name: 'A', type: 'uint256', internalType: 'uint256' },
            { name: 'gamma', type: 'uint256', internalType: 'uint256' },
            { name: 'mid_fee', type: 'uint256', internalType: 'uint256' },
            { name: 'out_fee', type: 'uint256', internalType: 'uint256' },
            { name: 'fee_gamma', type: 'uint256', internalType: 'uint256' },
            { name: 'allowed_extra_profit', type: 'uint256', internalType: 'uint256' },
            { name: 'adjustment_step', type: 'uint256', internalType: 'uint256' },
            { name: 'ma_exp_time', type: 'uint256', internalType: 'uint256' },
            { name: 'initial_price', type: 'uint256', internalType: 'uint256' },
          ],
        },
        contractInputsValues: {
          _name: POOL_CONFIG.name,
          _symbol: POOL_CONFIG.symbol,
          _coins: JSON.stringify([coins[0], coins[1]]),
          implementation_id: POOL_CONFIG.implementationId.toString(),
          A: POOL_CONFIG.A.toString(),
          gamma: POOL_CONFIG.gamma.toString(),
          mid_fee: POOL_CONFIG.midFee.toString(),
          out_fee: POOL_CONFIG.outFee.toString(),
          fee_gamma: POOL_CONFIG.feeGamma.toString(),
          allowed_extra_profit: POOL_CONFIG.allowedExtraProfit.toString(),
          adjustment_step: POOL_CONFIG.adjustmentStep.toString(),
          ma_exp_time: POOL_CONFIG.maExpTime.toString(),
          initial_price: initialPrice.toString(),
        },
      },
    ],
  }

  const safeTxJsonWithChecksum = {
    ...safeTxJson,
    meta: { ...safeTxJson.meta, checksum: computeSafeBatchChecksum(safeTxJson) },
  }
  const safeTxPath = 'curve-pool-deploy-safe-tx.json'
  writeFileSync(safeTxPath, JSON.stringify(safeTxJsonWithChecksum, null, 2))

  // 7. Print a verification summary
  console.log('-------------------------------------------------------------')
  console.log(' NEST: Curve TwoCrypto-NG LDO/wstETH -- Safe deploy bundle')
  console.log('-------------------------------------------------------------')
  console.log(` Network               : ${fmt.network(network.name)}`)
  console.log(` Safe                  : ${fmt.address(SAFE_ADDRESS)}`)
  console.log(` Factory               : ${fmt.address(contracts.CURVE_TWOCRYPTO_NG_FACTORY)}`)
  console.log(` Pool implementation   : ${fmt.address(implAddr)}`)
  console.log(` Math implementation   : ${fmt.address(mathImpl)}`)
  console.log()
  console.log(` Pool params`)
  console.log(`   name                : ${POOL_CONFIG.name}`)
  console.log(`   symbol              : ${POOL_CONFIG.symbol}`)
  console.log(`   coins[0] = LDO      : ${fmt.address(coins[0])}`)
  console.log(`   coins[1] = wstETH   : ${fmt.address(coins[1])}`)
  console.log(`   implementation_id   : ${POOL_CONFIG.implementationId}`)
  console.log(`   A                   : ${POOL_CONFIG.A}`)
  console.log(`   gamma               : ${POOL_CONFIG.gamma}`)
  console.log(`   mid_fee             : ${POOL_CONFIG.midFee}        (0.5 bps)`)
  console.log(`   out_fee             : ${POOL_CONFIG.outFee}      (5   bps)`)
  console.log(`   fee_gamma           : ${POOL_CONFIG.feeGamma}`)
  console.log(`   allowed_extra_profit: ${POOL_CONFIG.allowedExtraProfit}`)
  console.log(`   adjustment_step     : ${POOL_CONFIG.adjustmentStep}`)
  console.log(
    `   ma_exp_time         : ${POOL_CONFIG.maExpTime}             (~10 min EMA half-life)`
  )
  console.log()
  console.log(` Price snapshot`)
  console.log(
    `   LDO/ETH (Chainlink)   : ${ldoEth.answer} (decimals ${ldoEth.decimals}, updatedAt ${ldoEth.updatedAt})`
  )
  console.log(
    `   stETH/ETH (Chainlink) : ${stEthEth.answer} (decimals ${stEthEth.decimals}, updatedAt ${stEthEth.updatedAt})`
  )
  console.log(
    `   stETH per wstETH      : ${stEthPerWstEth} (= ${
      Number(stEthPerWstEth) / 1e18
    } stETH/wstETH, on-chain)`
  )
  console.log(`   initial_price (1e18)  : ${initialPrice}`)
  console.log(`                         = ${Number(initialPrice) / 1e18} LDO per wstETH`)
  console.log()
  console.log(` Calldata (${(data.length - 2) / 2} bytes)`)
  console.log(`   ${data}`)
  console.log()
  console.log(` Files written:`)
  console.log(`   ./${safeTxPath}   -- drop into Safe Transaction Builder`)
  console.log('-------------------------------------------------------------')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
