import { ethers, network } from 'hardhat'
import { readFileSync } from 'node:fs'

import fmt from '../utils/format'
import { getContracts } from '../utils/contracts'

const DEPLOY_POOL_ABI = [
  'function deploy_pool(string _name, string _symbol, address[2] _coins, uint256 implementation_id, uint256 A, uint256 gamma, uint256 mid_fee, uint256 out_fee, uint256 fee_gamma, uint256 allowed_extra_profit, uint256 adjustment_step, uint256 ma_exp_time, uint256 initial_price) returns (address)',
] as const

const DEPLOY_POOL_IFACE = new ethers.Interface(DEPLOY_POOL_ABI)
const DEPLOY_POOL_SELECTOR = DEPLOY_POOL_IFACE.getFunction('deploy_pool')!.selector

type Tx = { to: string; value: string; data: string }

function loadTx(): { tx: Tx; source: string } {
  const envTo = process.env.TO
  const envData = process.env.DATA

  if (envTo || envData) {
    if (!envTo || !envData) {
      throw new Error('TO and DATA must both be set when overriding via env vars')
    }
    return {
      tx: { to: envTo, value: process.env.VALUE ?? '0', data: envData },
      source: 'env vars TO/VALUE/DATA',
    }
  }

  const path = process.env.SAFE_TX_PATH ?? 'curve-pool-deploy-safe-tx.json'
  const json = JSON.parse(readFileSync(path, 'utf8')) as {
    transactions?: Array<Tx>
  }
  if (!json.transactions || json.transactions.length !== 1) {
    throw new Error(`expected exactly 1 tx in ${path}, got ${json.transactions?.length ?? 0}`)
  }
  return { tx: json.transactions[0], source: path }
}

async function main() {
  const contracts = getContracts()
  const { tx, source } = loadTx()

  // Envelope checks
  const expectedFactory = contracts.CURVE_TWOCRYPTO_NG_FACTORY
  if (expectedFactory === ethers.ZeroAddress) {
    throw new Error(
      `Curve TwoCrypto-NG factory address is not set for network "${network.name}" - cannot validate`
    )
  }
  const toMatches = tx.to.toLowerCase() === expectedFactory.toLowerCase()
  const valueIsZero = tx.value === '0'
  const selectorMatches = tx.data.slice(0, 10).toLowerCase() === DEPLOY_POOL_SELECTOR.toLowerCase()

  console.log('-------------------------------------------------------------')
  console.log(' Curve TwoCrypto-NG deploy_pool calldata -- decoded')
  console.log('-------------------------------------------------------------')
  console.log(` Network              : ${fmt.network(network.name)}`)
  console.log(` Source               : ${source}`)
  console.log()

  console.log(` Tx envelope`)
  console.log(
    `   to                 : ${fmt.address(tx.to)} ${
      toMatches ? '[OK - matches factory]' : `[!! MISMATCH - expected ${expectedFactory}]`
    }`
  )
  console.log(`   value              : ${tx.value} ${valueIsZero ? '[OK]' : '[!! non-zero value]'}`)
  console.log(
    `   selector           : ${tx.data.slice(0, 10)} ${
      selectorMatches ? '[OK - deploy_pool]' : '[!! NOT deploy_pool]'
    }`
  )
  console.log(`   calldata size      : ${(tx.data.length - 2) / 2} bytes`)
  console.log()

  // Decoding assumes deploy_pool's argument layout; a mismatched selector would
  // make ethers throw a cryptic ABI error instead of our envelope diagnostics.
  if (!selectorMatches) {
    console.log('-------------------------------------------------------------')
    throw new Error('selector does not match deploy_pool - cannot decode calldata; see [!!] above')
  }

  const decoded = DEPLOY_POOL_IFACE.decodeFunctionData('deploy_pool', tx.data)
  const decName = decoded[0] as string
  const decSymbol = decoded[1] as string
  const decCoins = decoded[2] as readonly [string, string]
  const implementationId = decoded[3] as bigint
  const A = decoded[4] as bigint
  const gamma = decoded[5] as bigint
  const midFee = decoded[6] as bigint
  const outFee = decoded[7] as bigint
  const feeGamma = decoded[8] as bigint
  const allowedExtraProfit = decoded[9] as bigint
  const adjustmentStep = decoded[10] as bigint
  const maExpTime = decoded[11] as bigint
  const initialPrice = decoded[12] as bigint

  // Fees in Curve are scaled by MAX_FEE = 1e10. 1 bps = 1e-4 = 1e6 in this scale.
  const midFeeBps = Number(midFee) / 1e6
  const outFeeBps = Number(outFee) / 1e6
  const halfLifeMinutes = (Number(maExpTime) * Math.LN2) / 60
  const ldoPerWstEth = Number(initialPrice / 10n ** 15n) / 1000 // avoid Number-precision loss

  console.log(` Decoded params`)
  console.log(`   _name               : ${decName}`)
  console.log(`   _symbol             : ${decSymbol}`)
  console.log(`   _coins[0]           : ${fmt.address(decCoins[0])}`)
  console.log(`   _coins[1]           : ${fmt.address(decCoins[1])}`)
  console.log(`   implementation_id   : ${implementationId}`)
  console.log(`   A                   : ${A}`)
  console.log(`   gamma               : ${gamma}`)
  console.log(`   mid_fee             : ${midFee}        (${midFeeBps} bps)`)
  console.log(`   out_fee             : ${outFee}      (${outFeeBps} bps)`)
  console.log(`   fee_gamma           : ${feeGamma}`)
  console.log(`   allowed_extra_profit: ${allowedExtraProfit}`)
  console.log(`   adjustment_step     : ${adjustmentStep}`)
  console.log(
    `   ma_exp_time         : ${maExpTime}            (~${halfLifeMinutes.toFixed(
      1
    )} min EMA half-life)`
  )
  console.log(`   initial_price       : ${initialPrice}`)
  console.log(`                       = ~${ldoPerWstEth} LDO per wstETH`)
  console.log()

  if (!toMatches || !valueIsZero) {
    console.log('-------------------------------------------------------------')
    throw new Error('one or more envelope checks failed - see [!!] markers above')
  }

  console.log('-------------------------------------------------------------')
  console.log(' Please cross-check the params above against the configuration before signing')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
