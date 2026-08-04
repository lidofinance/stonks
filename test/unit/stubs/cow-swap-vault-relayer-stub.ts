import { ethers } from 'hardhat'
import { assert, expect } from 'chai'
import { getContracts } from '../../../utils/contracts'
import { CoWSwapVaultRelayerStub } from '../../../typechain-types/contracts/stubs/CoWSwapVaultRelayerStub.sol'
import {
  SnapshotRestorer,
  impersonateAccount,
  setBalance,
  takeSnapshot,
} from '@nomicfoundation/hardhat-network-helpers'
import {
  AmountConverter__factory,
  Order__factory,
  Stonks,
  Stonks__factory,
  IERC20__factory,
  CoWSwapVaultRelayerStub__factory,
  ChainlinkFeedRegistryStub__factory,
  CoWSwapSettlementStub__factory,
} from '../../../typechain-types'
import { OrderCreatedEvent } from '../../../typechain-types/contracts/Order'
import { deployAndConfigureOracleRouter } from '../../../utils/oracle-router'

type HardhatEthersSigner = Awaited<ReturnType<(typeof ethers)['getSigners']>>[number]

const contracts = getContracts()

const STETH_PRICE = 2000n * 10n ** 8n
const DAI_PRICE = 1n * 10n ** 8n
const FEED_DECIMALS = 8n
const MAX_STALENESS = 86_400
const ORDER_DURATION = 3600
const MARGIN_BPS = 1_00
const PRICE_TOLERANCE_BPS = 50
const FUND_AMOUNT = 10n ** 18n
const ETH_BALANCE = 100n * 10n ** 18n

