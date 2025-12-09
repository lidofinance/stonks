import { ethers } from 'hardhat'
import { expect } from 'chai'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import fc from 'fast-check'
import { OracleRouter } from '../../typechain-types'
import {
  getTestFeedRegistryStub,
  updateTokenFeed,
  resetTestFeedRegistryStub,
  refreshFeedData,
} from '../../utils/test-feed-registry'
import { getContracts } from '../../utils/contracts'
import { QuoteDenomination } from '../../utils/oracle-router'

const contracts = getContracts()

describe('OracleRouter - Fuzz Tests', () => {
  let oracleRouter: OracleRouter
  let snapshot: SnapshotRestorer
  const runs = 100
  const currentChainTs = async (): Promise<bigint> => {
    const blk = await ethers.provider.getBlock('latest')
    return BigInt(blk!.timestamp)
  }

  const feedConfig = {
    tokens: [contracts.STETH, contracts.DAI],
    useRealPrices: true,
  }

  before(async () => {
    snapshot = await takeSnapshot()

    const stub = await getTestFeedRegistryStub(feedConfig)
    await refreshFeedData(feedConfig)

    const factory = await ethers.getContractFactory('OracleRouter')
    oracleRouter = await factory.deploy(contracts.ADMIN, await stub.getAddress())
    await oracleRouter.waitForDeployment()

    await ethers.provider.send('hardhat_setBalance', [
      contracts.ADMIN,
      '0x56BC75E2D63100000', // 100 ETH
    ])
    await ethers.provider.send('hardhat_impersonateAccount', [contracts.ADMIN])
    const signer = await ethers.getSigner(contracts.ADMIN)

    await oracleRouter
      .connect(signer)
      .setTokenFeed(contracts.STETH, QuoteDenomination.USD, 86400, true)
    await oracleRouter
      .connect(signer)
      .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, true)
  })

  describe('Price validation', () => {
    it('should reject zero prices', async () => {
      const localSnapshot = await takeSnapshot()

      const nowTs = BigInt(Math.floor(Date.now() / 1000))
      await updateTokenFeed(feedConfig, contracts.STETH, contracts.CHAINLINK_USD_QUOTE, {
        answer: 0n,
        updatedAt: nowTs,
        startedAt: nowTs,
        roundId: 1n,
        answeredInRound: 1n,
      })

      await expect(
        oracleRouter.getUsdPrices(contracts.STETH, contracts.DAI)
      ).to.be.revertedWithCustomError(oracleRouter, 'OracleBadAnswer')

      await localSnapshot.restore()
    })

    it('should reject negative prices', async () => {
      const localSnapshot = await takeSnapshot()

      const nowTs = BigInt(Math.floor(Date.now() / 1000))
      await updateTokenFeed(feedConfig, contracts.STETH, contracts.CHAINLINK_USD_QUOTE, {
        answer: -1n,
        updatedAt: nowTs,
        startedAt: nowTs,
        roundId: 1n,
        answeredInRound: 1n,
      })

      await expect(
        oracleRouter.getUsdPrices(contracts.STETH, contracts.DAI)
      ).to.be.revertedWithCustomError(oracleRouter, 'OracleBadAnswer')

      await localSnapshot.restore()
    })

    it('should accept positive prices across range', async () => {
      await fc.assert(
        fc.asyncProperty(fc.bigInt({ min: 1n, max: 10n ** 18n }), async (price) => {
          const localSnapshot = await takeSnapshot()

          const block = await ethers.provider.getBlock('latest')
          const nowTs = BigInt(block!.timestamp)
          await updateTokenFeed(feedConfig, contracts.STETH, contracts.CHAINLINK_USD_QUOTE, {
            answer: price,
            updatedAt: nowTs,
            startedAt: nowTs,
            roundId: 1n,
            answeredInRound: 1n,
          })

          // Also update DAI feed to ensure it has proper round data
          await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
            answer: 1000000000000000000n, // 1 USD in 18 decimals
            updatedAt: nowTs,
            startedAt: nowTs,
            roundId: 1n,
            answeredInRound: 1n,
          })

          const [stethPrice] = await oracleRouter.getUsdPrices(contracts.STETH, contracts.DAI)
          // Feed has 8 decimals, router expects more, scale up
          const feedDecimals = 8
          const priceDecimals = await oracleRouter.PRICE_DECIMALS()
          const scaleFactor = 10n ** BigInt(Math.abs(Number(feedDecimals) - Number(priceDecimals)))
          const expectedPrice =
            feedDecimals < priceDecimals ? price * scaleFactor : price / scaleFactor
          expect(stethPrice).to.equal(expectedPrice)

          await localSnapshot.restore()
        }),
        { numRuns: runs }
      )
    })
  })

  describe('Round data validation', () => {
    it('should reject unanswered rounds', async () => {
      await fc.assert(
        fc.asyncProperty(fc.bigInt({ min: 2n, max: 100n }), async (roundId) => {
          const localSnapshot = await takeSnapshot()

          const block = await ethers.provider.getBlock('latest')
          const nowTs = BigInt(block!.timestamp)
          await updateTokenFeed(feedConfig, contracts.STETH, contracts.CHAINLINK_USD_QUOTE, {
            roundId,
            answeredInRound: roundId - 1n,
            updatedAt: nowTs,
            startedAt: nowTs,
          })

          await expect(
            oracleRouter.getUsdPrices(contracts.STETH, contracts.DAI)
          ).to.be.revertedWithCustomError(oracleRouter, 'OracleUnanswered')

          await localSnapshot.restore()
        }),
        { numRuns: runs }
      )
    })

    it('should accept valid rounds', async () => {
      await fc.assert(
        fc.asyncProperty(fc.bigInt({ min: 1n, max: 100n }), async (roundId) => {
          const localSnapshot = await takeSnapshot()

          const block = await ethers.provider.getBlock('latest')
          const nowTs = BigInt(block!.timestamp)
          await updateTokenFeed(feedConfig, contracts.STETH, contracts.CHAINLINK_USD_QUOTE, {
            roundId,
            answeredInRound: roundId,
            updatedAt: nowTs,
            startedAt: nowTs,
            answer: 100000000n, // 1 USD in 8 decimals
          })

          // Also update DAI feed to ensure it has proper round data
          await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
            roundId,
            answeredInRound: roundId,
            updatedAt: nowTs,
            startedAt: nowTs,
            answer: 100000000n, // 1 USD in 8 decimals
          })

          const [price] = await oracleRouter.getUsdPrices(contracts.STETH, contracts.DAI)
          // Both feeds have 8 decimals and answer 1 USD, so normalized = 1 * 10^10
          const feedDecimals = 8
          const priceDecimals = await oracleRouter.PRICE_DECIMALS()
          const scaleFactor = 10n ** BigInt(Math.abs(Number(feedDecimals) - Number(priceDecimals)))
          const expectedPrice =
            feedDecimals < priceDecimals
              ? 100000000n * scaleFactor // Scale up when feed has fewer decimals
              : 100000000n / scaleFactor // Scale down when feed has more decimals
          expect(price).to.equal(expectedPrice)

          await localSnapshot.restore()
        }),
        { numRuns: runs }
      )
    })
  })

  describe('ETH bridge and staleness', () => {
    it('uses ETH/USD bridge and respects staleness cap', async () => {
      const local = await takeSnapshot()
      const signer = await ethers.getImpersonatedSigner(contracts.ADMIN)

      // Configure bridge and set ETH-quoted feeds where available
      await oracleRouter.connect(signer).setEthUsdBridge(86_400)
      await oracleRouter
        .connect(signer)
        .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86_400, true)

      const nowTs = await currentChainTs()

      // Fresh ETH/USD → should succeed
      await updateTokenFeed(
        feedConfig,
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE,
        {
          updatedAt: nowTs,
          startedAt: nowTs,
          roundId: 1n,
          answeredInRound: 1n,
        }
      )

      await expect(oracleRouter.getUsdPrices(contracts.STETH, contracts.DAI)).to.not.be.reverted

      // Make ETH/USD stale beyond cap → should revert OracleStale
      const stale = nowTs - 86_401n
      await updateTokenFeed(
        feedConfig,
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE,
        {
          updatedAt: stale,
          startedAt: stale,
          roundId: 2n,
          answeredInRound: 2n,
        }
      )

      await expect(
        oracleRouter.getUsdPrices(contracts.STETH, contracts.DAI)
      ).to.be.revertedWithCustomError(oracleRouter, 'OracleStale')

      await local.restore()
    })

    it('per-token ETH/USD staleness override applies (smaller cap)', async () => {
      const local = await takeSnapshot()
      const signer = await ethers.getImpersonatedSigner(contracts.ADMIN)
      await oracleRouter.connect(signer).setEthUsdBridge(86_400)
      await oracleRouter
        .connect(signer)
        .setTokenFeed(contracts.STETH, QuoteDenomination.ETH, 86_400, true)
      // Override to tighter cap
      await oracleRouter.connect(signer).setTokenEthUsdStalenessOverride(contracts.STETH, 60)

      const nowTs = await currentChainTs()
      // ETH/USD updated 61s ago → should be stale due to override
      const ethAgo61 = nowTs - 61n
      await updateTokenFeed(
        feedConfig,
        contracts.CHAINLINK_ETH_QUOTE,
        contracts.CHAINLINK_USD_QUOTE,
        {
          updatedAt: ethAgo61,
          startedAt: ethAgo61,
          roundId: 3n,
          answeredInRound: 3n,
        }
      )

      await expect(
        oracleRouter.getUsdPrices(contracts.STETH, contracts.DAI)
      ).to.be.revertedWithCustomError(oracleRouter, 'OracleStale')

      await local.restore()
    })

    it('direct USD feed staleness fuzz', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 3_600 }),
          fc.integer({ min: 30, max: 86_400 }),
          async (ageSec, capSec) => {
            const local = await takeSnapshot()
            const signer = await ethers.getImpersonatedSigner(contracts.ADMIN)
            await oracleRouter
              .connect(signer)
              .setTokenFeed(contracts.STETH, QuoteDenomination.USD, 86_400, true)
            await oracleRouter
              .connect(signer)
              .setTokenFeed(contracts.DAI, QuoteDenomination.USD, capSec, true)

            const nowTs = await currentChainTs()
            await updateTokenFeed(feedConfig, contracts.STETH, contracts.CHAINLINK_USD_QUOTE, {
              updatedAt: nowTs,
              startedAt: nowTs,
              roundId: 1n,
              answeredInRound: 1n,
              answer: 100000000n,
            })
            const ts = nowTs - BigInt(ageSec)
            await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
              updatedAt: ts,
              startedAt: ts,
              roundId: 10n,
              answeredInRound: 10n,
              answer: 100000000n,
            })

            const call = oracleRouter.getUsdPrices(contracts.STETH, contracts.DAI)
            if (ageSec > capSec) {
              await expect(call).to.be.revertedWithCustomError(oracleRouter, 'OracleStale')
            } else {
              await expect(call).to.not.be.reverted
            }

            await local.restore()
          }
        ),
        { numRuns: runs }
      )
    })
  })

  after(async () => {
    await snapshot.restore()
    resetTestFeedRegistryStub()
  })
})
