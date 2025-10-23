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

const contracts = getContracts()

describe('OracleRouter - Fuzz Tests', () => {
  let oracleRouter: OracleRouter
  let snapshot: SnapshotRestorer

  const feedConfig = {
    tokens: [contracts.STETH, contracts.DAI],
    useRealPrices: true,
  }

  before(async () => {
    snapshot = await takeSnapshot()

    const stub = await getTestFeedRegistryStub(feedConfig)
    await refreshFeedData(feedConfig)

    const factory = await ethers.getContractFactory('OracleRouter')
    oracleRouter = await factory.deploy(contracts.AGENT, 18, await stub.getAddress())
    await oracleRouter.waitForDeployment()

    const signer = await ethers.getImpersonatedSigner(contracts.AGENT)
    await (
      await ethers.getSigners()
    )[0].sendTransaction({
      to: contracts.AGENT,
      value: ethers.parseEther('1'),
    })

    await oracleRouter.connect(signer).setTokenUsdFeed(contracts.STETH, 86400, 18, true)
    await oracleRouter.connect(signer).setTokenUsdFeed(contracts.DAI, 86400, 18, true)
  })

  describe('Price validation', () => {
    it('should reject zero prices', async () => {
      const localSnapshot = await takeSnapshot()

      const nowTs = BigInt(Math.floor(Date.now() / 1000))
      await updateTokenFeed(feedConfig, contracts.STETH, contracts.CHAINLINK_USD_QUOTE, {
        answer: 0n,
        updatedAt: nowTs,
        startedAt: nowTs,
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

          const nowTs = BigInt(Math.floor(Date.now() / 1000))
          await updateTokenFeed(feedConfig, contracts.STETH, contracts.CHAINLINK_USD_QUOTE, {
            answer: price,
            updatedAt: nowTs,
            startedAt: nowTs,
            answeredInRound: 1n,
            roundId: 1n,
          })

          const [stethPrice] = await oracleRouter.getUsdPrices(contracts.STETH, contracts.DAI)
          expect(stethPrice).to.be.greaterThan(0)

          await localSnapshot.restore()
        }),
        { numRuns: 10 }
      )
    })
  })

  describe('Round data validation', () => {
    it('should reject unanswered rounds', async () => {
      await fc.assert(
        fc.asyncProperty(fc.bigInt({ min: 2n, max: 100n }), async (roundId) => {
          const localSnapshot = await takeSnapshot()

          const nowTs = BigInt(Math.floor(Date.now() / 1000))
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
        { numRuns: 10 }
      )
    })

    it('should accept valid rounds', async () => {
      await fc.assert(
        fc.asyncProperty(fc.bigInt({ min: 1n, max: 100n }), async (roundId) => {
          const localSnapshot = await takeSnapshot()

          const nowTs = BigInt(Math.floor(Date.now() / 1000))
          await updateTokenFeed(feedConfig, contracts.STETH, contracts.CHAINLINK_USD_QUOTE, {
            roundId,
            answeredInRound: roundId,
            updatedAt: nowTs,
            startedAt: nowTs,
          })

          const [price] = await oracleRouter.getUsdPrices(contracts.STETH, contracts.DAI)
          expect(price).to.be.greaterThan(0)

          await localSnapshot.restore()
        }),
        { numRuns: 10 }
      )
    })
  })

  after(async () => {
    await snapshot.restore()
    resetTestFeedRegistryStub()
  })
})