describe('CoWSwapVaultRelayerStub', async () => {
  let owner: HardhatEthersSigner
  let manager: HardhatEthersSigner
  let deployer: HardhatEthersSigner
  let stranger: HardhatEthersSigner
  let ownerAddress: string
  let managerAddress: string
  let strangerAddress: string
  let relayer: CoWSwapVaultRelayerStub
  let stonks: Stonks
  let snapshot: SnapshotRestorer

  before(async () => {
    ;[owner, manager, deployer, stranger] = await ethers.getSigners()
    ownerAddress = await owner.getAddress()
    managerAddress = await manager.getAddress()
    strangerAddress = await stranger.getAddress()

    relayer = await new CoWSwapVaultRelayerStub__factory(deployer).deploy(
      ownerAddress,
      managerAddress
    )
    await relayer.waitForDeployment()

    assert.equal(await relayer.owner(), ownerAddress)
    assert.equal(await relayer.manager(), managerAddress)

    const settlement = await new CoWSwapSettlementStub__factory(deployer).deploy()
    await settlement.waitForDeployment()

    const feedRegistry = await new ChainlinkFeedRegistryStub__factory(deployer).deploy(
      ownerAddress,
      managerAddress
    )
    await feedRegistry.waitForDeployment()
    const feedRegistryAddress = await feedRegistry.getAddress()

    const latestBlock = await ethers.provider.getBlock('latest')
    const nowTs = BigInt(latestBlock!.timestamp)

    const feedData = {
      aggregator: feedRegistryAddress,
      roundId: 1n,
      updatedAt: nowTs,
      startedAt: nowTs,
      answeredInRound: 1n,
      decimals: FEED_DECIMALS,
    }

    await feedRegistry.connect(manager).setFeed(contracts.STETH, contracts.CHAINLINK_USD_QUOTE, {
      ...feedData,
      answer: STETH_PRICE,
    })
    await feedRegistry.connect(manager).setFeed(contracts.DAI, contracts.CHAINLINK_USD_QUOTE, {
      ...feedData,
      answer: DAI_PRICE,
    })

    const oracleRouter = await deployAndConfigureOracleRouter({
      feedRegistry: feedRegistryAddress,
      tokensUsd: [contracts.STETH, contracts.DAI],
      maxStaleness: MAX_STALENESS,
      skipEthUsdBridge: true,
    })
    const oracleRouterAddress = await oracleRouter.getAddress()

    const amountConverter = await new AmountConverter__factory(deployer).deploy(
      oracleRouterAddress,
      [contracts.STETH],
      [contracts.DAI],
      false
    )
    await amountConverter.waitForDeployment()

    const orderSample = await new Order__factory(deployer).deploy(
      contracts.ADMIN,
      contracts.AGENT,
      await relayer.getAddress(),
      contracts.DOMAIN_SEPARATOR
    )
    await orderSample.waitForDeployment()

    stonks = await new Stonks__factory(deployer).deploy({
      admin: contracts.ADMIN,
      agent: contracts.AGENT,
      manager: managerAddress,
      tokenFrom: contracts.STETH,
      tokenTo: contracts.DAI,
      amountConverter: await amountConverter.getAddress(),
      orderSample: await orderSample.getAddress(),
      orderDurationInSeconds: ORDER_DURATION,
      marginInBasisPoints: MARGIN_BPS,
      priceToleranceInBasisPoints: PRICE_TOLERANCE_BPS,
      maxImprovementInBasisPoints: 0,
      allowPartialFill: false,
      receiver: ethers.ZeroAddress,
    })
    await stonks.waitForDeployment()

    snapshot = await takeSnapshot()
  })

  afterEach(async () => snapshot.restore())

  it('should transfer ownership and emit event', async () => {
    assert.equal(await relayer.owner(), ownerAddress)
    await expect(relayer.connect(stranger).setOwner(strangerAddress))
      .to.revertedWithCustomError(relayer, 'NotOwner')
      .withArgs(strangerAddress, ownerAddress)

    const tx = await relayer.connect(owner).setOwner(strangerAddress)
    const receipt = await tx.wait()
    expect(receipt).to.emit(relayer, 'OwnerSet').withArgs(strangerAddress)

    assert.equal(await relayer.owner(), strangerAddress)
  })

  it('should fill order and transfer tokens', async () => {
    await impersonateAccount(contracts.AGENT)
    await setBalance(contracts.AGENT, ETH_BALANCE)

    const agentUnlocked = await ethers.getSigner(contracts.AGENT)

    const stETH = IERC20__factory.connect(contracts.STETH, ethers.provider)
    await stETH.connect(agentUnlocked).transfer(stonks, FUND_AMOUNT)

    const tx = await stonks
      .connect(manager)
      .placeOrder(await stonks.estimateTradeOutputFromCurrentBalance())
    const receipt = await tx.wait()

    const iOrder = Order__factory.createInterface()
    const createOrderLog = receipt!.logs.find(
      (log) => log.topics[0] === iOrder.getEvent('OrderCreated').topicHash
    )

    const createOrderLogDescription = iOrder.parseLog(
      createOrderLog as any
    ) as OrderCreatedEvent.LogDescription | null

    const order = createOrderLogDescription?.args.order!

    const [agentStEthBalanceBefore, orderStEthBalanceBefore] = await Promise.all([
      stETH.balanceOf(agentUnlocked),
      stETH.balanceOf(order),
    ])

    await expect(relayer.connect(stranger).fill(order))
      .revertedWithCustomError(relayer, 'NotManager')
      .withArgs(strangerAddress, managerAddress)

    await relayer.connect(owner).setManager(ethers.ZeroAddress)

    const fillTx = await relayer.connect(stranger).fill(order)
    await fillTx.wait()

    const [agentStEthBalanceAfter, orderStEthBalanceAfter] = await Promise.all([
      stETH.balanceOf(agentUnlocked),
      stETH.balanceOf(order),
    ])

    const agentBalanceChange = agentStEthBalanceAfter - agentStEthBalanceBefore
    const orderBalanceChange = orderStEthBalanceAfter - orderStEthBalanceBefore

    assert(agentBalanceChange + orderBalanceChange <= 2n, 'Invalid balances change')
  })
})
