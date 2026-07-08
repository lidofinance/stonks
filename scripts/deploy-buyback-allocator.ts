import { assert } from 'chai'
import { ethers, network } from 'hardhat'

import fmt from '../utils/format'
import { confirmOrAbort } from '../utils/prompt'
import { getDeployer, saveDeployment, verify, waitForDeployment } from '../utils/deployment'
import { BuybackAllocator__factory } from '../typechain-types'
import { BuybackAllocator } from '../typechain-types/contracts/automated-buybacks/BuybackAllocator'

const ADMIN = '0x2e59A20f205bB85a89C53f1936454680651E618e' // Aragon Voting
const TREASURY = '0x3e40D73EB977Dc6a537aF587D48316feE66E9C8c' // Aragon Agent
const STETH = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84'
// OracleRouter from Stonks v2 deploy
const ORACLE_ROUTER = '0x79ef3a538200Fe4981D67E7e886bfb36D4Cb5a31'
// Receives allocations: the deployed BuybackExecutor
const EXECUTOR = '' // TODO

// USD limits are 1e18-scaled. Make sure that values below are consistent to deploy plan
const DAILY_CAP_USD = ethers.parseEther('50000') // $50,000
const YEARLY_CAP_USD = ethers.parseEther('10000000') // $10,000,000
const RESERVE_DAILY_RATE_USD = ethers.parseEther('109589') // ~$109,589/day, TODO: confirm exact figure
const SURPLUS_SHARE_BP = 5000n // 50%
// Governance lever: 0 disables the stETH price floor
const MIN_STETH_PRICE_USD = 0n
// Dust floor per allocation
const MIN_SPEND_PER_CALL_USD = 0n

const STAKING_REVENUE_SOURCE = '' // TODO
// Sources registered at deployment. NEST launches with StakingRevenueSource as the only source
const REVENUE_SOURCES: string[] = [STAKING_REVENUE_SOURCE]

assert(ethers.isAddress(ADMIN), 'ADMIN is not a valid address')
assert(ethers.isAddress(TREASURY), 'TREASURY is not a valid address')
assert(ethers.isAddress(STETH), 'STETH is not a valid address')
assert(ethers.isAddress(ORACLE_ROUTER), 'ORACLE_ROUTER is not a valid address')
assert(ethers.isAddress(EXECUTOR), 'EXECUTOR is not a valid address')
assert(DAILY_CAP_USD > 0n, 'DAILY_CAP_USD must be > 0')
assert(YEARLY_CAP_USD >= DAILY_CAP_USD, 'YEARLY_CAP_USD must be >= DAILY_CAP_USD')
assert(
  SURPLUS_SHARE_BP > 0n && SURPLUS_SHARE_BP <= 10000n,
  'SURPLUS_SHARE_BP must be in (0, 10000]'
)
assert(
  MIN_SPEND_PER_CALL_USD > 0n && MIN_SPEND_PER_CALL_USD <= DAILY_CAP_USD,
  'MIN_SPEND_PER_CALL_USD must be in (0, DAILY_CAP_USD]'
)
assert(REVENUE_SOURCES.length > 0, 'REVENUE_SOURCES is empty')
assert(REVENUE_SOURCES.length <= 50, 'REVENUE_SOURCES exceeds MAX_REVENUE_SOURCES (50)')
REVENUE_SOURCES.forEach((source) =>
  assert(ethers.isAddress(source), `Revenue source ${source} is not a valid address`)
)

const initParams: BuybackAllocator.ConstructorParamsStruct = {
  admin: ADMIN,
  treasury: TREASURY,
  stEth: STETH,
  oracleRouter: ORACLE_ROUTER,
  executor: EXECUTOR,
  dailyCapUSD: DAILY_CAP_USD,
  yearlyCapUSD: YEARLY_CAP_USD,
  reserveDailyRateUSD: RESERVE_DAILY_RATE_USD,
  minStEthPriceUSD: MIN_STETH_PRICE_USD,
  minSpendPerCallUSD: MIN_SPEND_PER_CALL_USD,
  surplusShareBP: SURPLUS_SHARE_BP,
  revenueSources: REVENUE_SOURCES,
}

async function main() {
  // prettier-ignore
  console.log(
    `Preparing for ${fmt.name('BuybackAllocator')} deployment on "${fmt.network(network.name)}" network...\n`
  )

  const deployer = await getDeployer()

  console.log(`Deployment parameters:`)
  console.log(`  * ${fmt.name('Admin')} address: ${fmt.value(ADMIN)}`)
  console.log(`  * ${fmt.name('Treasury')} address: ${fmt.value(TREASURY)}`)
  console.log(`  * ${fmt.name('stETH')} address: ${fmt.value(STETH)}`)
  console.log(`  * ${fmt.name('OracleRouter')} address: ${fmt.value(ORACLE_ROUTER)}`)
  console.log(`  * ${fmt.name('Executor')} address: ${fmt.value(EXECUTOR)}`)
  console.log(`  * daily cap (1e18 USD): ${fmt.value(DAILY_CAP_USD)}`)
  console.log(`  * yearly cap (1e18 USD): ${fmt.value(YEARLY_CAP_USD)}`)
  console.log(`  * reserve daily rate (1e18 USD): ${fmt.value(RESERVE_DAILY_RATE_USD)}`)
  console.log(`  * min stETH price (1e18 USD): ${fmt.value(MIN_STETH_PRICE_USD)}`)
  console.log(`  * min spend per call (1e18 USD): ${fmt.value(MIN_SPEND_PER_CALL_USD)}`)
  console.log(`  * surplus share (bps): ${fmt.value(SURPLUS_SHARE_BP)}`)
  console.log(`  * revenue sources: ${fmt.value('[' + REVENUE_SOURCES.join(', ') + ']')}`)
  console.log()

  await confirmOrAbort('Proceed?')

  const buybackAllocator = await new BuybackAllocator__factory(deployer).deploy(initParams)

  const receipt = await waitForDeployment(buybackAllocator.deploymentTransaction()!)
  const buybackAllocatorAddress = await buybackAllocator.getAddress()

  // prettier-ignore
  console.log(
    `The ${fmt.name('BuybackAllocator')} contract was deployed successfully: ${fmt.address(buybackAllocatorAddress)}\n`
  )

  saveDeployment('buybackAllocator', {
    contract: 'contracts/automated-buybacks/BuybackAllocator.sol',
    address: buybackAllocatorAddress,
    deployTx: receipt.hash,
    constructorArgs: [initParams],
  })

  if (!['localhost', 'hardhat'].includes(network.name)) {
    await verify(buybackAllocatorAddress, [initParams], receipt)
  } else {
    console.log(`Deployed on the local hardhat network, verification is skipped.`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
