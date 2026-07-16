import { ethers } from 'hardhat'
import { expect } from 'chai'
import { getContracts } from '../../utils/contracts'
import { CURVE_POOL_ABI } from '../../utils/curve-twocrypto'
import { ALLOCATOR_ROLE, EMERGENCY_ROLE, MANAGER_ROLE } from '../helpers/buyback-executor'
import { ORACLE_ROUTER_ADDRESS } from '../helpers/buyback-scenario'

// Fill these from the deployment under review before running. An empty executor address skips the
// whole suite; the other fields are guarded so a half-filled template fails loudly.
const BUYBACK_EXECUTOR_ADDRESS: string = ''
const CURVE_POOL_AND_TOKEN_ADDRESS: string = ''
const STONKS_ADDRESS: string = ''

// Operational roles are granted by the admin after construction, not in the constructor. Fill the
// holders the deployment grants them to; the constructor only grants DEFAULT_ADMIN_ROLE.
const ALLOCATOR_HOLDER: string = ''
const EMERGENCY_HOLDER: string = ''
const MANAGER_HOLDER: string = ''

// Configurable bounds as deployed. All are non-zero by construction.
const EXPECTED_POOL_PRICE_DIVERGENCE_TOLERANCE_BPS: bigint = 0n
const EXPECTED_MIN_ALLOWED_ORDER_AMOUNT: bigint = 0n
const EXPECTED_MAX_ALLOWED_ORDER_AMOUNT: bigint = 0n
const EXPECTED_MIN_DEPOSIT_VALUE_USD: bigint = 0n
const EXPECTED_MAX_DEPOSIT_VALUE_USD: bigint = 0n
const EXPECTED_POOL_BOOTSTRAP_MIN_TVL_USD: bigint = 0n

const getExecutor = () => ethers.getContractAt('BuybackExecutor', BUYBACK_EXECUTOR_ADDRESS)

