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

const TOLERANCE_BPS = 500n
const BOOTSTRAP_MIN_TVL_USD = parseEther('1000000') // shallow pool stays in bootstrap (gate bypassed)
const GATE_ACTIVE_MIN_TVL_USD = parseEther('1') // below any seeded TVL => divergence gate enforced

const DEPOSIT_WST_PER_SIDE = parseEther('0.7')

/**
 * Integration coverage for `BuybackExecutor.addLiquidity` against a real Curve LDO/wstETH TwoCrypto
 * pool on a mainnet fork: deposit sizing (balancing, the max-value cap, LP accounting) and the full
 * precondition matrix (mode, balances, deposit floor, oracle availability, pause, divergence gate).
 */
describe('BuybackExecutor.addLiquidity', function () {
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
  let fairPrice: bigint // fair LDO per wstETH, 1e18-scaled

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

  // Oracle value of an address's undeposited (non-LP) LDO + stETH — the assets still free to deposit.
  async function undepositedAssetsUsd(holder: string): Promise<bigint> {
    return usdOfLdo(await ldo.balanceOf(holder)) + usdOfStEth(await stEthErc20.balanceOf(holder))
  }

  /*//////////////////////////////////////////////////////////////
                              FIXTURES
  //////////////////////////////////////////////////////////////*/

  async function deployPoolAt(initPrice: bigint): Promise<ITwocryptoNGPool> {
    const deployed = await deployLdoWstEthPool(deployer, initPrice)
    const p = await ethers.getContractAt('ITwocryptoNGPool', await deployed.getAddress())
    for (const who of [deployer, attacker]) {
      await ldo.connect(who).approve(await p.getAddress(), ethers.MaxUint256)
      await wstethErc20.connect(who).approve(await p.getAddress(), ethers.MaxUint256)
    }
    return p
  }

  // Deploys a BuybackExecutor bound to `poolAddr`, plus a Stonks that sets its operating mode.
  // `receiver` = the executor for LP mode, `TREASURY` for treasury mode.
  async function deployExecutorFor(
    poolAddr: string,
    bootstrapMinTvlUsd: bigint,
    receiver?: string
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
        receiver: receiver ?? execAddr,
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
    return exec
  }

  async function giveExecutorLdo(wstEquiv: bigint): Promise<void> {
    await ldo.connect(agent).transfer(executorAddr, (wstEquiv * fairPrice) / PRICE_UNIT)
  }
  async function giveExecutorStEth(wstEquiv: bigint): Promise<void> {
    await stEthErc20.connect(deployer).transfer(executorAddr, await wsteth.getStETHByWstETH(wstEquiv))
  }
  async function fundExecutorBalanced(wstPerSide: bigint): Promise<void> {
    await giveExecutorLdo(wstPerSide)
    await giveExecutorStEth(wstPerSide)
  }

  async function seedBalanced(
    p: ITwocryptoNGPool,
    who: Signer,
    wstAmount: bigint,
    ratio: bigint
  ): Promise<void> {
    await p.connect(who).add_liquidity([(wstAmount * ratio) / PRICE_UNIT, wstAmount], 1n)
  }

  // Drives the pool's `price_oracle` EMA off the oracle: a big swap, an hour of decay (EMA half-life
  // ~14min, inside the feed's 24h staleness window), then a poke to force the recompute.
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

    // --- Fund deployer (executor funding + seeds) and attacker (EMA-driving swap inventory).
    await setBalance(deployerAddr, parseEther('1000000'))
    const attackerWstEth = await wsteth.getStETHByWstETH(parseEther('20'))
    const deployerWstEth = await wsteth.getStETHByWstETH(parseEther('20'))
    const executorReserveStEth = await wsteth.getStETHByWstETH(parseEther('30'))
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
    await ldo.connect(agent).transfer(attackerAddr, (parseEther('20') * fairPrice) / PRICE_UNIT)

    // --- Shared fixture: empty pool at the fair price + bootstrap-mode executor in LP mode, funded.
    pool = await deployPoolAt(fairPrice)
    executor = await deployExecutorFor(await pool.getAddress(), BOOTSTRAP_MIN_TVL_USD)
    executorAddr = await executor.getAddress()
    expect(await executor.lpModeEnabled()).to.equal(true)
    await fundExecutorBalanced(DEPOSIT_WST_PER_SIDE)

    // Roles the tests exercise (drain balances / pause), granted once so snapshots preserve them.
    await executor.grantRole(await executor.MANAGER_ROLE(), deployerAddr)
    await executor.grantRole(await executor.EMERGENCY_ROLE(), deployerAddr)

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
                       DEPOSIT & LP ACCOUNTING
  //////////////////////////////////////////////////////////////*/

  describe('deposit and LP accounting:', function () {
    it('mints LP into the executor and emits LiquidityAdded with the deposited amounts', async function () {
      const tx = await executor.addLiquidity()
      const rcpt = (await tx.wait())!
      const [ev] = await executor.queryFilter(
        executor.filters.LiquidityAdded(),
        rcpt.blockNumber,
        rcpt.blockNumber
      )
      expect(ev, 'LiquidityAdded not emitted').to.not.equal(undefined)
      expect(ev.args.caller).to.equal(deployerAddr)
      expect(ev.args.ldoAmount).to.be.gt(0n)
      expect(ev.args.wstEthAmount).to.be.gt(0n)
      expect(ev.args.lpTokensMinted).to.be.gt(0n)

      // Contract's own LP accounting matches the pool's, and both match the minted amount.
      expect(await executor.getLpTokenBalance()).to.equal(ev.args.lpTokensMinted)
      expect(await pool.balanceOf(executorAddr)).to.equal(ev.args.lpTokensMinted)
    })

    it('returns the minted LP amount', async function () {
      const minted = await executor.addLiquidity.staticCall()
      expect(minted).to.be.gt(0n)
    })

    it('accumulates LP across successive deposits', async function () {
      await executor.addLiquidity()
      const afterFirst = await executor.getLpTokenBalance()
      expect(afterFirst).to.be.gt(0n)

      await fundExecutorBalanced(DEPOSIT_WST_PER_SIDE)
      await executor.addLiquidity()
      expect(await executor.getLpTokenBalance()).to.be.gt(afterFirst)
    })

    it('deposits into a pool that already holds third-party liquidity', async function () {
      await seedBalanced(pool, deployer, parseEther('5'), fairPrice)
      const supplyBefore = await pool.totalSupply()

      await expect(executor.addLiquidity()).to.emit(executor, 'LiquidityAdded')
      expect(await pool.totalSupply()).to.be.gt(supplyBefore)
      expect(await pool.balanceOf(executorAddr)).to.be.gt(0n)
    })
  })

  /*//////////////////////////////////////////////////////////////
                         BALANCED SIZING
  //////////////////////////////////////////////////////////////*/

  describe('balanced sizing:', function () {
    it('deposits both legs at equal oracle value (balanced at the oracle price)', async function () {
      const tx = await executor.addLiquidity()
      const rcpt = (await tx.wait())!
      const [ev] = await executor.queryFilter(
        executor.filters.LiquidityAdded(),
        rcpt.blockNumber,
        rcpt.blockNumber
      )
      const ldoLegUsd = usdOfLdo(ev.args.ldoAmount)
      const wstLegUsd = await usdOfWstEth(ev.args.wstEthAmount)
      // Balancing is exact at the oracle price; the legs differ only by sub-wei rounding.
      const diffBps =
        ((ldoLegUsd > wstLegUsd ? ldoLegUsd - wstLegUsd : wstLegUsd - ldoLegUsd) * 10000n) /
        ldoLegUsd
      expect(diffBps).to.be.lt(10n) // 0.1%
    })

    it('sizes by the smaller side when LDO is larger: stETH consumed, LDO surplus untouched', async function () {
      // Give the executor a big LDO surplus on top of the balanced pair: LDO is now the larger side.
      await giveExecutorLdo(parseEther('3'))
      const stEthBefore = await stEthErc20.balanceOf(executorAddr)
      const ldoBefore = await ldo.balanceOf(executorAddr)

      const tx = await executor.addLiquidity()
      const rcpt = (await tx.wait())!
      const [ev] = await executor.queryFilter(
        executor.filters.LiquidityAdded(),
        rcpt.blockNumber,
        rcpt.blockNumber
      )

      // stETH (smaller side) is fully consumed; a large LDO surplus stays behind.
      expect(await stEthErc20.balanceOf(executorAddr)).to.be.lt(parseEther('0.0001'))
      const ldoSpent = ldoBefore - (await ldo.balanceOf(executorAddr))
      expect(ldoSpent).to.equal(ev.args.ldoAmount)
      expect(await ldo.balanceOf(executorAddr)).to.be.gt((parseEther('2') * fairPrice) / PRICE_UNIT)
      // Deposited stETH corresponds to what was there before (wrapped to wstEth for the deposit).
      expect(await wsteth.getStETHByWstETH(ev.args.wstEthAmount)).to.be.closeTo(
        stEthBefore,
        parseEther('0.0001')
      )
    })

    it('sizes by the smaller side when stETH is larger: LDO consumed, stETH surplus untouched', async function () {
      // Mirror of the above — the other _computeBalancedAmounts branch. Give a big stETH surplus, so
      // stETH is the larger side and LDO the smaller one that gets fully consumed.
      await giveExecutorStEth(parseEther('3'))
      const ldoBefore = await ldo.balanceOf(executorAddr)
      const stEthBefore = await stEthErc20.balanceOf(executorAddr)

      const tx = await executor.addLiquidity()
      const rcpt = (await tx.wait())!
      const [ev] = await executor.queryFilter(
        executor.filters.LiquidityAdded(),
        rcpt.blockNumber,
        rcpt.blockNumber
      )

      // LDO (smaller side) is fully consumed; a large stETH surplus stays behind.
      expect(await ldo.balanceOf(executorAddr)).to.equal(0n)
      expect(ev.args.ldoAmount).to.equal(ldoBefore)
      expect(await stEthErc20.balanceOf(executorAddr)).to.be.gt(
        await wsteth.getStETHByWstETH(parseEther('2'))
      )
      // Deposited wstEth matches the stETH that left the executor's balance.
      const stEthSpent = stEthBefore - (await stEthErc20.balanceOf(executorAddr))
      expect(await wsteth.getStETHByWstETH(ev.args.wstEthAmount)).to.be.closeTo(
        stEthSpent,
        parseEther('0.0001')
      )
    })

    it('caps a single call at maxDepositValueUsd and carries the surplus to later calls', async function () {
      const cap = parseEther('2000')
      await executor.setMaxDepositValueUsd(cap)
      await fundExecutorBalanced(parseEther('3')) // well over the cap on both legs

      const undepositedBefore = await undepositedAssetsUsd(executorAddr)
      await executor.addLiquidity()
      const depositedUsd = undepositedBefore - (await undepositedAssetsUsd(executorAddr))

      // One call deposits exactly the cap (both legs scaled to it), not the whole balance.
      expect(depositedUsd).to.be.gt((cap * 999n) / 1000n)
      expect(depositedUsd).to.be.lt((cap * 1001n) / 1000n)
      expect(await undepositedAssetsUsd(executorAddr)).to.be.gt(cap) // plenty left for more calls

      // The carried surplus is depositable on the next call, again capped at maxDepositValueUsd.
      const secondBefore = await undepositedAssetsUsd(executorAddr)
      await executor.addLiquidity()
      const secondDeposited = secondBefore - (await undepositedAssetsUsd(executorAddr))
      expect(secondDeposited).to.be.gt((cap * 999n) / 1000n)
      expect(secondDeposited).to.be.lt((cap * 1001n) / 1000n)
    })
  })

  /*//////////////////////////////////////////////////////////////
                       PRECONDITION MATRIX
  //////////////////////////////////////////////////////////////*/

  describe('preconditions (reverts):', function () {
    it('reverts NotInLpMode in treasury mode', async function () {
      // Switch the executor to treasury mode via a Stonks whose receiver is the treasury.
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
          manager: executorAddr,
          marginInBps: 100,
          orderDuration: 300,
          priceToleranceInBps: 100,
          maxImprovementInBps: 100,
          allowPartialFill: false,
          receiver: contracts.AGENT, // = executor TREASURY => treasury mode
        },
        amountConverterParams: {
          oracleRouter: oracleRouterAddr,
          allowedTokensToSell: [stEthAddress],
          allowedTokensToBuy: [contracts.LDO],
          useEthAnchor: false,
        },
        skipRouterConfiguration: true,
      })) as { stonks: Stonks }
      await executor.setStonksAndOperatingMode(await stonks.getAddress())
      expect(await executor.lpModeEnabled()).to.equal(false)

      expect(await executor.canAddLiquidity()).to.equal(false)
      await expect(executor.addLiquidity()).to.be.revertedWithCustomError(executor, 'NotInLpMode')
    })

    it('reverts ZeroLdoBalance when the executor holds no LDO', async function () {
      await executor.recoverERC20(contracts.LDO, await ldo.balanceOf(executorAddr))
      expect(await ldo.balanceOf(executorAddr)).to.equal(0n)

      expect(await executor.canAddLiquidity()).to.equal(false)
      await expect(executor.addLiquidity()).to.be.revertedWithCustomError(executor, 'ZeroLdoBalance')
    })

    it('reverts ZeroStEthBalance when the executor holds LDO but no stETH', async function () {
      // stETH is a rebasing token: recovering the full balance leaves ~1 wei of shares dust, which
      // would fall through to DepositValueBelowMinimum. Use a fresh LP executor funded LDO-only so
      // its stETH balance is genuinely zero.
      const freshExec = await deployExecutorFor(await pool.getAddress(), BOOTSTRAP_MIN_TVL_USD)
      const freshAddr = await freshExec.getAddress()
      await ldo.connect(agent).transfer(freshAddr, (DEPOSIT_WST_PER_SIDE * fairPrice) / PRICE_UNIT)
      expect(await stEthErc20.balanceOf(freshAddr)).to.equal(0n)

      expect(await freshExec.canAddLiquidity()).to.equal(false)
      await expect(freshExec.addLiquidity()).to.be.revertedWithCustomError(
        freshExec,
        'ZeroStEthBalance'
      )
    })

    it('reverts DepositValueBelowMinimum when the balanced value is under the floor', async function () {
      // Raise the floor above the funded value; the balanced deposit is now too small.
      await executor.setMinDepositValueUsd(parseEther('100000'))

      expect(await executor.canAddLiquidity()).to.equal(false)
      await expect(executor.addLiquidity()).to.be.revertedWithCustomError(
        executor,
        'DepositValueBelowMinimum'
      )
    })

    it('reverts OraclePriceUnavailable when a leg has no oracle price', async function () {
      // Deactivate the LDO feed on the shared OracleRouter; getUsdPrices then fails for LDO.
      await oracleRouter.connect(deployer).setTokenActive(contracts.LDO, false)

      expect(await executor.canAddLiquidity()).to.equal(false)
      await expect(executor.addLiquidity()).to.be.revertedWithCustomError(
        executor,
        'OraclePriceUnavailable'
      )
    })

    it('reverts while paused', async function () {
      await executor.pause()

      expect(await executor.canAddLiquidity()).to.equal(false)
      await expect(executor.addLiquidity()).to.be.revertedWith('Pausable: paused')
    })
  })

  /*//////////////////////////////////////////////////////////////
                    DIVERGENCE GATE (enforced)
  //////////////////////////////////////////////////////////////*/

  describe('divergence gate when enforced (out of bootstrap):', function () {
    it('lets an aligned pool through', async function () {
      await seedBalanced(pool, deployer, parseEther('20'), fairPrice) // aligned with the oracle
      await executor.setPoolBootstrapMinTvlUsd(GATE_ACTIVE_MIN_TVL_USD) // gate enforced

      expect(await executor.canAddLiquidity()).to.equal(true)
      await expect(executor.addLiquidity()).to.emit(executor, 'LiquidityAdded')
    })

    it('blocks a diverged pool with PoolPriceDivergenceTooHigh', async function () {
      await seedBalanced(pool, deployer, parseEther('20'), fairPrice)
      await driveEmaAway(pool, parseEther('5')) // push the EMA the gate reads off the oracle
      await executor.setPoolBootstrapMinTvlUsd(GATE_ACTIVE_MIN_TVL_USD)

      expect(await executor.canAddLiquidity()).to.equal(false)
      await expect(executor.addLiquidity()).to.be.revertedWithCustomError(
        executor,
        'PoolPriceDivergenceTooHigh'
      )
    })
  })
})
