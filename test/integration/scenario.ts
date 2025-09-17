import { ethers, network } from 'hardhat'
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs'
import { expect } from 'chai'
import { parseEther, Signer, TransactionReceipt } from 'ethers'
import {
  setBalance,
  impersonateAccount,
  setCode,
  takeSnapshot,
  SnapshotRestorer,
  time,
} from '@nomicfoundation/hardhat-network-helpers'
import { setup, setupOverDeployedContracts, pairs, TokenPair, Setup } from './setup'
import { isClose } from '../../utils/assert'
import { mainnet, getContracts } from '../../utils/contracts'
import { IERC20, Stonks, Order } from '../../typechain-types'
import { MAGIC_VALUE } from '../../utils/gpv2-helpers'
import { getPlaceOrderData } from '../../utils/get-events'

const deployedContracts: string[] = []
const testItems: Array<TokenPair | string> = deployedContracts.length ? deployedContracts : pairs
const contracts = getContracts()

describe('Scenario test multi-pair', function () {
  testItems.forEach((item) => {
    const isStonksDeployed = typeof item === 'string'

    describe(`${isStonksDeployed ? item : (item as TokenPair).name}`, function () {
      let snapshot: SnapshotRestorer
      let snapshotOrderPlaced: SnapshotRestorer
      let value: bigint
      let stonks: Stonks
      let manager: Signer
      let tokenFrom: IERC20
      let expectedBuyAmount: bigint
      let orderReceipt: TransactionReceipt
      let order: Order
      // Always fetch the on-chain hash right before signature checks to avoid drift

      this.beforeAll(async () => {
        snapshot = await takeSnapshot()

        let result: Setup

        if (isStonksDeployed) {
          result = await setupOverDeployedContracts(item as string)
        } else {
          result = await setup(item as TokenPair)
        }

        stonks = result.stonks
        value = result.value
        manager = result.manager

        tokenFrom = await ethers.getContractAt('IERC20', await stonks.TOKEN_FROM())

        await setBalance(await manager.getAddress(), parseEther('100'))
        await setBalance(contracts.AGENT, parseEther('100'))
      })

      context('Setup', () => {
        it('agent should fill up a stonks with tokenFrom (EasyTrack imitation)', async function () {
          const treasurySigner = await ethers.provider.getSigner(contracts.AGENT)
          const token = tokenFrom.connect(treasurySigner)
          const currentBalance = await token.balanceOf(stonks)

          if (currentBalance > 0) {
            value = currentBalance
            this.skip()
          }

          await impersonateAccount(contracts.AGENT)

          const transferTx = await token.transfer(stonks, value)
          await transferTx.wait()

          expect(isClose(await token.balanceOf(stonks), value, 1n)).to.be.true
        })

        it('manager should successfully place an order', async () => {
          expectedBuyAmount = await stonks.estimateTradeOutputFromCurrentBalance()
          const orderTx = await stonks.placeOrder(expectedBuyAmount)

          orderReceipt = (await orderTx.wait())!
          if (!orderReceipt) throw new Error('No order receipt')

          const { address } = await getPlaceOrderData(orderReceipt)

          order = await ethers.getContractAt('Order', address)
          expect(isClose(await tokenFrom.balanceOf(address), value, 2n)).to.be.true
          expect(isClose(await tokenFrom.balanceOf(stonks), BigInt(0), 2n)).to.be.true

          const [orderHashFromContract] = await order.getOrderDetails()
          expect(orderHashFromContract).to.match(/^0x[0-9a-fA-F]{64}$/)
        })

        after(async () => {
          snapshotOrderPlaced = await takeSnapshot()
        })
      })

      context('Successful trade', () => {
        it('settlement should successfully check hash (isValidSignature)', async () => {
          const [currentHash] = await order.getOrderDetails()
          expect(await order.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
          await expect(order.isValidSignature(ethers.ZeroHash, '0x'))
            .to.be.revertedWithCustomError(order, 'InvalidOrderHash')
            .withArgs(currentHash, ethers.ZeroHash)
        })

        it('settlement should pull off assets from order contract (swap imitation)', async () => {
          await setCode(contracts.VAULT_RELAYER, ethers.ZeroHash)
          await setBalance(contracts.VAULT_RELAYER, ethers.parseEther('100'))
          await impersonateAccount(contracts.VAULT_RELAYER)

          const relayerSigner = await ethers.provider.getSigner(contracts.VAULT_RELAYER)
          const stethWithRelayerSigner = tokenFrom.connect(relayerSigner)

          await stethWithRelayerSigner.transferFrom(
            order,
            contracts.VAULT_RELAYER,
            await stethWithRelayerSigner.balanceOf(order)
          )

          expect(isClose(await stethWithRelayerSigner.balanceOf(order), BigInt(0), 1n)).to.be.true
        })
      })

      context('Order expired', () => {
        before(async () => {
          await snapshotOrderPlaced.restore()
        })
        it('should not be possible to cancel order due to expiration time', async () => {
          const orderDetails = await order.getOrderDetails()
          await expect(order.recoverTokenFrom())
            .to.be.revertedWithCustomError(order, 'OrderNotExpired')
            .withArgs(orderDetails[5], anyValue)
        })
        it('should be possible to recover tokenFrom after expiration time', async () => {
          await network.provider.send('evm_increaseTime', [
            Number(await stonks.ORDER_DURATION_IN_SECONDS()) + 1,
          ])
          await order.recoverTokenFrom()

          expect(isClose(await tokenFrom.balanceOf(order), BigInt(0), 1n)).to.be.true
        })
        it('should be invalid after order expiration', async () => {
          const [currentHash, , , , , validTo] = await order.getOrderDetails()
          await expect(order.isValidSignature(currentHash, '0x'))
            .to.be.revertedWithCustomError(order, 'OrderExpired')
            .withArgs(validTo)
        })
      })

      context('Market price spike', () => {
        before(async () => {
          await snapshotOrderPlaced.restore()
        })
        it('settlement should successfully check hash', async () => {
          const [currentHash] = await order.getOrderDetails()
          expect(await order.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
          await expect(order.isValidSignature(ethers.ZeroHash, '0x'))
            .to.be.revertedWithCustomError(order, 'InvalidOrderHash')
            .withArgs(currentHash, ethers.ZeroHash)
        })
        it('should change stonks amount converter address', async () => {
          const feedRegistryStubFactory = await ethers.getContractFactory(
            'ChainlinkFeedRegistryStub'
          )
          const feedRegistryStub = await feedRegistryStubFactory.deploy(manager, manager)
          const feedRegistry = await ethers.getContractAt(
            'IFeedRegistry',
            contracts.CHAINLINK_PRICE_FEED_REGISTRY
          )
          const decimals = await feedRegistry.decimals(
            await stonks.TOKEN_FROM(),
            contracts.CHAINLINK_USD_QUOTE
          )
          const latestRoundData = await feedRegistry.latestRoundData(
            await stonks.TOKEN_FROM(),
            contracts.CHAINLINK_USD_QUOTE
          )
          // Pre-read ETH/USD feed for stub seeding
          const ethDecimals = await feedRegistry.decimals(
            contracts.CHAINLINK_ETH_QUOTE,
            contracts.CHAINLINK_USD_QUOTE
          )
          const ethLatest = await feedRegistry.latestRoundData(
            contracts.CHAINLINK_ETH_QUOTE,
            contracts.CHAINLINK_USD_QUOTE
          )
          // Pre-read QUOTE/USD feed BEFORE swapping the registry to avoid zero defaults
          const toDecimals = await feedRegistry.decimals(
            await stonks.TOKEN_TO(),
            contracts.CHAINLINK_USD_QUOTE
          )
          const toLatest = await feedRegistry.latestRoundData(
            await stonks.TOKEN_TO(),
            contracts.CHAINLINK_USD_QUOTE
          )

          await setCode(
            contracts.CHAINLINK_PRICE_FEED_REGISTRY,
            await ethers.provider.getCode(feedRegistryStub)
          )

          const feedRegistryStubReplaced = await ethers.getContractAt(
            'ChainlinkFeedRegistryStub',
            contracts.CHAINLINK_PRICE_FEED_REGISTRY
          )

          const baseLatest = BigInt(latestRoundData.answer)
          const baseOne = 10n ** BigInt(decimals)
          const baseSafe = baseLatest > 0n ? baseLatest : baseOne
          const tolBps = BigInt(await stonks.PRICE_TOLERANCE_IN_BASIS_POINTS())
          // Reduce price well beyond tolerance to guarantee downside failure
          const downFactor = 10000n - tolBps * 5n > 0n ? 10000n - tolBps * 5n : 1n
          const baseSpiked = (baseSafe * downFactor) / 10000n

          await feedRegistryStubReplaced.setFeed(
            await stonks.TOKEN_FROM(),
            contracts.CHAINLINK_USD_QUOTE,
            {
              answer: baseSpiked,
              updatedAt: 0n,
              startedAt: 0n,
              answeredInRound: latestRoundData.answeredInRound,
              roundId: latestRoundData.roundId,
              decimals: decimals,
            }
          )

          // Ensure quote token feed is present in stub as well (unchanged price)
          const quoteLatest = BigInt(toLatest.answer)
          const quoteOne = 10n ** BigInt(toDecimals)
          const quoteSafe = quoteLatest > 0n ? quoteLatest : quoteOne
          await feedRegistryStubReplaced.setFeed(
            await stonks.TOKEN_TO(),
            contracts.CHAINLINK_USD_QUOTE,
            {
              answer: quoteSafe,
              updatedAt: 0n,
              startedAt: 0n,
              answeredInRound: toLatest.answeredInRound,
              roundId: toLatest.roundId,
              decimals: toDecimals,
            }
          )

          // Seed ETH/USD in stub
          const ethLatestAns = BigInt(ethLatest.answer)
          const ethDefault = 2000n * 10n ** BigInt(ethDecimals)
          const ethSafe = ethLatestAns > 0n ? ethLatestAns : ethDefault
          await feedRegistryStubReplaced.setFeed(
            contracts.CHAINLINK_ETH_QUOTE,
            contracts.CHAINLINK_USD_QUOTE,
            {
              answer: ethSafe,
              updatedAt: 0n,
              startedAt: 0n,
              answeredInRound: ethLatest.answeredInRound,
              roundId: ethLatest.roundId,
              decimals: ethDecimals,
            }
          )

          const [currentHash] = await order.getOrderDetails()
          await expect(order.isValidSignature(currentHash, '0x')).to.be.revertedWithCustomError(
            order,
            'PriceConditionChanged'
          )
        })
        it('should be possible to recover tokenFrom after price spike', async () => {
          await time.increase((await stonks.ORDER_DURATION_IN_SECONDS()) + 1n)
          await order.recoverTokenFrom()

          expect(isClose(await tokenFrom.balanceOf(order), BigInt(0), 1n)).to.be.true
        })
        it('should create a new order for new market conditions', async () => {
          const expectedBuyAmount = await stonks.estimateTradeOutputFromCurrentBalance()
          const orderTx = await stonks.placeOrder(expectedBuyAmount)

          const orderReceipt = (await orderTx.wait())!
          if (!orderReceipt) throw new Error('No order receipt')

          const { address } = await getPlaceOrderData(orderReceipt)

          const newOrder = await ethers.getContractAt('Order', address)
          expect(isClose(await tokenFrom.balanceOf(address), value, 3n)).to.be.true
          expect(isClose(await tokenFrom.balanceOf(stonks), BigInt(0), 3n)).to.be.true

          const [orderHashFromContract] = await newOrder.getOrderDetails()
          expect(orderHashFromContract).to.match(/^0x[0-9a-fA-F]{64}$/)
          expect(await newOrder.getAddress()).to.not.be.equal(await order.getAddress())
        })
      })
      context('Manager change', () => {
        before(async () => {
          await snapshotOrderPlaced.restore()
        })
        it('agent should change a manager', async () => {
          const agent = await ethers.getSigner(contracts.AGENT)
          await stonks.connect(agent).setManager(ethers.ZeroAddress)
          expect(await stonks.manager()).to.be.equal(ethers.ZeroAddress)
        })
        it('manager should not be allowed to interact', async () => {
          await expect(stonks.placeOrder(1))
            .to.be.revertedWithCustomError(stonks, 'NotAgentOrManager')
            .withArgs(await manager.getAddress())
        })
      })
      context('Unexpected tokens', () => {
        let ldo: IERC20
        before(async () => {
          await snapshotOrderPlaced.restore()
        })
        it('should fill up stonks with unexpected token', async () => {
          const agent = await ethers.getSigner(contracts.AGENT)
          const value = parseEther('1')

          ldo = await ethers.getContractAt('IERC20', contracts.LDO)
          await ldo.connect(agent).transfer(stonks, value)

          expect(await ldo.balanceOf(stonks)).to.equal(value)
        })
        it('manager should recover unexpected token', async () => {
          const agentBalanceBefore = await ldo.balanceOf(contracts.AGENT)
          const value = await ldo.balanceOf(stonks)
          await stonks.connect(manager).recoverERC20(ldo, value)
          expect(await ldo.balanceOf(stonks)).to.equal(0)
          expect(await ldo.balanceOf(contracts.AGENT)).to.equal(agentBalanceBefore + value)
        })
        it('should fill up order contract with unexpected token', async () => {
          const value = parseEther('1')
          const agent = await ethers.getSigner(contracts.AGENT)
          await ldo.connect(agent).transfer(order, value)

          expect(isClose(await ldo.balanceOf(order), value, 1n))
        })
        it('manager should recover unexpected token from order contract', async () => {
          const agentBalanceBefore = await ldo.balanceOf(contracts.AGENT)
          const value = await ldo.balanceOf(order)
          await order.connect(manager).recoverERC20(ldo, value)
          expect(await ldo.balanceOf(stonks)).to.equal(0)
          expect(await ldo.balanceOf(contracts.AGENT)).to.equal(agentBalanceBefore + value)
        })
      })

      this.afterAll(async () => {
        await snapshot.restore()
      })
    })
  })
})
