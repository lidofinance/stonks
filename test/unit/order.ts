import { ethers } from 'hardhat'
import { expect } from 'chai'
import { ContractTransactionReceipt, Signer } from 'ethers'
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
  let placeOrderReceipt: ContractTransactionReceipt
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

    placeOrderReceipt = placeOrderTxReceipt

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
      const [orderHash, tokenFrom, tokenTo, sellAmount, buyAmount, validTo, receiver] =
        await subject.getOrderDetails()

      expect(orderHash).to.equal(orderData.hash)
      expect(tokenFrom).to.equal(tokenFromParam)
      expect(tokenTo).to.equal(tokenToParam)
      expect(sellAmount).to.equal(orderData.order.sellAmount)
      expect(buyAmount).to.equal(orderData.order.buyAmount)
      expect(validTo).to.equal(BigInt(orderData.timestamp) + BigInt(orderDurationInSeconds))
      expect(receiver).to.equal(await stonks.RECEIVER())
    })
  })

  describe('receiver parameter:', function () {
    // Deploys a raw EIP-1167 minimal proxy pointing at `implementation_`. Mirrors what
    // `OpenZeppelin.Clones.clone()` does on-chain, used here to exercise the independent
    // clone-and-initialize path — the only call site where the receiver-zero guard is
    // reachable. Stonks-placed clones never forward a zero receiver, and a fresh Order
    // sample traps on `OrderAlreadyInitialized` because its constructor pre-sets the flag.
    async function deployOrderClone(implementation_: string): Promise<Order> {
      const implBytes = implementation_.toLowerCase().replace('0x', '').padStart(40, '0')
      const bytecode = `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${implBytes}5af43d82803e903d91602b57fd5bf3`

      const [deployer] = await ethers.getSigners()
      const tx = await deployer.sendTransaction({ data: bytecode })
      const receipt = await tx.wait()
      if (!receipt || !receipt.contractAddress) throw new Error('Clone deployment failed')

      return ethers.getContractAt('Order', receipt.contractAddress)
    }

    it('should reject a zero receiver when initializing a fresh clone', async function () {
      const clone = await deployOrderClone(await stonks.ORDER_SAMPLE())

      await expect(clone.initialize(1n, await manager.getAddress(), ethers.ZeroAddress))
        .to.be.revertedWithCustomError(clone, 'InvalidReceiverAddress')
        .withArgs(ethers.ZeroAddress)
    })

    it('should deploy the exact runtime bytecode Clones.clone() produces', async function () {
      const implementation = (await stonks.ORDER_SAMPLE()).toLowerCase()

      const clonesDeployerFactory = await ethers.getContractFactory('ClonesDeployerStub')
      const clonesDeployer = await clonesDeployerFactory.deploy()
      await clonesDeployer.waitForDeployment()

      const ozCloneAddress = await clonesDeployer.clone.staticCall(implementation)
      await clonesDeployer.clone(implementation)

      const manualClone = await deployOrderClone(implementation)

      const canonicalRuntime = `0x363d3d373d3d3d363d73${implementation.slice(2)}5af43d82803e903d91602b57fd5bf3`
      const ozRuntime = await ethers.provider.getCode(ozCloneAddress)
      const manualRuntime = await ethers.provider.getCode(await manualClone.getAddress())

      expect(ozRuntime).to.equal(canonicalRuntime)
      expect(manualRuntime).to.equal(ozRuntime)
    })

    it('should short-circuit on OrderAlreadyInitialized for a fresh Order deployment', async function () {
      const orderFactory = await ethers.getContractFactory('Order')
      const fresh = await orderFactory.deploy(
        contracts.ADMIN,
        contracts.AGENT,
        contracts.VAULT_RELAYER,
        contracts.DOMAIN_SEPARATOR
      )
      await fresh.waitForDeployment()

      // Sanity: a fresh non-cloned Order locks itself in the constructor, so even a
      // zero-receiver attempt trips the initialization guard first. Documents the
      // deliberate ordering of the two checks inside `initialize`.
      await expect(fresh.initialize(1n, ethers.ZeroAddress, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(fresh, 'OrderAlreadyInitialized')
    })

    it('should keep manager and receiver as independent fields after Stonks placement', async function () {
      expect(await subject.manager()).to.equal(await manager.getAddress())
      expect(await stonks.RECEIVER()).to.equal(contracts.AGENT)

      const [, , , , , , receiver] = await subject.getOrderDetails()
      expect(receiver).to.equal(contracts.AGENT)
    })

    it('should expose the stored receiver through getOrderDetails', async function () {
      const [, , , , , , receiver] = await subject.getOrderDetails()
      expect(receiver).to.equal(contracts.AGENT)
    })

    it('should expose the stored receiver through the emitted OrderCreated event', async function () {
      const subjectAddress = await subject.getAddress()
      const orderCreatedEvent = placeOrderReceipt.logs
        .filter((log) => log.address === subjectAddress)
        .map((log) => subject.interface.parseLog({ topics: [...log.topics], data: log.data }))
        .find((log) => log?.name === 'OrderCreated')

      expect(orderCreatedEvent, 'OrderCreated event missing from the placement receipt').to.exist
      expect(orderCreatedEvent!.args.orderData.receiver).to.equal(contracts.AGENT)
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
      const sellAmount = orderDetails[3]
      const buyAmount = orderDetails[4]
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
        .withArgs(orderDetails[5], timestamp + 1)
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
