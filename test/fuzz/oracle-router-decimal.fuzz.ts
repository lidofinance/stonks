import { ethers } from 'hardhat'
import { expect } from 'chai'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import { OracleRouter, OracleRouter__factory } from '../../typechain-types'
import {
  getTestFeedRegistryStub,
  getAllTestTokens,
  updateTokenFeed,
  resetTestFeedRegistryStub,
  refreshFeedData,
} from '../../utils/test-feed-registry'
import { getContracts } from '../../utils/contracts'
import { QuoteDenomination } from '../../utils/oracle-router'
import fc from 'fast-check'

const contracts = getContracts()

describe('OracleRouter Decimal Fuzzing', function () {
  let oracleRouterFactory: OracleRouter__factory
  let snapshot: SnapshotRestorer
  let agentAddress: string
  let feedRegistryAddress: string

  const feedConfig = {
    tokens: getAllTestTokens(),
    useRealPrices: true,
  }

  const getCurrentTimestamp = async (): Promise<bigint> => {
    const block = await ethers.provider.getBlock('latest')
    return BigInt(block!.timestamp)
  }

  const getAgentSigner = async () => {
    const agentSigner = await ethers.getImpersonatedSigner(agentAddress)
    await ethers.provider.send('hardhat_setBalance', [agentAddress, '0x1000000000000000000'])
    return agentSigner
  }

  const calculateExpectedPrice = (
    priceValue: bigint,
    feedDecimals: number,
    routerDecimals: number
  ): bigint => {
    if (feedDecimals === routerDecimals) return priceValue
    if (feedDecimals < routerDecimals)
      return priceValue * 10n ** BigInt(routerDecimals - feedDecimals)
    return priceValue / 10n ** BigInt(feedDecimals - routerDecimals)
  }

  before(async function () {
    snapshot = await takeSnapshot()
    oracleRouterFactory = await ethers.getContractFactory('OracleRouter')
    agentAddress = contracts.AGENT
    const stub = await getTestFeedRegistryStub(feedConfig)
    feedRegistryAddress = await stub.getAddress()
  })

  beforeEach(async function () {
    await refreshFeedData(feedConfig)
  })

  after(async function () {
    await snapshot.restore()
    resetTestFeedRegistryStub()
  })

  describe('Decimal Configuration Fuzzing', function () {
    it('should handle arbitrary decimal configurations and verify correct conversions', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            // Test common DeFi configurations: 6, 8, 18 decimals
            routerDecimals: fc.constantFrom(6, 8, 18),
            feedDecimals: fc.constant(8),
            tokenDecimals: fc.constant(18),
            priceValue: fc.bigInt(4000000n, 1000000000n),
          }),
          async (config) => {
            const { routerDecimals, feedDecimals, tokenDecimals, priceValue } = config

            const testSnapshot = await takeSnapshot()
            const agentSigner = await getAgentSigner()
            const router = await oracleRouterFactory.deploy(
              agentAddress,
              routerDecimals,
              feedRegistryAddress
            )
            await router.waitForDeployment()
            await router.connect(agentSigner).setEthUsdBridge(86_400)
            await router
              .connect(agentSigner)
              .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86_400, true)

            const nowTs = await getCurrentTimestamp()
            await updateTokenFeed(feedConfig, contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
              answer: priceValue,
              updatedAt: nowTs,
              roundId: 1n,
              answeredInRound: 1n,
              decimals: feedDecimals,
            })

            const [basePrice, quotePrice] = await router.getUsdPrices(contracts.DAI, contracts.DAI)

            expect(basePrice).to.be.greaterThan(0, 'Price should be positive')
            expect(basePrice).to.equal(quotePrice, 'Same token should have equal prices')

            if (priceValue > 0n) {
              expect(basePrice).to.be.greaterThan(
                0,
                'Non-zero input should produce non-zero output'
              )
            }

            expect(basePrice).to.be.lessThan(ethers.MaxUint256, 'Price should not overflow')
            const expectedPrice = calculateExpectedPrice(priceValue, feedDecimals, routerDecimals)
            const tolerance = expectedPrice / 100n
            expect(basePrice).to.be.closeTo(
              expectedPrice,
              tolerance,
              `Price should match expected value. Expected: ${expectedPrice}, Got: ${basePrice}, FeedDecimals: ${feedDecimals}, RouterDecimals: ${routerDecimals}`
            )

            await testSnapshot.restore()
          }
        ),
        { numRuns: 100 }
      )
    })
  })
})
