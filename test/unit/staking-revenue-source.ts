import { ethers } from 'hardhat'
import { expect } from 'chai'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import { StakingRevenueSource, WstETHStub, AccountingOracleStub, OracleRouter } from '../../typechain-types'
import { getTestOracleRouter, resetTestOracleRouter } from '../../utils/test-oracle-router'
import { updateTokenFeed, resetTestFeedRegistryStub } from '../../utils/test-feed-registry'
import { getContracts } from '../../utils/contracts'

const contracts = getContracts()

const GENESIS_TIME = 1606824023n
const SECONDS_PER_SLOT = 12n
const TOKEN_RATE_SCALE = 10n ** 27n
const PRICE_SCALE = 10n ** 18n

// Seed rate written into wstETH stub before contract deployment.
// The constructor reads this to initialise _lastStEthPerToken.
const SEED_RATE = (TOKEN_RATE_SCALE * 11n) / 10n // 1.1e27

const DEFAULT_TOTAL_SUPPLY = 10_000_000n * PRICE_SCALE // 10M wstETH
const DEFAULT_REF_SLOT = 1000n

// OracleRouter normalises Chainlink 8-decimal prices to PRICE_UNIT (1e18).
// STETH_FEED_PRICE is what we write to ChainlinkFeedRegistryStub (8 decimals).
// STETH_ORACLE_PRICE is what getUsdPrices returns after normalisation.
const STETH_FEED_PRICE = 2000n * 10n ** 8n   // $2000 in 8-decimal Chainlink format
const STETH_ORACLE_PRICE = 2000n * PRICE_SCALE // $2000 normalised to 18 decimals

const feedConfig = { tokens: [contracts.STETH] }

// ITokenRatePusher: bytes4(keccak256("pushTokenRate()"))
const TOKEN_RATE_PUSHER_IFACE_ID = '0xa16ba44d'
const ERC165_IFACE_ID = '0x01ffc9a7'

// Writes a specific stETH price (in 8-decimal Chainlink format) to the feed stub
// with an up-to-date timestamp so the OracleRouter staleness check passes.
async function setStEthFeedPrice(answer: bigint): Promise<void> {
  const nowTs = BigInt((await ethers.provider.getBlock('latest'))!.timestamp)
  await updateTokenFeed(feedConfig, contracts.STETH, contracts.CHAINLINK_USD_QUOTE, {
    answer,
    updatedAt: nowTs,
    startedAt: nowTs,
    answeredInRound: 1n,
    roundId: 1n,
  })
}

async function deployContract(
  oracleRouter: string,
  stEth: string,
  wstEth: string,
  accountingOracle: string
): Promise<StakingRevenueSource> {
  const factory = await ethers.getContractFactory('StakingRevenueSource')
  const contract = await factory.deploy(oracleRouter, stEth, wstEth, accountingOracle)
  await contract.waitForDeployment()
  return contract
}

