import { ethers } from 'hardhat'
import { expect } from 'chai'
import { Contract, Signer, parseEther, ZeroAddress } from 'ethers'
import {
  impersonateAccount,
  setBalance,
  setCode,
  takeSnapshot,
  SnapshotRestorer,
} from '@nomicfoundation/hardhat-network-helpers'

import {
  StakingRevenueSource,
  StakingRevenueSource__factory,
  BuybackExecutor,
  BuybackExecutor__factory,
  BuybackAllocator,
  BuybackAllocator__factory,
  OracleRouter,
  IWstETH,
  IERC20,
  ILidoLocator,
  ITokenRateNotifier,
  Stonks,
} from '../../typechain-types'
import { getContracts } from '../../utils/contracts'
import { getTestOracleRouter, resetTestOracleRouter } from '../../utils/test-oracle-router'
import { deployLdoWstEthPool } from '../../utils/curve-twocrypto'
import { deployStonks } from '../../scripts/deployments/stonks'

const contracts = getContracts()

// Only stable anchor — everything Lido (notifier, stETH, staking router, rebase provider) is
// resolved off the canonical LidoLocator proxy, exactly as the contracts do.
const LIDO_LOCATOR = '0xC1d0b3DE6792Bf6b4b37EccdcC24e45978Cfd2Eb'
const PRICE_UNIT = 10n ** 18n
const FUND = parseEther('10000')
const WITH_ARGS = 1n // ObserverKind.WithArgs