describe('BuybackExecutor: acceptance', function () {
  it('should wire the deployed executor to the expected wstETH, stETH, LDO, oracle, Curve pool, Stonks, and treasury', async function () {
    if (BUYBACK_EXECUTOR_ADDRESS === '') this.skip()

    expect(CURVE_POOL_AND_TOKEN_ADDRESS).to.not.equal('')
    expect(STONKS_ADDRESS).to.not.equal('')

    const contracts = getContracts()
    const executor = await getExecutor()

    expect(await executor.WSTETH()).to.hexEqual(contracts.WSTETH)
    expect(await executor.STETH()).to.hexEqual(contracts.STETH)
    expect(await executor.LDO()).to.hexEqual(contracts.LDO)
    expect(await executor.ORACLE_ROUTER()).to.hexEqual(ORACLE_ROUTER_ADDRESS)
    expect(await executor.CURVE_POOL_AND_TOKEN()).to.hexEqual(CURVE_POOL_AND_TOKEN_ADDRESS)
    expect(await executor.stonks()).to.hexEqual(STONKS_ADDRESS)
    expect(await executor.TREASURY()).to.hexEqual(contracts.AGENT)

    // PRICE_UNIT is cached from the oracle's PRICE_UNIT at construction.
    const oracle = await ethers.getContractAt('IOracleRouter', ORACLE_ROUTER_ADDRESS)
    expect(await executor.PRICE_UNIT()).to.equal(await oracle.PRICE_UNIT())
  })

  it('should hold the expected divergence-tolerance, order-amount, deposit-value, and bootstrap-TVL bounds', async function () {
    if (BUYBACK_EXECUTOR_ADDRESS === '') this.skip()

    expect(EXPECTED_POOL_PRICE_DIVERGENCE_TOLERANCE_BPS).to.not.equal(0n)
    expect(EXPECTED_MIN_ALLOWED_ORDER_AMOUNT).to.not.equal(0n)
    expect(EXPECTED_MAX_ALLOWED_ORDER_AMOUNT).to.not.equal(0n)
    expect(EXPECTED_MIN_DEPOSIT_VALUE_USD).to.not.equal(0n)
    expect(EXPECTED_MAX_DEPOSIT_VALUE_USD).to.not.equal(0n)
    expect(EXPECTED_POOL_BOOTSTRAP_MIN_TVL_USD).to.not.equal(0n)

    const executor = await getExecutor()

    expect(await executor.poolPriceDivergenceToleranceBps()).to.equal(
      EXPECTED_POOL_PRICE_DIVERGENCE_TOLERANCE_BPS
    )
    expect(await executor.minAllowedOrderAmount()).to.equal(EXPECTED_MIN_ALLOWED_ORDER_AMOUNT)
    expect(await executor.maxAllowedOrderAmount()).to.equal(EXPECTED_MAX_ALLOWED_ORDER_AMOUNT)
    expect(await executor.minDepositValueUsd()).to.equal(EXPECTED_MIN_DEPOSIT_VALUE_USD)
    expect(await executor.maxDepositValueUsd()).to.equal(EXPECTED_MAX_DEPOSIT_VALUE_USD)
    expect(await executor.poolBootstrapMinTvlUsd()).to.equal(EXPECTED_POOL_BOOTSTRAP_MIN_TVL_USD)
  })

  it('should grant ALLOCATOR_ROLE, EMERGENCY_ROLE, and MANAGER_ROLE to the expected holders', async function () {
    if (BUYBACK_EXECUTOR_ADDRESS === '') this.skip()

    expect(ALLOCATOR_HOLDER).to.not.equal('')
    expect(EMERGENCY_HOLDER).to.not.equal('')
    expect(MANAGER_HOLDER).to.not.equal('')

    const executor = await getExecutor()

    expect(await executor.hasRole(ALLOCATOR_ROLE, ALLOCATOR_HOLDER)).to.equal(true)
    expect(await executor.hasRole(EMERGENCY_ROLE, EMERGENCY_HOLDER)).to.equal(true)
    expect(await executor.hasRole(MANAGER_ROLE, MANAGER_HOLDER)).to.equal(true)
  })

  it('should report the operating mode consistent with the deployed Stonks receiver', async function () {
    if (BUYBACK_EXECUTOR_ADDRESS === '') this.skip()

    expect(STONKS_ADDRESS).to.not.equal('')

    const executor = await getExecutor()
    const stonks = await ethers.getContractAt('IStonks', STONKS_ADDRESS)

    // LP mode is enabled when the Stonks routes settlement back to the executor.
    const receiver = await stonks.RECEIVER()
    const expectedLpMode =
      ethers.getAddress(receiver) === ethers.getAddress(BUYBACK_EXECUTOR_ADDRESS)
    expect(await executor.lpModeEnabled()).to.equal(expectedLpMode)
  })

  it('should be the manager of the deployed Stonks', async function () {
    if (BUYBACK_EXECUTOR_ADDRESS === '') this.skip()

    expect(STONKS_ADDRESS).to.not.equal('')

    const stonksOwnable = await ethers.getContractAt('IOwnable', STONKS_ADDRESS)
    expect(await stonksOwnable.manager()).to.hexEqual(BUYBACK_EXECUTOR_ADDRESS)
  })

  it('should stage the Curve pool empty for the LP bootstrap deposit', async function () {
    if (BUYBACK_EXECUTOR_ADDRESS === '') this.skip()

    expect(CURVE_POOL_AND_TOKEN_ADDRESS).to.not.equal('')

    // Launch-window precondition: the pool ships unseeded so the executor's first deposit
    // bootstraps its EMA. Drop this check once the bootstrap deposit has run on-chain.
    const curvePool = new ethers.Contract(
      CURVE_POOL_AND_TOKEN_ADDRESS,
      CURVE_POOL_ABI,
      ethers.provider
    )
    expect(await curvePool.totalSupply()).to.equal(0n)
    expect(await curvePool.balances(0)).to.equal(0n)
    expect(await curvePool.balances(1)).to.equal(0n)
  })
})