describe('StakingRevenueSource', async function () {
  let subject: StakingRevenueSource
  let oracleRouter: OracleRouter
  let wstEthStub: WstETHStub
  let accountingOracleStub: AccountingOracleStub
  let snapshot: SnapshotRestorer

  before(async function () {
    snapshot = await takeSnapshot()

    // Real OracleRouter backed by ChainlinkFeedRegistryStub — seeded with real prices
    oracleRouter = await getTestOracleRouter({ tokens: [contracts.STETH] })

    await setStEthFeedPrice(STETH_FEED_PRICE)

    const wstEthFactory = await ethers.getContractFactory('WstETHStub')
    wstEthStub = await wstEthFactory.deploy()
    await wstEthStub.waitForDeployment()

    const accountingFactory = await ethers.getContractFactory('AccountingOracleStub')
    accountingOracleStub = await accountingFactory.deploy(GENESIS_TIME, SECONDS_PER_SLOT)
    await accountingOracleStub.waitForDeployment()

    // Seed wstETH stub before deploying contract — constructor reads this rate
    await wstEthStub.setRate(SEED_RATE)
    await wstEthStub.setTotalSupply(DEFAULT_TOTAL_SUPPLY)
    await accountingOracleStub.setLastProcessingRefSlot(DEFAULT_REF_SLOT)

    subject = await deployContract(
      await oracleRouter.getAddress(),
      contracts.STETH,
      await wstEthStub.getAddress(),
      await accountingOracleStub.getAddress()
    )
  })

  after(async function () {
    await snapshot.restore()
    resetTestOracleRouter()
    resetTestFeedRegistryStub()
  })

  describe('constructor:', function () {
    it('reverts with InvalidOracleRouterAddress when oracleRouter is zero address', async function () {
      const factory = await ethers.getContractFactory('StakingRevenueSource')
      await expect(
        factory.deploy(
          ethers.ZeroAddress,
          contracts.STETH,
          await wstEthStub.getAddress(),
          await accountingOracleStub.getAddress()
        )
      )
        .to.be.revertedWithCustomError(subject, 'InvalidOracleRouterAddress')
        .withArgs(ethers.ZeroAddress)
    })

    it('reverts with InvalidStEthAddress when stEth is zero address', async function () {
      const factory = await ethers.getContractFactory('StakingRevenueSource')
      await expect(
        factory.deploy(
          await oracleRouter.getAddress(),
          ethers.ZeroAddress,
          await wstEthStub.getAddress(),
          await accountingOracleStub.getAddress()
        )
      )
        .to.be.revertedWithCustomError(subject, 'InvalidStEthAddress')
        .withArgs(ethers.ZeroAddress)
    })

    it('reverts with InvalidWstEthAddress when wstEth is zero address', async function () {
      const factory = await ethers.getContractFactory('StakingRevenueSource')
      await expect(
        factory.deploy(
          await oracleRouter.getAddress(),
          contracts.STETH,
          ethers.ZeroAddress,
          await accountingOracleStub.getAddress()
        )
      )
        .to.be.revertedWithCustomError(subject, 'InvalidWstEthAddress')
        .withArgs(ethers.ZeroAddress)
    })

    it('reverts with InvalidAccountingOracleAddress when accountingOracle is zero address', async function () {
      const factory = await ethers.getContractFactory('StakingRevenueSource')
      await expect(
        factory.deploy(
          await oracleRouter.getAddress(),
          contracts.STETH,
          await wstEthStub.getAddress(),
          ethers.ZeroAddress
        )
      )
        .to.be.revertedWithCustomError(subject, 'InvalidAccountingOracleAddress')
        .withArgs(ethers.ZeroAddress)
    })

    it('sets all immutable addresses correctly', async function () {
      expect(await subject.ORACLE_ROUTER()).to.equal(await oracleRouter.getAddress())
      expect(await subject.STETH()).to.equal(contracts.STETH)
      expect(await subject.WSTETH()).to.equal(await wstEthStub.getAddress())
      expect(await subject.ACCOUNTING_ORACLE()).to.equal(await accountingOracleStub.getAddress())
    })

    it('caches GENESIS_TIME from the accounting oracle', async function () {
      expect(await subject.GENESIS_TIME()).to.equal(GENESIS_TIME)
    })

    it('caches SECONDS_PER_SLOT from the accounting oracle', async function () {
      expect(await subject.SECONDS_PER_SLOT()).to.equal(SECONDS_PER_SLOT)
    })

    it('seeds _lastStEthPerToken at deploy — first call with same rate reverts with ZeroRateDelta', async function () {
      const localSnapshot = await takeSnapshot()

      const wstEthFactory = await ethers.getContractFactory('WstETHStub')
      const freshWstEth = await wstEthFactory.deploy()
      await freshWstEth.setRate(SEED_RATE)
      await freshWstEth.setTotalSupply(DEFAULT_TOTAL_SUPPLY)

      const freshContract = await deployContract(
        await oracleRouter.getAddress(),
        contracts.STETH,
        await freshWstEth.getAddress(),
        await accountingOracleStub.getAddress()
      )

      // Rate unchanged from seed — delta == 0
      await expect(freshContract.pushTokenRate()).to.be.revertedWithCustomError(
        freshContract,
        'ZeroRateDelta'
      )

      await localSnapshot.restore()
    })
  })

  describe('supportsInterface:', function () {
    it('returns true for ITokenRatePusher interface ID', async function () {
      expect(await subject.supportsInterface(TOKEN_RATE_PUSHER_IFACE_ID)).to.equal(true)
    })

    it('returns true for IERC165 interface ID', async function () {
      expect(await subject.supportsInterface(ERC165_IFACE_ID)).to.equal(true)
    })

    it('returns false for an unsupported interface ID', async function () {
      expect(await subject.supportsInterface('0xdeadbeef')).to.equal(false)
    })
  })

  describe('getRevenue:', function () {
    let localSnapshot: SnapshotRestorer

    beforeEach(async function () {
      localSnapshot = await takeSnapshot()
    })

    afterEach(async function () {
      await localSnapshot.restore()
    })

    it('returns (0, 0) before any pushTokenRate call', async function () {
      const [revenueUsd, reportTimestamp] = await subject.getRevenue()
      expect(revenueUsd).to.equal(0n)
      expect(reportTimestamp).to.equal(0n)
    })

    it('returns the latest values after multiple pushTokenRate calls', async function () {
      await setStEthFeedPrice(STETH_FEED_PRICE)

      const rate1 = SEED_RATE + TOKEN_RATE_SCALE / 10n
      await wstEthStub.setRate(rate1)
      await expect(subject.pushTokenRate()).to.emit(subject, 'RevenueUpdated')

      const rate2 = rate1 + TOKEN_RATE_SCALE / 10n
      await wstEthStub.setRate(rate2)
      await accountingOracleStub.setLastProcessingRefSlot(2000n)

      const rateDelta2 = rate2 - rate1
      const expectedRevenueStEth2 = (rateDelta2 * DEFAULT_TOTAL_SUPPLY) / TOKEN_RATE_SCALE
      const expectedRevenueUsd2 = (expectedRevenueStEth2 * STETH_ORACLE_PRICE) / PRICE_SCALE
      const expectedTimestamp2 = GENESIS_TIME + SECONDS_PER_SLOT * 2000n

      await expect(subject.pushTokenRate())
        .to.emit(subject, 'RevenueUpdated')
        .withArgs(expectedRevenueUsd2, expectedTimestamp2)

      const [revenueUsd, reportTimestamp] = await subject.getRevenue()
      expect(revenueUsd).to.equal(expectedRevenueUsd2)
      expect(reportTimestamp).to.equal(expectedTimestamp2)
    })

    it('reverts when contract is paused', async function () {
      await subject.pause()
      await expect(subject.getRevenue()).to.be.revertedWith('Pausable: paused')
    })
  })

  describe('pushTokenRate — happy path:', function () {
    let localSnapshot: SnapshotRestorer

    beforeEach(async function () {
      localSnapshot = await takeSnapshot()
    })

    afterEach(async function () {
      await localSnapshot.restore()
    })

    it('computes and stores correct revenue and timestamp after a rate increase', async function () {
      const newRate = SEED_RATE + TOKEN_RATE_SCALE / 10n
      await wstEthStub.setRate(newRate)
      await setStEthFeedPrice(STETH_FEED_PRICE)
      await accountingOracleStub.setLastProcessingRefSlot(DEFAULT_REF_SLOT)

      const rateDelta = newRate - SEED_RATE
      const expectedRevenueStEth = (rateDelta * DEFAULT_TOTAL_SUPPLY) / TOKEN_RATE_SCALE
      const expectedRevenueUsd = (expectedRevenueStEth * STETH_ORACLE_PRICE) / PRICE_SCALE
      const expectedTimestamp = GENESIS_TIME + SECONDS_PER_SLOT * DEFAULT_REF_SLOT

      await expect(subject.pushTokenRate())
        .to.emit(subject, 'RevenueUpdated')
        .withArgs(expectedRevenueUsd, expectedTimestamp)

      const [revenueUsd, reportTimestamp] = await subject.getRevenue()
      expect(revenueUsd).to.equal(expectedRevenueUsd)
      expect(reportTimestamp).to.equal(expectedTimestamp)
    })

    it('updates _lastStEthPerToken — second call with same rate reverts with ZeroRateDelta', async function () {
      await setStEthFeedPrice(STETH_FEED_PRICE)
      await wstEthStub.setRate(SEED_RATE + TOKEN_RATE_SCALE / 10n)
      await expect(subject.pushTokenRate()).to.emit(subject, 'RevenueUpdated')
      await expect(subject.pushTokenRate()).to.be.revertedWithCustomError(subject, 'ZeroRateDelta')
    })

    it('second call computes delta against the updated rate snapshot, not the seed', async function () {
      await setStEthFeedPrice(STETH_FEED_PRICE)

      const rate1 = SEED_RATE + TOKEN_RATE_SCALE / 10n
      await wstEthStub.setRate(rate1)
      await accountingOracleStub.setLastProcessingRefSlot(1000n)
      await subject.pushTokenRate()

      const rate2 = rate1 + (TOKEN_RATE_SCALE * 15n) / 100n
      await wstEthStub.setRate(rate2)
      await accountingOracleStub.setLastProcessingRefSlot(2000n)

      const rateDelta2 = rate2 - rate1
      const expectedRevenueStEth2 = (rateDelta2 * DEFAULT_TOTAL_SUPPLY) / TOKEN_RATE_SCALE
      const expectedRevenueUsd2 = (expectedRevenueStEth2 * STETH_ORACLE_PRICE) / PRICE_SCALE
      const expectedTimestamp2 = GENESIS_TIME + SECONDS_PER_SLOT * 2000n

      await expect(subject.pushTokenRate())
        .to.emit(subject, 'RevenueUpdated')
        .withArgs(expectedRevenueUsd2, expectedTimestamp2)

      const [revenueUsd, reportTimestamp] = await subject.getRevenue()
      expect(revenueUsd).to.equal(expectedRevenueUsd2)
      expect(reportTimestamp).to.equal(expectedTimestamp2)
    })

    it('propagates OracleBadAnswer revert when oracle price feed is zero', async function () {
      // The real OracleRouter rejects zero feed answers — pushTokenRate propagates the revert.
      await wstEthStub.setRate(SEED_RATE + TOKEN_RATE_SCALE / 10n)
      await setStEthFeedPrice(0n)
      await expect(subject.pushTokenRate()).to.be.revertedWithCustomError(
        oracleRouter,
        'OracleBadAnswer'
      )
    })

    it('sub-scale delta truncates revenueStEth to zero without reverting', async function () {
      // delta = 1, totalSupply = 999e18 → (1 * 999e18) / 1e27 = 0 (truncated)
      const newRate = SEED_RATE + 1n
      await wstEthStub.setRate(newRate)
      await wstEthStub.setTotalSupply(999n * PRICE_SCALE)
      await setStEthFeedPrice(STETH_FEED_PRICE)
      await accountingOracleStub.setLastProcessingRefSlot(DEFAULT_REF_SLOT)

      const expectedTimestamp = GENESIS_TIME + SECONDS_PER_SLOT * DEFAULT_REF_SLOT

      await expect(subject.pushTokenRate())
        .to.emit(subject, 'RevenueUpdated')
        .withArgs(0n, expectedTimestamp)

      const [revenueUsd, reportTimestamp] = await subject.getRevenue()
      expect(revenueUsd).to.equal(0n)
      expect(reportTimestamp).to.equal(expectedTimestamp)
    })

    it('timestamp is correct when refSlot is 0 (genesis slot)', async function () {
      const newRate = SEED_RATE + TOKEN_RATE_SCALE / 10n
      await wstEthStub.setRate(newRate)
      await setStEthFeedPrice(STETH_FEED_PRICE)
      await accountingOracleStub.setLastProcessingRefSlot(0n)

      const rateDelta = newRate - SEED_RATE
      const expectedRevenueStEth = (rateDelta * DEFAULT_TOTAL_SUPPLY) / TOKEN_RATE_SCALE
      const expectedRevenueUsd = (expectedRevenueStEth * STETH_ORACLE_PRICE) / PRICE_SCALE

      await expect(subject.pushTokenRate())
        .to.emit(subject, 'RevenueUpdated')
        .withArgs(expectedRevenueUsd, GENESIS_TIME)

      const [revenueUsd, reportTimestamp] = await subject.getRevenue()
      expect(revenueUsd).to.equal(expectedRevenueUsd)
      expect(reportTimestamp).to.equal(GENESIS_TIME)
    })
  })

  describe('pushTokenRate — failure scenarios:', function () {
    let localSnapshot: SnapshotRestorer

    beforeEach(async function () {
      localSnapshot = await takeSnapshot()
    })

    afterEach(async function () {
      await localSnapshot.restore()
    })

    it('reverts with ZeroRateDelta when rate equals the seeded baseline', async function () {
      // wstEthStub rate is still SEED_RATE — delta == 0, reverts before oracle is queried
      await expect(subject.pushTokenRate()).to.be.revertedWithCustomError(subject, 'ZeroRateDelta')
    })

    it('reverts with ZeroRateDelta when rate decreased below baseline', async function () {
      await wstEthStub.setRate(SEED_RATE - 1n)
      await expect(subject.pushTokenRate()).to.be.revertedWithCustomError(subject, 'ZeroRateDelta')
    })

    it('reverts with Pausable error when contract is paused', async function () {
      await wstEthStub.setRate(SEED_RATE + TOKEN_RATE_SCALE / 10n)
      await subject.pause()
      await expect(subject.pushTokenRate()).to.be.revertedWith('Pausable: paused')
    })
  })

  describe('pause / unpause lifecycle:', function () {
    let localSnapshot: SnapshotRestorer

    beforeEach(async function () {
      localSnapshot = await takeSnapshot()
    })

    afterEach(async function () {
      await localSnapshot.restore()
    })

    it('getRevenue: succeeds before pause, reverts while paused, succeeds after unpause', async function () {
      const [rev, ts] = await subject.getRevenue()
      expect(rev).to.equal(0n)
      expect(ts).to.equal(0n)

      await subject.pause()
      await expect(subject.getRevenue()).to.be.revertedWith('Pausable: paused')

      await subject.unpause()
      const [rev2, ts2] = await subject.getRevenue()
      expect(rev2).to.equal(0n)
      expect(ts2).to.equal(0n)
    })

    it('pushTokenRate: succeeds before pause, reverts while paused, succeeds after unpause', async function () {
      await setStEthFeedPrice(STETH_FEED_PRICE)

      const rate1 = SEED_RATE + TOKEN_RATE_SCALE / 10n
      await wstEthStub.setRate(rate1)
      await accountingOracleStub.setLastProcessingRefSlot(DEFAULT_REF_SLOT)
      await expect(subject.pushTokenRate()).to.emit(subject, 'RevenueUpdated')

      await subject.pause()
      await wstEthStub.setRate(rate1 + TOKEN_RATE_SCALE / 10n)
      await expect(subject.pushTokenRate()).to.be.revertedWith('Pausable: paused')

      await subject.unpause()
      await expect(subject.pushTokenRate()).to.emit(subject, 'RevenueUpdated')
    })

    it('pausing does not alter stored revenue or timestamp', async function () {
      await setStEthFeedPrice(STETH_FEED_PRICE)
      await wstEthStub.setRate(SEED_RATE + TOKEN_RATE_SCALE / 10n)
      await subject.pushTokenRate()

      const [revBefore, tsBefore] = await subject.getRevenue()

      await subject.pause()
      await subject.unpause()

      const [revAfter, tsAfter] = await subject.getRevenue()
      expect(revAfter).to.equal(revBefore)
      expect(tsAfter).to.equal(tsBefore)
    })
  })

  describe('pushTokenRate — math precision:', function () {
    let localSnapshot: SnapshotRestorer

    beforeEach(async function () {
      localSnapshot = await takeSnapshot()
    })

    afterEach(async function () {
      await localSnapshot.restore()
    })

    it('large totalSupply (10B wstETH) produces correctly scaled output', async function () {
      // Feed at $3000 → oracle returns 3000 * 1e18
      const feedPrice3k = 3000n * 10n ** 8n
      const oraclePrice3k = 3000n * PRICE_SCALE
      const largeTotalSupply = 10_000_000_000n * PRICE_SCALE
      const refSlot = 500n

      await wstEthStub.setTotalSupply(largeTotalSupply)
      await setStEthFeedPrice(feedPrice3k)
      await accountingOracleStub.setLastProcessingRefSlot(refSlot)

      const newRate = SEED_RATE + TOKEN_RATE_SCALE / 10n
      await wstEthStub.setRate(newRate)

      const rateDelta = newRate - SEED_RATE
      const expectedRevenueStEth = (rateDelta * largeTotalSupply) / TOKEN_RATE_SCALE
      const expectedRevenueUsd = (expectedRevenueStEth * oraclePrice3k) / PRICE_SCALE
      const expectedTimestamp = GENESIS_TIME + SECONDS_PER_SLOT * refSlot

      await expect(subject.pushTokenRate())
        .to.emit(subject, 'RevenueUpdated')
        .withArgs(expectedRevenueUsd, expectedTimestamp)

      const [revenueUsd, reportTimestamp] = await subject.getRevenue()
      expect(revenueUsd).to.equal(expectedRevenueUsd)
      expect(reportTimestamp).to.equal(expectedTimestamp)
    })

    it('minimal delta (delta = 1 scale unit) with matching supply produces 1 wei revenueUsd', async function () {
      // (1 * TOKEN_RATE_SCALE) / TOKEN_RATE_SCALE = 1 stEth-unit
      // Feed at $1 → oracle returns 1 * 1e18 = PRICE_SCALE
      // (1 * PRICE_SCALE) / PRICE_SCALE = 1 USD-unit
      const feedPrice1 = 1n * 10n ** 8n // $1 in 8-decimal Chainlink format

      await wstEthStub.setTotalSupply(TOKEN_RATE_SCALE)
      await setStEthFeedPrice(feedPrice1)
      await accountingOracleStub.setLastProcessingRefSlot(DEFAULT_REF_SLOT)
      await wstEthStub.setRate(SEED_RATE + 1n)

      const expectedTimestamp = GENESIS_TIME + SECONDS_PER_SLOT * DEFAULT_REF_SLOT

      await expect(subject.pushTokenRate())
        .to.emit(subject, 'RevenueUpdated')
        .withArgs(1n, expectedTimestamp)

      const [revenueUsd, reportTimestamp] = await subject.getRevenue()
      expect(revenueUsd).to.equal(1n)
      expect(reportTimestamp).to.equal(expectedTimestamp)
    })
  })
})
