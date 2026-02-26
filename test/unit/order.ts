import { ethers } from 'hardhat'
import { expect } from 'chai'
import { Signer } from 'ethers'
import {
  takeSnapshot,
  SnapshotRestorer,
  time,
  mine,
} from '@nomicfoundation/hardhat-network-helpers'
import { Order, Stonks, HashHelper, AmountConverterTest, OracleRouter } from '../../typechain-types'
import { getTestOracleRouter, resetTestOracleRouter } from '../../utils/test-oracle-router'
import {
  getAllTestTokens,
  refreshTestFeedData,
  resetTestFeedRegistryStub,
} from '../../utils/test-feed-registry'
import { deployStonks } from '../../scripts/deployments/stonks'
import { getContracts } from '../../utils/contracts'
import { MAGIC_VALUE, formOrderHashFromTxReceipt } from '../../utils/gpv2-helpers'
import { fillUpERC20FromTreasury } from '../../utils/fill-up-balance'
import { getPlaceOrderData } from '../../utils/get-events'
import { PlaceOrderDataEvent } from '../../utils/types'

const PRICE_TOLERANCE_IN_BP = 1000
const contracts = getContracts()

describe('Order', async function () {
  const marginInBps = 500
  let manager: Signer
  let stonks: Stonks
  let hashHelper: HashHelper
  let amountConverterTest: AmountConverterTest
  let oracleRouter: OracleRouter
  let snapshot: SnapshotRestorer
  let subject: Order
  let orderHash: string
  let orderData: PlaceOrderDataEvent
  let expectedBuyAmount: bigint

  before(async function () {
    snapshot = await takeSnapshot()
    manager = (await ethers.getSigners())[0]

    const amountConverterTestFactory = await ethers.getContractFactory('AmountConverterTest')

    oracleRouter = await getTestOracleRouter({
      tokens: getAllTestTokens(),
      useRealPrices: true,
    })

    await refreshTestFeedData(getAllTestTokens())

    amountConverterTest = await amountConverterTestFactory.deploy(
      await oracleRouter.getAddress(),
      [contracts.STETH],
      [contracts.DAI],
      false
    )
    await amountConverterTest.waitForDeployment()

    const { stonks: stonksInstance } = await deployStonks({
      factoryParams: {
        admin: contracts.ADMIN,
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
        marginInBps: marginInBps,
        orderDuration: 3600,
        priceToleranceInBps: PRICE_TOLERANCE_IN_BP,
        amountConverterAddress: await amountConverterTest.getAddress(),
      },
      amountConverterParams: {
        oracleRouter: await oracleRouter.getAddress(),
        allowedTokensToSell: [contracts.STETH],
        allowedTokensToBuy: [contracts.DAI],
      },
    })

    const HashHelperFactory = await ethers.getContractFactory('HashHelper')
    hashHelper = await HashHelperFactory.deploy()
    await hashHelper.waitForDeployment()

    stonks = stonksInstance

    await fillUpERC20FromTreasury({
      token: contracts.STETH,
      amount: ethers.parseEther('1'),
      address: await stonks.getAddress(),
    })

    // Ensure router-bound registry feeds are fresh to avoid staleness/answeredInRound issues
    const latest = await ethers.provider.getBlock('latest')
    const nowTs = BigInt(latest!.timestamp)

    const registryAddr = await oracleRouter.FEED_REGISTRY()
    const stub = await ethers.getContractAt('ChainlinkFeedRegistryStub', registryAddr)

    const seed = async (base: string, quote: string) => {
      const cur = await stub.feeds(base, quote)
      await stub.setFeed(base, quote, {
        aggregator:
          cur.aggregator !== ethers.ZeroAddress ? cur.aggregator : await stub.getAddress(),
        answer: cur.answer !== 0n ? cur.answer : 1n,
        updatedAt: nowTs,
        startedAt: nowTs,
        answeredInRound: 1n,
        roundId: 1n,
        decimals: cur.decimals !== 0n ? cur.decimals : 8n,
      })
    }
    await seed(contracts.CHAINLINK_ETH_QUOTE, contracts.CHAINLINK_USD_QUOTE)
    await seed(contracts.STETH, contracts.CHAINLINK_USD_QUOTE)
    await seed(contracts.DAI, contracts.CHAINLINK_USD_QUOTE)

    expectedBuyAmount = await stonks.estimateTradeOutputFromCurrentBalance()

    const placeOrderTx = await stonks.placeOrder(expectedBuyAmount)
    const placeOrderTxReceipt = await placeOrderTx.wait()
    if (!placeOrderTxReceipt) throw Error('placeOrderTxReceipt is null')

    const decodedOrderTx = await getPlaceOrderData(placeOrderTxReceipt)

    orderData = decodedOrderTx
    subject = await ethers.getContractAt('Order', orderData.address, manager)

    orderHash = await formOrderHashFromTxReceipt(placeOrderTxReceipt)
  })

  describe('initialization (direct):', function () {
    it('sample deployment should emit RelayerSet and DomainSeparatorSet events', async function () {
      const contractFactory = await ethers.getContractFactory('Order')

      const contract = await contractFactory.deploy(
        contracts.ADMIN,
        contracts.AGENT,
        contracts.VAULT_RELAYER,
        contracts.DOMAIN_SEPARATOR
      )

      await expect(contract.deploymentTransaction())
        .to.emit(contract, 'RelayerSet')
        .withArgs(contracts.VAULT_RELAYER)
        .to.emit(contract, 'DomainSeparatorSet')
        .withArgs(contracts.DOMAIN_SEPARATOR)
    })
    it('sample instance should have correct admin and agent addresses', async function () {
      const orderSample = await ethers.getContractAt('Order', await stonks.ORDER_SAMPLE())
      expect(await orderSample.ADMIN()).to.equal(contracts.ADMIN)
      expect(await orderSample.AGENT()).to.equal(contracts.AGENT)
    })
    it('sample instance should be initialized by default', async function () {
      const subject = await ethers.getContractAt('Order', await stonks.ORDER_SAMPLE())
      await expect(
        subject.initialize(expectedBuyAmount, ethers.ZeroAddress, contracts.AGENT)
      ).to.be.revertedWithCustomError(subject, 'OrderAlreadyInitialized')
    })
  })

  describe('initialization (from Stonks):', function () {
    it('should have correct admin and agent addresses', async function () {
      expect(await subject.ADMIN()).to.equal(contracts.ADMIN)
      expect(await subject.AGENT()).to.equal(contracts.AGENT)
    })
    it('should have correct order parameters', async function () {
      const [tokenFrom, tokenTo, orderDurationInSeconds] = await stonks.getOrderParameters()
      const token = await ethers.getContractAt('IERC20', tokenFrom)

      expect(await subject.stonks()).to.equal(await stonks.getAddress())
      expect(orderData.order.sellToken).to.equal(tokenFrom)
      expect(orderData.order.buyToken).to.equal(tokenTo)
      expect(orderData.order.sellAmount).to.equal(await token.balanceOf(subject))
      const buyAmountFromBalance = await stonks.estimateTradeOutputFromCurrentBalance()
      expect(orderData.order.buyAmount).to.equal(
        buyAmountFromBalance > expectedBuyAmount ? buyAmountFromBalance : expectedBuyAmount
      )
      expect(orderData.order.receiver).to.be.equal(contracts.AGENT)
      expect(BigInt(orderData.order.feeAmount)).to.be.equal(BigInt(0))
      expect(BigInt(orderData.order.validTo)).to.be.equal(
        BigInt(orderData.timestamp) + orderDurationInSeconds
      )
      expect(await subject.allowPartialFill()).to.equal(false)
      expect(await subject.cancelled()).to.equal(false)
    })
    it('should return correct params from getOrderDetails', async function () {
      const [tokenFromParam, tokenToParam, orderDurationInSeconds] =
        await stonks.getOrderParameters()
      const [orderHash, tokenFrom, tokenTo, receiver, sellAmount, buyAmount, validTo] =
        await subject.getOrderDetails()

      expect(orderHash).to.equal(orderData.hash)
      expect(tokenFrom).to.equal(tokenFromParam)
      expect(tokenTo).to.equal(tokenToParam)
      expect(receiver).to.equal(contracts.AGENT)
      expect(sellAmount).to.equal(orderData.order.sellAmount)
      expect(buyAmount).to.equal(orderData.order.buyAmount)
      expect(validTo).to.equal(BigInt(orderData.timestamp) + BigInt(orderDurationInSeconds))
    })
  })

  describe('receiver:', function () {
    it('default receiver (address(0) in InitParams) should be AGENT', async function () {
      expect(await stonks.RECEIVER()).to.equal(contracts.AGENT)
    })

    it('order receiver in GPv2Order data should equal Stonks RECEIVER (AGENT by default)', async function () {
      expect(orderData.order.receiver).to.equal(contracts.AGENT)
    })

    it('getOrderDetails should return AGENT as receiver when default', async function () {
      const [, , , receiver] = await subject.getOrderDetails()
      expect(receiver).to.equal(contracts.AGENT)
    })

    it('should revert initialize when receiver is zero address', async function () {
      const localSnapshot = await takeSnapshot()

      // Deploy an uninitialized EIP-1167 clone of the ORDER_SAMPLE directly so we can
      // call initialize ourselves (the sample contract marks itself initialized in its
      // constructor, so we must go through a fresh clone).
      const implAddr = await stonks.ORDER_SAMPLE()
      const eip1167Code =
        '0x3d602d80600a3d3981f3363d3d373d3d3d363d73' +
        implAddr.slice(2).toLowerCase() +
        '5af43d82803e903d91602b57fd5bf3'

      const [deployer] = await ethers.getSigners()
      const deployTx = await deployer.sendTransaction({ data: eip1167Code })
      const deployReceipt = await deployTx.wait()
      if (!deployReceipt?.contractAddress) throw new Error('Clone deploy failed')

      const clone = await ethers.getContractAt('Order', deployReceipt.contractAddress)

      // Impersonate an arbitrary address as msg.sender so stonks = msg.sender is valid
      const fakeStonksAddr = await stonks.getAddress()
      const fakeStonksSigner = await ethers.getImpersonatedSigner(fakeStonksAddr)
      await ethers.provider.send('hardhat_setBalance', [fakeStonksAddr, '0x1000000000000000000'])

      await expect(
        clone.connect(fakeStonksSigner).initialize(1n, contracts.AGENT, ethers.ZeroAddress)
      )
        .to.be.revertedWithCustomError(clone, 'InvalidReceiverAddress')
        .withArgs(ethers.ZeroAddress)

      await localSnapshot.restore()
    })

    it('Stonks with custom receiver should pass it to placed orders', async function () {
      const localSnapshot = await takeSnapshot()
      const [deployer] = await ethers.getSigners()
      const customReceiver = await deployer.getAddress()

      const { stonks: stonksCustom } = await deployStonks({
        factoryParams: {
          admin: contracts.ADMIN,
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
          amountConverterAddress: await amountConverterTest.getAddress(),
          receiver: customReceiver,
        },
        amountConverterParams: {
          oracleRouter: await oracleRouter.getAddress(),
          allowedTokensToSell: [contracts.STETH],
          allowedTokensToBuy: [contracts.DAI],
        },
        skipRouterConfiguration: true,
      })

      expect(await stonksCustom.RECEIVER()).to.equal(customReceiver)

      await fillUpERC20FromTreasury({
        token: contracts.STETH,
        amount: ethers.parseEther('1'),
        address: await stonksCustom.getAddress(),
      })

      const buyAmount = await stonksCustom.estimateTradeOutputFromCurrentBalance()
      const tx = await stonksCustom.placeOrder(buyAmount)
      const rc = await tx.wait()
      if (!rc) throw new Error('No receipt')

      const data = await getPlaceOrderData(rc)
      expect(data.order.receiver).to.equal(customReceiver)

      const orderContract = await ethers.getContractAt('Order', data.address)
      const [, , , receiverFromDetails] = await orderContract.getOrderDetails()
      expect(receiverFromDetails).to.equal(customReceiver)

      await localSnapshot.restore()
    })
  })

  describe('isValidSignature:', function () {
    let localSnapshot: SnapshotRestorer

    beforeEach(async function () {
      localSnapshot = await takeSnapshot()
    })

    it('should return magic value if order hash is valid', async function () {
      expect(await subject.isValidSignature(orderHash, '0x')).to.equal(MAGIC_VALUE)
    })
    it('should revert if order hash is invalid', async function () {
      await expect(subject.isValidSignature(ethers.ZeroHash, '0x')).to.be.revertedWithCustomError(
        subject,
        'InvalidOrderHash'
      )
    })
    it('should revert if order is expired', async function () {
      await time.increase(60 * 60 + 1)
      await mine()

      await expect(subject.isValidSignature(orderHash, '0x')).to.be.revertedWithCustomError(
        subject,
        'OrderExpired'
      )
    })
    it('should not revert if there was a price deterioration within tolerance', async function () {
      await amountConverterTest.multiplyAnswer(10000 - PRICE_TOLERANCE_IN_BP + 1)

      const [currentHash] = await subject.getOrderDetails()
      expect(await subject.isValidSignature(currentHash, '0x')).to.equal(MAGIC_VALUE)
    })
    it('should revert if there was a price spike', async function () {
      const orderDetails = await subject.getOrderDetails()
      const sellAmount = orderDetails[4]
      const buyAmount = orderDetails[5]
      const toleratedShortfall = (buyAmount * BigInt(PRICE_TOLERANCE_IN_BP)) / 10000n
      const minAcceptable = buyAmount - toleratedShortfall

      // Create a downside move beyond tolerance
      await amountConverterTest.multiplyAnswer(10000 - PRICE_TOLERANCE_IN_BP - 1)

      const currentCalculated = await stonks.estimateTradeOutput(sellAmount)
      const [currentHash] = await subject.getOrderDetails()

      await expect(subject.isValidSignature(currentHash, '0x'))
        .to.be.revertedWithCustomError(subject, 'PriceShortfallExceedsTolerance')
        .withArgs(minAcceptable, currentCalculated)
    })

    afterEach(async function () {
      await localSnapshot.restore()
    })
  })

  describe('recoverTokenFrom:', function () {
    let localSnapshot: SnapshotRestorer

    beforeEach(async function () {
      localSnapshot = await takeSnapshot()
    })
    it('should succesfully recover token from', async function () {
      const [tokenFrom] = await stonks.getOrderParameters()
      const subjectWithStranger = subject.connect((await ethers.getSigners())[4])

      await time.increase(60 * 60 + 1)

      const token = await ethers.getContractAt('IERC20', tokenFrom)
      const stonksBalanceBefore = await token.balanceOf(stonks)
      const orderBalanceBefore = await token.balanceOf(subjectWithStranger)

      const cancelTx = await subjectWithStranger.recoverTokenFrom()
      await cancelTx.wait()

      const stonksBalanceAfter = await token.balanceOf(stonks)
      const orderBalanceAfter = await token.balanceOf(subjectWithStranger)

      expect(stonksBalanceAfter).to.be.closeTo(stonksBalanceBefore + orderBalanceBefore, 1n)
      expect(orderBalanceAfter).to.be.closeTo(BigInt(0), 1n)
    })
    it('should revert if order is not expired', async function () {
      const orderDetails = await subject.getOrderDetails()
      const block = await ethers.provider.getBlockNumber()
      const timestamp = (await ethers.provider.getBlock(block))?.timestamp!

      await expect(subject.recoverTokenFrom())
        .to.be.revertedWithCustomError(subject, 'OrderNotExpired')
        .withArgs(orderDetails[6], timestamp + 1)
    })
    it('should revert if nothing to recover', async function () {
      await time.increase(60 * 60 + 1)

      await subject.recoverTokenFrom()
      await expect(subject.recoverTokenFrom()).to.be.revertedWithCustomError(
        subject,
        'InvalidAmountToRecover'
      )
    })
    afterEach(async function () {
      await localSnapshot.restore()
    })
  })

  describe('recoverERC20:', async function () {
    it('should revert if recover a token from', async function () {
      const [tokenFrom] = await stonks.getOrderParameters()
      await expect(subject.recoverERC20(tokenFrom, BigInt(1)))
        .revertedWithCustomError(subject, 'CannotRecoverTokenFrom')
        .withArgs(tokenFrom)
    })
    it('should revert if called by stranger', async function () {
      const amount = ethers.parseEther('1')
      await fillUpERC20FromTreasury({
        token: contracts.DAI,
        amount: amount,
        address: await subject.getAddress(),
      })
      const signer = (await ethers.getSigners())[4]
      const localSubject = subject.connect(signer)
      await expect(localSubject.recoverERC20(contracts.DAI, BigInt(1)))
        .revertedWithCustomError(subject, 'NotAdminOrManager')
        .withArgs(await signer.getAddress())
    })
    it('should successfully recover a token', async function () {
      const amount = ethers.parseEther('1')
      const token = await ethers.getContractAt('IERC20', contracts.DAI)
      const subjectAddress = await subject.getAddress()

      await fillUpERC20FromTreasury({
        token: contracts.DAI,
        amount: amount,
        address: subjectAddress,
      })

      const balanceBefore = await token.balanceOf(subject)

      await expect(subject.recoverERC20(contracts.DAI, amount))
        .to.emit(subject, 'ERC20Recovered')
        .withArgs(contracts.DAI, contracts.AGENT, amount)

      const balanceAfter = await token.balanceOf(subject)

      expect(balanceBefore - amount).to.equal(balanceAfter)
    })
  })

  describe('negative cases:', function () {
    it('should revert recoverEther when called by stranger', async function () {
      const stranger = (await ethers.getSigners())[4]
      await expect(subject.connect(stranger).recoverEther())
        .to.be.revertedWithCustomError(subject, 'NotAdminOrManager')
        .withArgs(await stranger.getAddress())
    })

    it('should handle isValidSignature with non-empty signature data', async function () {
      const signature = '0x1234567890abcdef'
      expect(await subject.isValidSignature(orderHash, signature)).to.equal(MAGIC_VALUE)
    })
  })

  after(async function () {
    await snapshot.restore()
    resetTestOracleRouter() // Clean up global state
    resetTestFeedRegistryStub()
  })
})
