import { ethers } from 'hardhat'
import { expect } from 'chai'
import { takeSnapshot, SnapshotRestorer, time } from '@nomicfoundation/hardhat-network-helpers'
import fc from 'fast-check'
import { Order, Stonks } from '../../typechain-types'
import { getTestOracleRouter, resetTestOracleRouter } from '../../utils/test-oracle-router'
import { getAllTestTokens, refreshTestFeedData } from '../../utils/test-feed-registry'
import { deployStonks } from '../../scripts/deployments/stonks'
import { getContracts } from '../../utils/contracts'
import { fillUpERC20FromTreasury } from '../../utils/fill-up-balance'
import { getPlaceOrderData } from '../../utils/get-events'

const contracts = getContracts()
const PRICE_TOLERANCE_IN_BP = 1000

describe('Order - Fuzz Tests', () => {
  let stonks: Stonks
  let order: Order
  let snapshot: SnapshotRestorer

  before(async () => {
    snapshot = await takeSnapshot()
    const manager = (await ethers.getSigners())[0]

    const oracleRouter = await getTestOracleRouter({
      tokens: getAllTestTokens(),
      useRealPrices: true,
    })

    await refreshTestFeedData(getAllTestTokens())

    const { stonks: stonksInstance } = await deployStonks({
      factoryParams: {
        agent: contracts.AGENT,
        relayer: contracts.VAULT_RELAYER,
        settlement: contracts.SETTLEMENT,
        priceFeedRegistry: contracts.CHAINLINK_PRICE_FEED_REGISTRY,
        oracleRouterAddress: await oracleRouter.getAddress(),
      },
      stonksParams: {
        tokenFrom: contracts.STETH,
        tokenTo: contracts.DAI,
        manager: await manager.getAddress(),
        marginInBps: 500,
        orderDuration: 3600,
        priceToleranceInBps: PRICE_TOLERANCE_IN_BP,
        amountConverterAddress: undefined,
      },
      amountConverterParams: {
        oracleRouter: await oracleRouter.getAddress(),
        allowedTokensToSell: [contracts.STETH],
        allowedStableTokensToBuy: [contracts.DAI],
      },
    })

    stonks = stonksInstance

    await fillUpERC20FromTreasury({
      token: contracts.STETH,
      amount: ethers.parseEther('1'),
      address: await stonks.getAddress(),
    })

    const expectedBuyAmount = await stonks.estimateTradeOutputFromCurrentBalance()
    const placeOrderTx = await stonks.placeOrder(expectedBuyAmount)
    const placeOrderTxReceipt = await placeOrderTx.wait()

    const { address } = await getPlaceOrderData(placeOrderTxReceipt!)
    order = await ethers.getContractAt('Order', address)
  })

  describe('Time-based validation', () => {
    it('should be valid before expiration', async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 3599 }), async (secondsBeforeExpiry) => {
          const localSnapshot = await takeSnapshot()

          await time.increase(secondsBeforeExpiry)

          const [orderHash] = await order.getOrderDetails()
          const isValid = await order.isValidSignature(orderHash, '0x')
          expect(isValid).to.not.equal('0x00000000')

          await localSnapshot.restore()
        }),
        { numRuns: 10 }
      )
    })

    it('should be invalid after expiration', async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 3601, max: 10000 }), async (secondsAfterExpiry) => {
          const localSnapshot = await takeSnapshot()

          await time.increase(secondsAfterExpiry)

          const [orderHash] = await order.getOrderDetails()
          await expect(order.isValidSignature(orderHash, '0x')).to.be.revertedWithCustomError(
            order,
            'OrderExpired'
          )

          await localSnapshot.restore()
        }),
        { numRuns: 10 }
      )
    })
  })

  after(async () => {
    await snapshot.restore()
    resetTestOracleRouter()
  })
})
