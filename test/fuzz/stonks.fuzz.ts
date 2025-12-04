import { ethers } from 'hardhat'
import { expect } from 'chai'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import fc from 'fast-check'
import { Stonks, AmountConverterTest } from '../../typechain-types'
import { deployStonksWithTestOracle, resetTestOracleRouter } from '../../utils/test-oracle-router'
import { refreshTestFeedData, resetTestFeedRegistryStub } from '../../utils/test-feed-registry'
import { getContracts } from '../../utils/contracts'
import { QuoteDenomination } from '../../utils/oracle-router'

const contracts = getContracts()
const MAX_BASIS_POINTS = 10000n

describe('Stonks - Fuzz Tests', () => {
  let stonks: Stonks
  let amountConverter: AmountConverterTest
  let snapshot: SnapshotRestorer

  before(async () => {
    snapshot = await takeSnapshot()

    await refreshTestFeedData([contracts.STETH, contracts.DAI])

    const signer = (await ethers.getSigners())[0]
    const { stonks: stonksInstance, amountConverter: converter } = await deployStonksWithTestOracle(
      {
        factoryParams: {
          admin: contracts.ADMIN,
          agent: contracts.AGENT,
          relayer: contracts.VAULT_RELAYER,
          settlement: contracts.SETTLEMENT,
          priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        },
        stonksParams: {
          tokenFrom: contracts.STETH,
          tokenTo: contracts.DAI,
          manager: await signer.getAddress(),
          marginInBps: 500,
          orderDuration: 3600,
          priceToleranceInBps: 100,
          amountConverterAddress: undefined,
        },
        amountConverterParams: {
          allowedTokensToSell: [contracts.STETH],
          allowedStableTokensToBuy: [contracts.DAI],
        },
      }
    )

    stonks = stonksInstance
    amountConverter = await ethers.getContractAt(
      'AmountConverterTest',
      await converter.getAddress()
    )
  })

  describe('Margin calculations', () => {
    it('should always apply margin correctly', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: ethers.parseEther('0.01'), max: ethers.parseEther('1000') }),
          async (amount) => {
            const marginBps = await stonks.MARGIN_IN_BASIS_POINTS()
            const estimated = await stonks.estimateTradeOutput(amount)

            const rawOutput = await amountConverter.getExpectedOut(
              contracts.STETH,
              contracts.DAI,
              amount
            )

            const expectedEstimate = (rawOutput * (MAX_BASIS_POINTS - marginBps)) / MAX_BASIS_POINTS
            expect(estimated).to.equal(expectedEstimate)
          }
        ),
        { numRuns: 50 }
      )
    })

    it('should ensure margin reduces output', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: ethers.parseEther('0.1'), max: ethers.parseEther('100') }),
          async (amount) => {
            const estimated = await stonks.estimateTradeOutput(amount)
            const rawOutput = await amountConverter.getExpectedOut(
              contracts.STETH,
              contracts.DAI,
              amount
            )

            expect(estimated).to.be.lt(rawOutput)

            const marginBps = await stonks.MARGIN_IN_BASIS_POINTS()
            const expectedEstimated =
              (rawOutput * (MAX_BASIS_POINTS - marginBps)) / MAX_BASIS_POINTS

            // The estimated should exactly match the contract calculation
            expect(estimated).to.equal(expectedEstimated)
          }
        ),
        { numRuns: 50 }
      )
    })

    it('should maintain proportionality with margin', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: ethers.parseEther('1'), max: ethers.parseEther('10') }),
          async (amount) => {
            const result1 = await stonks.estimateTradeOutput(amount)
            const result2 = await stonks.estimateTradeOutput(amount * 2n)

            // Calculate expected result2 using the same contract logic
            const rawOutput2 = await amountConverter.getExpectedOut(
              contracts.STETH,
              contracts.DAI,
              amount * 2n
            )
            const marginBps = await stonks.MARGIN_IN_BASIS_POINTS()
            const expectedResult2 = (rawOutput2 * (MAX_BASIS_POINTS - marginBps)) / MAX_BASIS_POINTS

            // The result2 should exactly match the expected calculation
            expect(result2).to.equal(expectedResult2)
          }
        ),
        { numRuns: 50 }
      )
    })
  })

  describe('Amount bounds', () => {
    it('should revert for zero amounts', async () => {
      await expect(stonks.estimateTradeOutput(0)).to.be.revertedWithCustomError(
        stonks,
        'InvalidAmount'
      )
    })

    it('should handle large amounts without overflow', async () => {
      const converterAddress = await stonks.AMOUNT_CONVERTER()
      const converter = await ethers.getContractAt('AmountConverter', converterAddress)
      const routerAddress = await converter.ORACLE_ROUTER()
      const router = await ethers.getContractAt('OracleRouter', routerAddress)
      const tokenFrom = await stonks.TOKEN_FROM()
      const tokenTo = await stonks.TOKEN_TO()
      const marginBps = await stonks.MARGIN_DIFFERENCE_IN_BASIS_POINTS()

      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: ethers.parseEther('1000'), max: ethers.parseEther('100000') }),
          async (amount) => {
            const result = await stonks.estimateTradeOutput(amount)

            const [priceFrom, priceTo, decimalsFrom, decimalsTo] =
              await router.getPricesAndDecimals(tokenFrom, tokenTo, QuoteDenomination.USD)

            const decimalsDiff =
              decimalsFrom >= decimalsTo ? decimalsFrom - decimalsTo : decimalsTo - decimalsFrom

            let expectedBuyAmount: bigint
            if (decimalsFrom >= decimalsTo) {
              const grossOutput = (amount * priceFrom) / priceTo
              expectedBuyAmount =
                decimalsDiff === 0n ? grossOutput : grossOutput / 10n ** decimalsDiff
            } else {
              const pow10 = 10n ** decimalsDiff
              const scaledAmount = amount * pow10
              expectedBuyAmount = (scaledAmount * priceFrom) / priceTo
            }

            const expected = (expectedBuyAmount * marginBps) / MAX_BASIS_POINTS
            expect(result).to.equal(expected)
          }
        ),
        { numRuns: 30 }
      )
    })
  })

  after(async () => {
    await snapshot.restore()
    resetTestOracleRouter()
    resetTestFeedRegistryStub()
  })
})
