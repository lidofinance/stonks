import { assert } from 'chai'
import { ethers, network } from 'hardhat'

import fmt from '../utils/format'
import { confirmOrAbort } from '../utils/prompt'
import { getDeployer, saveDeployment, verify, waitForDeployment } from '../utils/deployment'
import { BuybackExecutor__factory } from '../typechain-types'
import { BuybackExecutor } from '../typechain-types/contracts/automated-buybacks/BuybackExecutor'

const ADMIN = '0x2e59A20f205bB85a89C53f1936454680651E618e' // Aragon Voting
const TREASURY = '0x3e40D73EB977Dc6a537aF587D48316feE66E9C8c' // Aragon Agent
const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0'
const LDO = '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32'
// OracleRouter from Stonks v2 deploy
const ORACLE_ROUTER = '0x79ef3a538200Fe4981D67E7e886bfb36D4Cb5a31'
// Pre-existing Curve LDO/wstETH TwoCrypto-NG pool (also the LP token)
const CURVE_POOL_AND_TOKEN = '0xD7f1dA0a28E39dd0dB70E6Acdc2B49846AD22760'

// Max pool-EMA vs oracle divergence, in (0, 1000]
const POOL_PRICE_DIVERGENCE_TOLERANCE_BPS = 200n // 2%
// stETH order bounds. minAllowedOrderAmount in (0, maxAllowedOrderAmount)
const MIN_ALLOWED_ORDER_AMOUNT = ethers.parseEther('1') // 1 stETH
const MAX_ALLOWED_ORDER_AMOUNT = ethers.parseEther('3') // 3 stETH
// Per-call deposit value bounds, in 1e18-scaled USD. minDepositValueUsd in (0, maxDepositValueUsd)
const MIN_DEPOSIT_VALUE_USD = ethers.parseEther('1000') // $1,000
const MAX_DEPOSIT_VALUE_USD = ethers.parseEther('50000') // $50,000
// Pool TVL (1e18-scaled USD) at/above which the divergence gate is enforced, in (0, 1_000_000e18]
const POOL_BOOTSTRAP_MIN_TVL_USD = ethers.parseEther('250000') // $250,000

assert(ethers.isAddress(ADMIN), 'ADMIN is not a valid address')
assert(ethers.isAddress(TREASURY), 'TREASURY is not a valid address')
assert(ethers.isAddress(WSTETH), 'WSTETH is not a valid address')
assert(ethers.isAddress(LDO), 'LDO is not a valid address')
assert(ethers.isAddress(ORACLE_ROUTER), 'ORACLE_ROUTER is not a valid address')
assert(ethers.isAddress(CURVE_POOL_AND_TOKEN), 'CURVE_POOL_AND_TOKEN is not a valid address')
assert(
  POOL_PRICE_DIVERGENCE_TOLERANCE_BPS > 0n && POOL_PRICE_DIVERGENCE_TOLERANCE_BPS <= 1000n,
  'POOL_PRICE_DIVERGENCE_TOLERANCE_BPS must be in (0, 1000]'
)
assert(
  MIN_ALLOWED_ORDER_AMOUNT > 0n && MIN_ALLOWED_ORDER_AMOUNT < MAX_ALLOWED_ORDER_AMOUNT,
  'MIN_ALLOWED_ORDER_AMOUNT must be in (0, MAX_ALLOWED_ORDER_AMOUNT)'
)
assert(
  MIN_DEPOSIT_VALUE_USD > 0n && MIN_DEPOSIT_VALUE_USD < MAX_DEPOSIT_VALUE_USD,
  'MIN_DEPOSIT_VALUE_USD must be in (0, MAX_DEPOSIT_VALUE_USD)'
)
assert(
  POOL_BOOTSTRAP_MIN_TVL_USD > 0n && POOL_BOOTSTRAP_MIN_TVL_USD <= ethers.parseEther('1000000'),
  'POOL_BOOTSTRAP_MIN_TVL_USD must be in (0, 1_000_000e18]'
)

const initParams: BuybackExecutor.InitParamsStruct = {
  admin: ADMIN,
  treasury: TREASURY,
  wstEth: WSTETH,
  ldo: LDO,
  oracleRouter: ORACLE_ROUTER,
  curvePoolAndToken: CURVE_POOL_AND_TOKEN,
  poolPriceDivergenceToleranceBps: POOL_PRICE_DIVERGENCE_TOLERANCE_BPS,
  minAllowedOrderAmount: MIN_ALLOWED_ORDER_AMOUNT,
  maxAllowedOrderAmount: MAX_ALLOWED_ORDER_AMOUNT,
  minDepositValueUsd: MIN_DEPOSIT_VALUE_USD,
  maxDepositValueUsd: MAX_DEPOSIT_VALUE_USD,
  poolBootstrapMinTvlUsd: POOL_BOOTSTRAP_MIN_TVL_USD,
}

async function main() {
  // prettier-ignore
  console.log(
    `Preparing for ${fmt.name('BuybackExecutor')} deployment on "${fmt.network(network.name)}" network...\n`
  )

  const deployer = await getDeployer()

  console.log(`Deployment parameters:`)
  console.log(`  * ${fmt.name('Admin')} address: ${fmt.value(ADMIN)}`)
  console.log(`  * ${fmt.name('Treasury')} address: ${fmt.value(TREASURY)}`)
  console.log(`  * ${fmt.name('wstETH')} address: ${fmt.value(WSTETH)}`)
  console.log(`  * ${fmt.name('LDO')} address: ${fmt.value(LDO)}`)
  console.log(`  * ${fmt.name('OracleRouter')} address: ${fmt.value(ORACLE_ROUTER)}`)
  console.log(`  * ${fmt.name('CurvePoolAndToken')} address: ${fmt.value(CURVE_POOL_AND_TOKEN)}`)
  console.log(
    `  * pool price divergence tolerance (bps): ${fmt.value(POOL_PRICE_DIVERGENCE_TOLERANCE_BPS)}`
  )
  console.log(`  * min allowed order amount (stETH wei): ${fmt.value(MIN_ALLOWED_ORDER_AMOUNT)}`)
  console.log(`  * max allowed order amount (stETH wei): ${fmt.value(MAX_ALLOWED_ORDER_AMOUNT)}`)
  console.log(`  * min deposit value (1e18 USD): ${fmt.value(MIN_DEPOSIT_VALUE_USD)}`)
  console.log(`  * max deposit value (1e18 USD): ${fmt.value(MAX_DEPOSIT_VALUE_USD)}`)
  console.log(`  * pool bootstrap min TVL (1e18 USD): ${fmt.value(POOL_BOOTSTRAP_MIN_TVL_USD)}`)
  console.log()

  await confirmOrAbort('Proceed?')

  const buybackExecutor = await new BuybackExecutor__factory(deployer).deploy(initParams)

  const receipt = await waitForDeployment(buybackExecutor.deploymentTransaction()!)
  const buybackExecutorAddress = await buybackExecutor.getAddress()

  // prettier-ignore
  console.log(
    `The ${fmt.name('BuybackExecutor')} contract was deployed successfully: ${fmt.address(buybackExecutorAddress)}\n`
  )

  saveDeployment('buybackExecutor', {
    contract: 'contracts/automated-buybacks/BuybackExecutor.sol',
    address: buybackExecutorAddress,
    deployTx: receipt.hash,
    constructorArgs: [initParams],
  })

  if (!['localhost', 'hardhat'].includes(network.name)) {
    await verify(buybackExecutorAddress, [initParams], receipt)
  } else {
    console.log(`Deployed on the local hardhat network, verification is skipped.`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
