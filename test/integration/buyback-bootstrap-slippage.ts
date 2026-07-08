import { ethers } from 'hardhat'
import { expect } from 'chai'
import { Signer, parseEther, ZeroAddress } from 'ethers'
import {
  impersonateAccount,
  setBalance,
  takeSnapshot,
  time,
  SnapshotRestorer,
} from '@nomicfoundation/hardhat-network-helpers'

import {
  BuybackExecutor,
  BuybackExecutor__factory,
  OracleRouter,
  IWstETH,
  IERC20,
  ILidoLocator,
  ITwocryptoNGPool,
  Stonks,
} from '../../typechain-types'
import { getContracts } from '../../utils/contracts'
import { getTestOracleRouter, resetTestOracleRouter } from '../../utils/test-oracle-router'
import { deployLdoWstEthPool } from '../../utils/curve-twocrypto'
import { deployStonks } from '../../scripts/deployments/stonks'

const contracts = getContracts()

const LIDO_LOCATOR = '0xC1d0b3DE6792Bf6b4b37EccdcC24e45978Cfd2Eb'
const PRICE_UNIT = 10n ** 18n
const FUND = parseEther('10000')

const LDO_INDEX = 0n
const WSTETH_INDEX = 1n

// Executor config: caps wide so accounting (not a cap) is what the tests observe.
const TOLERANCE_BPS = 500n
const BOOTSTRAP_MIN_TVL_USD = parseEther('1000000') // shallow pool stays in bootstrap (gate bypassed)
const GATE_ACTIVE_MIN_TVL_USD = parseEther('1') // below any seeded TVL => divergence gate enforced

// Per-side size of the executor's deposit (~$5k each leg, ~$10k total — Lido's planned batch size).
const DEPOSIT_WST_PER_SIDE = parseEther('0.7')

// The realized loss a balanced deposit into an unmanipulated pool may take (Curve imbalance fee only).
// A balanced-at-oracle deposit into a fair pool has ~zero imbalance, so the honest fee is sub-bp.
const HONEST_LOSS_TOLERANCE_BPS = 10n // 0.1%

// How far the pool's marginal spot may sit from the oracle after a deposit and still count as aligned.
const SPOT_ALIGNMENT_TOLERANCE_BPS = 100n // 1%

/**
 * Locks in the security property the team relies on to keep the bootstrap-phase design as-is:
 *
 *   The BuybackExecutor's deposit is unprotected on the Curve side during bootstrap
 *   (`min_mint = 1`, divergence gate bypassed while TVL < poolBootstrapMinTvlUsd), yet it cannot be
 *   drained through slippage, because `_computeBalancedAmounts` sizes the deposit at the *oracle*
 *   price. Depositing at the true price is never worse than neutral: into a manipulated pool it is
 *   corrective (the executor arbitrages the skew in its own favour), so an attacker who moves the
 *   pool only pays the executor.
 */