// Stage the whole NEST chain on a mainnet fork and drive one rebase end to end:
//   handlePostTokenRebase -> StakingRevenueSource (pending stETH)
//     -> convertPendingRevenueToUSD (cumulative USD)
//       -> BuybackAllocator.allocate (stETH to executor)
//         -> BuybackExecutor.onStEthAllocated (stETH to Stonks)
//           -> placeOrder (CoW order) -> [settlement simulated] (LDO to executor)
//             -> addLiquidity (LDO + wstETH into the Curve pool) -> LP minted
//
// Every contract is real: the notifier resolved from the locator, a freshly deployed StakingRevenueSource,
// BuybackExecutor, BuybackAllocator, a real Stonks stETH->LDO, and a Curve LDO/wstETH TwoCrypto pool
// deployed via the mainnet Curve factory.
describe('NEST buyback — fork happy path (rebase -> Curve liquidity)', function () {
  let deployer: Signer
  let deployerAddr: string

  let oracleRouter: OracleRouter
  let stEthAddress: string
  let stEthErc20: IERC20
  let wsteth: IWstETH
  let wstethErc20: IERC20
  let ldo: IERC20

  let revenueSource: StakingRevenueSource
  let executor: BuybackExecutor
  let allocator: BuybackAllocator
  let stonks: Stonks
  let pool: Contract

  let notifier: ITokenRateNotifier
  let notifierOwner: Signer // owner, authorizes addObserver
  let rebaseProvider: Signer // TOKEN_RATE_PROVIDER, authorizes handlePostTokenRebase

  let topSnapshot: SnapshotRestorer

  const ALLOCATOR_FUNDING = parseEther('10')
  const WSTETH_SEED = parseEther('10')

  before(async function () {
    ;[deployer] = await ethers.getSigners()
    deployerAddr = await deployer.getAddress()

    const locator: ILidoLocator = await ethers.getContractAt('ILidoLocator', LIDO_LOCATOR)
    const notifierAddress = await locator.postTokenRebaseReceiver()

    topSnapshot = await takeSnapshot()

    stEthAddress = await locator.lido()
    stEthErc20 = await ethers.getContractAt('IERC20', stEthAddress)
    wsteth = await ethers.getContractAt('IWstETH', contracts.WSTETH)
    wstethErc20 = await ethers.getContractAt('IERC20', contracts.WSTETH)
    ldo = await ethers.getContractAt('IERC20', contracts.LDO)

    // Notifier: one instance; addObserver and handlePostTokenRebase are each .connect'd to their
    // authorized caller — owner() for the former, TOKEN_RATE_PROVIDER() for the latter.
    notifier = await ethers.getContractAt('ITokenRateNotifier', notifierAddress)
    const ownerAddress = await notifier.owner()
    const providerAddress = await notifier.TOKEN_RATE_PROVIDER()
    await impersonateAccount(ownerAddress)
    await impersonateAccount(providerAddress)
    await setBalance(ownerAddress, FUND)
    await setBalance(providerAddress, FUND)
    notifierOwner = await ethers.getSigner(ownerAddress)
    rebaseProvider = await ethers.getSigner(providerAddress)

    // One OracleRouter prices both legs (stETH for revenue/allocation, LDO for the pool/swap).
    oracleRouter = await getTestOracleRouter({ tokens: [stEthAddress, contracts.LDO] })
    const oracleRouterAddr = await oracleRouter.getAddress()

    // --- Curve LDO/wstETH pool: price it at the oracle so the seed and later deposits are balanced.
    const [ldoUsd, stEthUsd] = await oracleRouter.getUsdPrices(contracts.LDO, stEthAddress)
    const stEthPerWstEth = await wsteth.getStETHByWstETH(PRICE_UNIT)
    const wstEthUsd = (stEthUsd * stEthPerWstEth) / PRICE_UNIT
    const initialPrice = (wstEthUsd * PRICE_UNIT) / ldoUsd // LDO per wstETH, 1e18-scaled
    pool = await deployLdoWstEthPool(deployer, initialPrice)
    expect(await pool.coins(0)).to.equal(contracts.LDO)
    expect(await pool.coins(1)).to.equal(contracts.WSTETH)
    expect(await pool.price_oracle()).to.be.gt(0n)

    // Mint stETH (submit ETH), wrap a slice to wstETH for the seed, keep the rest for the allocator.
    const stEthForWstEth = await wsteth.getStETHByWstETH(WSTETH_SEED)
    const submitValue = stEthForWstEth + ALLOCATOR_FUNDING + parseEther('2')
    const lido = new ethers.Contract(
      stEthAddress,
      ['function submit(address) payable returns (uint256)'],
      deployer
    )
    await lido.submit(ZeroAddress, { value: submitValue })
    await stEthErc20.connect(deployer).approve(contracts.WSTETH, stEthForWstEth + 10n)
    await wsteth.connect(deployer).wrap(stEthForWstEth)
    const wstEthBalance = await wstethErc20.balanceOf(deployerAddr)
    expect(wstEthBalance).to.be.gt(0n)

    // LDO from the DAO agent, both for the seed and the simulated CoW fill later.
    await impersonateAccount(contracts.AGENT)
    await setBalance(contracts.AGENT, FUND)
    const agent = await ethers.getSigner(contracts.AGENT)
    const ldoSeed = (wstEthBalance * initialPrice) / PRICE_UNIT
    await ldo.connect(agent).transfer(deployerAddr, ldoSeed)

    // Seed the pool balanced at the initial price. TVL stays well under 1 USD MM, so the executor's
    // divergence gate runs in bootstrap mode (skipped) on the first deposit.
    await ldo.connect(deployer).approve(await pool.getAddress(), ldoSeed)
    await wstethErc20.connect(deployer).approve(await pool.getAddress(), wstEthBalance)
    await pool.add_liquidity([ldoSeed, wstEthBalance], 1n)
    expect(await pool.balances(0)).to.be.gt(0n)
    expect(await pool.balances(1)).to.be.gt(0n)

    // --- Revenue source.
    revenueSource = await new StakingRevenueSource__factory(deployer).deploy(
      oracleRouterAddr,
      LIDO_LOCATOR
    )
    await revenueSource.waitForDeployment()
    await notifier.connect(notifierOwner).addObserver(await revenueSource.getAddress(), WITH_ARGS)

    // --- Executor (pointing at the real pool). Caps are wide so accounting, not a cap, is observed.
    // poolBootstrapMinTvlUsd at the contract maximum keeps the shallow seeded pool in bootstrap mode.
    executor = await new BuybackExecutor__factory(deployer).deploy({
      admin: deployerAddr,
      treasury: contracts.AGENT,
      wstEth: contracts.WSTETH,
      ldo: contracts.LDO,
      oracleRouter: oracleRouterAddr,
      curvePoolAndToken: await pool.getAddress(),
      poolPriceDivergenceToleranceBps: 500,
      minAllowedOrderAmount: parseEther('0.01'),
      maxAllowedOrderAmount: parseEther('100000'),
      minDepositValueUsd: parseEther('1'),
      maxDepositValueUsd: parseEther('100000000'),
      poolBootstrapMinTvlUsd: parseEther('1000000'),
    })
    await executor.waitForDeployment()
    const executorAddr = await executor.getAddress()

    // --- Stonks stETH->LDO with manager and receiver = executor, so the executor drives it in LP mode.
    const { stonks: deployedStonks } = await deployStonks({
      factoryParams: {
        admin: contracts.ADMIN,
        agent: contracts.AGENT,
        relayer: contracts.VAULT_RELAYER,
        settlement: contracts.SETTLEMENT,
        priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        oracleRouterAddress: oracleRouterAddr,
      },
      stonksParams: {
        tokenFrom: stEthAddress,
        tokenTo: contracts.LDO,
        manager: executorAddr,
        marginInBps: 100,
        orderDuration: 300,
        priceToleranceInBps: 100,
        maxImprovementInBps: 100,
        allowPartialFill: false,
        receiver: executorAddr,
      },
      amountConverterParams: {
        oracleRouter: oracleRouterAddr,
        allowedTokensToSell: [stEthAddress],
        allowedTokensToBuy: [contracts.LDO],
        useEthAnchor: false,
      },
      skipRouterConfiguration: true,
    })
    stonks = deployedStonks
    await executor.setStonksAndOperatingMode(await stonks.getAddress())
    expect(await executor.lpModeEnabled()).to.equal(true)

    // --- Allocator wired to the source and the executor; grant it the executor's allocator role.
    allocator = await new BuybackAllocator__factory(deployer).deploy({
      admin: deployerAddr,
      treasury: deployerAddr,
      stEth: stEthAddress,
      oracleRouter: oracleRouterAddr,
      executor: executorAddr,
      dailyCapUSD: parseEther('1000000'),
      yearlyCapUSD: parseEther('10000000'),
      reserveDailyRateUSD: 0n,
      minStEthPriceUSD: 0n,
      minSpendPerCallUSD: parseEther('1'),
      surplusShareBP: 5000n,
      revenueSources: [await revenueSource.getAddress()],
    })
    await allocator.waitForDeployment()
    await executor.grantRole(await executor.ALLOCATOR_ROLE(), await allocator.getAddress())
    await allocator.activate()

    // Fund the allocator with the kept stETH so it has something to forward.
    await stEthErc20.connect(deployer).transfer(await allocator.getAddress(), ALLOCATOR_FUNDING)
  })

  after(async function () {
    if (topSnapshot) await topSnapshot.restore()
    resetTestOracleRouter()
  })

  it('drives a rebase end to end into Curve LP tokens', async function () {
    const executorAddr = await executor.getAddress()

    // 1) Rebase -> pending stETH on the source.
    const reportTs = BigInt(Math.floor(Date.now() / 1000)) + 1n
    await notifier
      .connect(rebaseProvider)
      .handlePostTokenRebase(reportTs, 1n, 1n, 1n, 1n, 1n, parseEther('1000000'))
    const pending = await revenueSource.pendingRevenueStEth()
    expect(pending).to.be.gt(0n)

    // 2) Convert -> cumulative USD.
    await revenueSource.convertPendingRevenueToUSD()
    const cumulativeUSD = await revenueSource.getCumulativeRevenueUSD()
    expect(cumulativeUSD).to.be.gt(0n)

    // 3) Allocate -> stETH leaves the allocator; onStEthAllocated forwards half to Stonks.
    const stonksAddr = await stonks.getAddress()
    await allocator.allocate()
    const executorStEthAfterAllocate = await stEthErc20.balanceOf(executorAddr)
    const stonksStEth = await stEthErc20.balanceOf(stonksAddr)
    expect(executorStEthAfterAllocate).to.be.gt(0n) // kept half for the LP leg
    expect(stonksStEth).to.be.gt(0n) // sell half forwarded to Stonks

    // 4) placeOrder -> a CoW order holding the sell-side stETH.
    const placeRcpt = (await (await executor.placeOrder()).wait())!
    const [placed] = await executor.queryFilter(
      executor.filters.OrderPlaced(),
      placeRcpt.blockNumber,
      placeRcpt.blockNumber
    )
    expect(placed, 'OrderPlaced not emitted').to.not.equal(undefined)
    const orderAddress = placed.args.order
    const minBuyAmount = placed.args.minBuyAmount
    const orderStEth = await stEthErc20.balanceOf(orderAddress)
    expect(orderStEth).to.be.gt(0n)

    // 5) Simulate CoW settlement: relayer pulls the order's stETH, the buy-side LDO is delivered to
    //    the order receiver (the executor, in LP mode).
    await setCode(contracts.VAULT_RELAYER, ethers.ZeroHash)
    await setBalance(contracts.VAULT_RELAYER, parseEther('100'))
    await impersonateAccount(contracts.VAULT_RELAYER)
    const relayer = await ethers.getSigner(contracts.VAULT_RELAYER)
    await stEthErc20
      .connect(relayer)
      .transferFrom(orderAddress, contracts.VAULT_RELAYER, orderStEth)
    const agent = await ethers.getSigner(contracts.AGENT)
    await ldo.connect(agent).transfer(executorAddr, minBuyAmount)
    expect(await ldo.balanceOf(executorAddr)).to.be.gte(minBuyAmount)

    // 6) addLiquidity -> LDO + wrapped stETH deposited into the Curve pool, LP minted to the executor.
    const lpBefore = await executor.getLpTokenBalance()
    await expect(executor.addLiquidity()).to.emit(executor, 'LiquidityAdded')
    const lpAfter = await executor.getLpTokenBalance()
    expect(lpAfter).to.be.gt(lpBefore)
    expect(await pool.balanceOf(executorAddr)).to.equal(lpAfter)
  })
})