describe('BuybackExecutor — bootstrap-phase deposit robustness', function () {
  let deployer: Signer
  let deployerAddr: string
  let attacker: Signer
  let attackerAddr: string
  let agent: Signer

  let oracleRouter: OracleRouter
  let oracleRouterAddr: string
  let stEthAddress: string
  let stEthErc20: IERC20
  let wsteth: IWstETH
  let wstethErc20: IERC20
  let ldo: IERC20

  let ldoUsd: bigint
  let stEthUsd: bigint
  let fairPrice: bigint // fair LDO per wstETH, 1e18-scaled (equals the oracle-implied ratio)

  // Shared fixture: one empty pool at the fair price + one executor (bootstrap mode) wired to it.
  let pool: ITwocryptoNGPool
  let executor: BuybackExecutor
  let executorAddr: string

  let baseSnapshot: SnapshotRestorer
  let snapshot: SnapshotRestorer

  /*//////////////////////////////////////////////////////////////
                        ORACLE-PRICED VALUATION
  //////////////////////////////////////////////////////////////*/

  const usdOfLdo = (a: bigint) => (a * ldoUsd) / PRICE_UNIT
  const usdOfStEth = (a: bigint) => (a * stEthUsd) / PRICE_UNIT
  const usdOfWstEth = async (a: bigint) => usdOfStEth(await wsteth.getStETHByWstETH(a))

  // Pool net asset value at the oracle, read from internal `balances` (donation-resistant).
  async function poolNavUsd(p: ITwocryptoNGPool): Promise<bigint> {
    return usdOfLdo(await p.balances(LDO_INDEX)) + (await usdOfWstEth(await p.balances(WSTETH_INDEX)))
  }

  // Oracle value of an address's whole position on a pool: its LP share (at oracle NAV) plus any
  // leftover LDO / stETH it still holds.
  async function positionUsd(holder: string, p: ITwocryptoNGPool): Promise<bigint> {
    const lp = await p.balanceOf(holder)
    const supply = await p.totalSupply()
    const lpVal = supply === 0n ? 0n : (lp * (await poolNavUsd(p))) / supply
    return lpVal + usdOfLdo(await ldo.balanceOf(holder)) + usdOfStEth(await stEthErc20.balanceOf(holder))
  }

  async function assetsUsd(holder: string): Promise<bigint> {
    return (
      usdOfLdo(await ldo.balanceOf(holder)) +
      (await usdOfWstEth(await wstethErc20.balanceOf(holder)))
    )
  }

  /*//////////////////////////////////////////////////////////////
                              FIXTURES
  //////////////////////////////////////////////////////////////*/

  async function deployPoolAt(initPrice: bigint): Promise<ITwocryptoNGPool> {
    const deployed = await deployLdoWstEthPool(deployer, initPrice)
    const p = await ethers.getContractAt('ITwocryptoNGPool', await deployed.getAddress())
    // Pre-approve both actors for both coins so seeds and swaps are frictionless.
    for (const who of [deployer, attacker]) {
      await ldo.connect(who).approve(await p.getAddress(), ethers.MaxUint256)
      await wstethErc20.connect(who).approve(await p.getAddress(), ethers.MaxUint256)
    }
    return p
  }

  // Deploys a BuybackExecutor bound to `poolAddr`, plus the Stonks that puts it into LP mode.
  async function deployExecutorFor(
    poolAddr: string,
    bootstrapMinTvlUsd: bigint
  ): Promise<BuybackExecutor> {
    const exec = await new BuybackExecutor__factory(deployer).deploy({
      admin: deployerAddr,
      treasury: contracts.AGENT,
      wstEth: contracts.WSTETH,
      ldo: contracts.LDO,
      oracleRouter: oracleRouterAddr,
      curvePoolAndToken: poolAddr,
      poolPriceDivergenceToleranceBps: TOLERANCE_BPS,
      minAllowedOrderAmount: parseEther('0.01'),
      maxAllowedOrderAmount: parseEther('100000'),
      minDepositValueUsd: parseEther('1'),
      maxDepositValueUsd: parseEther('100000000'),
      poolBootstrapMinTvlUsd: bootstrapMinTvlUsd,
    })
    await exec.waitForDeployment()
    const execAddr = await exec.getAddress()

    const { stonks } = (await deployStonks({
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
        manager: execAddr,
        marginInBps: 100,
        orderDuration: 300,
        priceToleranceInBps: 100,
        maxImprovementInBps: 100,
        allowPartialFill: false,
        receiver: execAddr,
      },
      amountConverterParams: {
        oracleRouter: oracleRouterAddr,
        allowedTokensToSell: [stEthAddress],
        allowedTokensToBuy: [contracts.LDO],
        useEthAnchor: false,
      },
      skipRouterConfiguration: true,
    })) as { stonks: Stonks }

    await exec.setStonksAndOperatingMode(await stonks.getAddress())
    expect(await exec.lpModeEnabled()).to.equal(true)
    return exec
  }

  // Funds an executor with a balanced LDO + stETH pair ready to deposit (`wstPerSide` each leg).
  async function fundExecutor(execAddr: string, wstPerSide: bigint): Promise<bigint> {
    const stEthAmount = await wsteth.getStETHByWstETH(wstPerSide)
    const ldoAmount = (wstPerSide * fairPrice) / PRICE_UNIT
    await ldo.connect(agent).transfer(execAddr, ldoAmount)
    await stEthErc20.connect(deployer).transfer(execAddr, stEthAmount)
    return usdOfLdo(ldoAmount) + (await usdOfWstEth(wstPerSide))
  }

  // Adds `wstAmount` (and the matching LDO at `ratio`) as balanced liquidity from `who`.
  async function seedBalanced(
    p: ITwocryptoNGPool,
    who: Signer,
    wstAmount: bigint,
    ratio: bigint
  ): Promise<void> {
    const ldoAmount = (wstAmount * ratio) / PRICE_UNIT
    await p.connect(who).add_liquidity([ldoAmount, wstAmount], 1n)
  }

  // Drives the pool's `price_oracle` EMA away from the oracle so the divergence gate reads a real
  // (persistent) mispricing: one big swap, an hour of decay (EMA half-life ~14min, so it fully
  // converges, while staying inside the oracle feed's 24h staleness window), then a poke to recompute.
  async function driveEmaAway(p: ITwocryptoNGPool, wstSwap: bigint): Promise<void> {
    await p.connect(attacker).exchange(WSTETH_INDEX, LDO_INDEX, wstSwap, 0n)
    await time.increase(60 * 60)
    await p.connect(attacker).exchange(WSTETH_INDEX, LDO_INDEX, parseEther('0.001'), 0n)
  }

  /*//////////////////////////////////////////////////////////////
                               SETUP
  //////////////////////////////////////////////////////////////*/

  before(async function () {
    ;[deployer, attacker] = await ethers.getSigners()
    deployerAddr = await deployer.getAddress()
    attackerAddr = await attacker.getAddress()

    const locator: ILidoLocator = await ethers.getContractAt('ILidoLocator', LIDO_LOCATOR)
    stEthAddress = await locator.lido()
    stEthErc20 = await ethers.getContractAt('IERC20', stEthAddress)
    wsteth = await ethers.getContractAt('IWstETH', contracts.WSTETH)
    wstethErc20 = await ethers.getContractAt('IERC20', contracts.WSTETH)
    ldo = await ethers.getContractAt('IERC20', contracts.LDO)

    oracleRouter = await getTestOracleRouter({ tokens: [stEthAddress, contracts.LDO] })
    oracleRouterAddr = await oracleRouter.getAddress()
    ;[ldoUsd, stEthUsd] = await oracleRouter.getUsdPrices(contracts.LDO, stEthAddress)
    const stEthPerWstEth = await wsteth.getStETHByWstETH(PRICE_UNIT)
    const wstEthUsd = (stEthUsd * stEthPerWstEth) / PRICE_UNIT
    fairPrice = (wstEthUsd * PRICE_UNIT) / ldoUsd

    // --- Fund deployer (seeds + executor funding) and attacker (deep manipulation inventory).
    await setBalance(deployerAddr, parseEther('1000000'))
    const attackerWstEth = await wsteth.getStETHByWstETH(parseEther('60'))
    const deployerWstEth = await wsteth.getStETHByWstETH(parseEther('40'))
    const executorReserveStEth = await wsteth.getStETHByWstETH(parseEther('10'))
    const lido = new ethers.Contract(
      stEthAddress,
      ['function submit(address) payable returns (uint256)'],
      deployer
    )
    await lido.submit(ZeroAddress, {
      value: attackerWstEth + deployerWstEth + executorReserveStEth + parseEther('10'),
    })
    await stEthErc20.connect(deployer).approve(contracts.WSTETH, ethers.MaxUint256)
    await wsteth.connect(deployer).wrap(attackerWstEth + deployerWstEth)
    await wstethErc20
      .connect(deployer)
      .transfer(attackerAddr, await wsteth.getWstETHByStETH(attackerWstEth))

    await impersonateAccount(contracts.AGENT)
    await setBalance(contracts.AGENT, FUND)
    agent = await ethers.getSigner(contracts.AGENT)
    await ldo.connect(agent).transfer(deployerAddr, (parseEther('40') * fairPrice) / PRICE_UNIT)
    await ldo.connect(agent).transfer(attackerAddr, (parseEther('600') * fairPrice) / PRICE_UNIT)

    // --- Shared fixture: empty pool at the fair price + bootstrap-mode executor funded to deposit.
    pool = await deployPoolAt(fairPrice)
    executor = await deployExecutorFor(await pool.getAddress(), BOOTSTRAP_MIN_TVL_USD)
    executorAddr = await executor.getAddress()
    await fundExecutor(executorAddr, DEPOSIT_WST_PER_SIDE)

    baseSnapshot = await takeSnapshot()
  })

  beforeEach(async function () {
    snapshot = await takeSnapshot()
  })

  afterEach(async function () {
    await snapshot.restore()
  })

  after(async function () {
    if (baseSnapshot) await baseSnapshot.restore()
    resetTestOracleRouter()
  })

  /*//////////////////////////////////////////////////////////////
                          HONEST BASELINE
  //////////////////////////////////////////////////////////////*/

  describe('honest deposit (control):', function () {
    it('mints LP and emits LiquidityAdded when depositing into an unmanipulated pool', async function () {
      await seedBalanced(pool, deployer, parseEther('5'), fairPrice)

      const lpBefore = await executor.getLpTokenBalance()
      await expect(executor.addLiquidity()).to.emit(executor, 'LiquidityAdded')
      expect(await executor.getLpTokenBalance()).to.be.gt(lpBefore)
    })

    it('loses at most the Curve imbalance fee (sub-1%) at oracle value', async function () {
      await seedBalanced(pool, deployer, parseEther('5'), fairPrice)

      const depositUsd = await positionUsd(executorAddr, pool)
      await executor.addLiquidity()
      const afterUsd = await positionUsd(executorAddr, pool)

      const lossBps = ((depositUsd - afterUsd) * 10000n) / depositUsd
      expect(lossBps).to.be.lt(HONEST_LOSS_TOLERANCE_BPS)
    })

    it('is also safe as the sole first depositor into an empty pool', async function () {
      const depositUsd = await positionUsd(executorAddr, pool)
      await expect(executor.addLiquidity()).to.emit(executor, 'LiquidityAdded')
      const afterUsd = await positionUsd(executorAddr, pool)

      const lossBps = ((depositUsd - afterUsd) * 10000n) / depositUsd
      expect(lossBps).to.be.lt(HONEST_LOSS_TOLERANCE_BPS)
    })
  })

  /*//////////////////////////////////////////////////////////////
                    BOOTSTRAP BYPASS vs. GATE
  //////////////////////////////////////////////////////////////*/

  describe('divergence gate and bootstrap bypass:', function () {
    it('bypasses the gate while TVL is below poolBootstrapMinTvlUsd (deposits a mispriced pool)', async function () {
      // Pool seeded ~50% off the oracle. TVL is far below the 1M bootstrap threshold, so the gate is
      // skipped and the deposit proceeds — the intended bootstrap behaviour.
      await seedBalanced(pool, deployer, parseEther('5'), (fairPrice * 15000n) / 10000n)
      await expect(executor.addLiquidity()).to.emit(executor, 'LiquidityAdded')
    })

    it('enforces the gate once TVL clears the threshold and the EMA has diverged', async function () {
      await seedBalanced(pool, deployer, parseEther('20'), fairPrice)
      await driveEmaAway(pool, parseEther('5'))

      // Sanity: the EMA the gate reads is now well past tolerance.
      const ema = await pool.price_oracle()
      const emaDivBps =
        ((ema > fairPrice ? ema - fairPrice : fairPrice - ema) * 10000n) / fairPrice
      expect(emaDivBps).to.be.gt(TOLERANCE_BPS)

      // Lower the bootstrap threshold below the seeded TVL so the gate is enforced, and it blocks.
      await executor.setPoolBootstrapMinTvlUsd(GATE_ACTIVE_MIN_TVL_USD)
      await expect(executor.addLiquidity()).to.be.revertedWithCustomError(
        executor,
        'PoolPriceDivergenceTooHigh'
      )
    })

    it('the gate reads a lagging EMA — a same-block swap does not move it', async function () {
      await seedBalanced(pool, deployer, parseEther('20'), fairPrice)

      const emaBefore = await pool.price_oracle()
      await pool.connect(attacker).exchange(WSTETH_INDEX, LDO_INDEX, parseEther('5'), 0n)
      const emaAfter = await pool.price_oracle()

      // price_oracle is a time-weighted EMA; within one block (dt = 0) it is frozen. So neither the
      // gate nor its bypass is what defends the deposit against a same-block sandwich — the
      // balanced-at-oracle amounts are (see the sandwich tests below).
      expect(emaAfter).to.equal(emaBefore)
    })
  })

  /*//////////////////////////////////////////////////////////////
                    RESISTS A SAME-BLOCK SANDWICH
  //////////////////////////////////////////////////////////////*/

  describe('resists a same-block sandwich around addLiquidity:', function () {
    // addLiquidity is permissionless, so the attacker triggers the victim deposit itself, wrapped in
    // a frontrun/backrun swap. The balanced-at-oracle deposit is corrective, so the executor never
    // ends up worse than the honest fee and the attacker never profits.
    async function runSandwich(sellIndex: bigint): Promise<{ execLossBps: bigint; attackerPnl: bigint }> {
      await seedBalanced(pool, deployer, parseEther('5'), fairPrice)

      const depositUsd = await positionUsd(executorAddr, pool)
      const attackerBefore = await assetsUsd(attackerAddr)
      const heldBefore =
        sellIndex === WSTETH_INDEX
          ? await ldo.balanceOf(attackerAddr)
          : await wstethErc20.balanceOf(attackerAddr)

      const buyIndex = sellIndex === WSTETH_INDEX ? LDO_INDEX : WSTETH_INDEX
      const frontrun = sellIndex === WSTETH_INDEX ? parseEther('3') : (parseEther('3') * fairPrice) / PRICE_UNIT

      await pool.connect(attacker).exchange(sellIndex, buyIndex, frontrun, 0n)
      await executor.connect(attacker).addLiquidity()
      const gained =
        (sellIndex === WSTETH_INDEX
          ? await ldo.balanceOf(attackerAddr)
          : await wstethErc20.balanceOf(attackerAddr)) - heldBefore
      if (gained > 0n) {
        await pool.connect(attacker).exchange(buyIndex, sellIndex, gained, 0n)
      }

      const afterUsd = await positionUsd(executorAddr, pool)
      return {
        execLossBps: ((depositUsd - afterUsd) * 10000n) / depositUsd,
        attackerPnl: (await assetsUsd(attackerAddr)) - attackerBefore,
      }
    }

    it('does not harm the executor when the attacker frontruns by selling wstETH', async function () {
      const { execLossBps, attackerPnl } = await runSandwich(WSTETH_INDEX)
      expect(execLossBps).to.be.lt(HONEST_LOSS_TOLERANCE_BPS) // no extra loss vs. the honest fee
      expect(attackerPnl).to.be.lte(0n) // the sandwich costs the attacker
    })

    it('does not harm the executor when the attacker frontruns by selling LDO', async function () {
      const { execLossBps, attackerPnl } = await runSandwich(LDO_INDEX)
      expect(execLossBps).to.be.lt(HONEST_LOSS_TOLERANCE_BPS)
      expect(attackerPnl).to.be.lte(0n)
    })
  })

  /*//////////////////////////////////////////////////////////////
              RESISTS A PRE-MANIPULATED (MISPRICED) POOL
  //////////////////////////////////////////////////////////////*/

  describe('resists a pool the attacker pre-mispriced over time:', function () {
    for (const deltaBps of [2000n, 5000n, -2000n, -5000n]) {
      it(`executor is not worse off when the pool is pre-seeded ${deltaBps} bps off the oracle`, async function () {
        const wrongPrice = (fairPrice * (10000n + deltaBps)) / 10000n
        await seedBalanced(pool, attacker, parseEther('30'), wrongPrice)

        const depositUsd = await positionUsd(executorAddr, pool)
        const attackerClaimBefore = (await pool.balanceOf(attackerAddr)) === 0n ? 0n : await positionUsd(attackerAddr, pool)

        await expect(executor.connect(attacker).addLiquidity()).to.emit(executor, 'LiquidityAdded')

        const afterUsd = await positionUsd(executorAddr, pool)
        // The executor keeps at least its deposit value (loss, if any, only the honest fee).
        const lossBps = ((depositUsd - afterUsd) * 10000n) / depositUsd
        expect(lossBps).to.be.lt(HONEST_LOSS_TOLERANCE_BPS)

        // And the attacker's deep LP claim did not grow at the executor's expense.
        const attackerClaimAfter = await positionUsd(attackerAddr, pool)
        expect(attackerClaimAfter).to.be.lte(attackerClaimBefore)
      })
    }
  })

  /*//////////////////////////////////////////////////////////////
            EMPTY POOL WITH A STALE INITIAL PRICE
  //////////////////////////////////////////////////////////////*/

  describe('empty pool deployed with a stale initial price:', function () {
    for (const deltaBps of [1000n, 5000n]) {
      it(`first deposit into a pool initialised ${deltaBps} bps off the oracle is not exploitable`, async function () {
        const staleInit = (fairPrice * (10000n + deltaBps)) / 10000n
        const stalePool = await deployPoolAt(staleInit)
        const staleExecutor = await deployExecutorFor(
          await stalePool.getAddress(),
          BOOTSTRAP_MIN_TVL_USD
        )
        const staleExecAddr = await staleExecutor.getAddress()
        const depositUsd = await fundExecutor(staleExecAddr, DEPOSIT_WST_PER_SIDE)

        await expect(staleExecutor.addLiquidity()).to.emit(staleExecutor, 'LiquidityAdded')

        // The marginal spot after the first deposit tracks the oracle, not the stale init price.
        const tinyWst = PRICE_UNIT / 1000n
        const marginalSpot = (await stalePool.get_dy(WSTETH_INDEX, LDO_INDEX, tinyWst)) * 1000n
        const spotDivBps =
          ((marginalSpot > fairPrice ? marginalSpot - fairPrice : fairPrice - marginalSpot) *
            10000n) /
          fairPrice
        expect(spotDivBps).to.be.lt(SPOT_ALIGNMENT_TOLERANCE_BPS)

        // An arber cannot extract from the sole-LP executor: its position holds its deposit value.
        const afterUsd = await positionUsd(staleExecAddr, stalePool)
        const lossBps = ((depositUsd - afterUsd) * 10000n) / depositUsd
        expect(lossBps).to.be.lt(HONEST_LOSS_TOLERANCE_BPS)
      })
    }
  })
})
