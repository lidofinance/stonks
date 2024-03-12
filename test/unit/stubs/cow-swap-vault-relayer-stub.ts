import { ethers } from 'hardhat'
import { assert, expect } from 'chai'
import { mainnet } from '../../../utils/contracts'
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
import { getContracts } from '../../../utils/contracts'

type HardhatEthersSigner = Awaited<ReturnType<(typeof ethers)['getSigners']>>[number]

const contracts = getContracts()

describe('CoWSwapVaultRelayerStub', async () => {
  let owner: HardhatEthersSigner
  let manager: HardhatEthersSigner
  let deployer: HardhatEthersSigner
  let stranger: HardhatEthersSigner
  let relayer: CoWSwapVaultRelayerStub
  let stonks: Stonks
  let snapshot: SnapshotRestorer

  before(async () => {
    ;[owner, manager, deployer, stranger] = await ethers.getSigners()
    relayer = await new CoWSwapVaultRelayerStub__factory(deployer).deploy(owner, manager)
    await relayer.waitForDeployment()

    assert.equal(await relayer.owner(), owner.address)
    assert.equal(await relayer.manager(), manager.address)

    const settlement = await new CoWSwapSettlementStub__factory(deployer).deploy()
    await settlement.waitForDeployment()

    const feedRegistry = await new ChainlinkFeedRegistryStub__factory(deployer).deploy(
      owner,
      manager
    )
    await feedRegistry.waitForDeployment()

    await feedRegistry.connect(manager).setFeed(mainnet.STETH, mainnet.CHAINLINK_USD_QUOTE, {
      roundId: 1n,
      answer: 1000n * 10n ** 18n,
      updatedAt: 0n,
      startedAt: 0n,
      answeredInRound: 1n,
      decimals: 18n,
    })

    const amountConverter = await new AmountConverter__factory(deployer).deploy(
      feedRegistry,
      mainnet.CHAINLINK_USD_QUOTE,
      [mainnet.STETH],
      [mainnet.DAI],
      [24 * 3600]
    )
    await amountConverter.waitForDeployment()

    const orderSample = await new Order__factory(deployer).deploy(
      mainnet.AGENT,
      await relayer.getAddress(),
      contracts.DOMAIN_SEPARATOR
    )
    await orderSample.waitForDeployment()

    stonks = await new Stonks__factory(deployer).deploy(
      mainnet.AGENT,
      manager,
      mainnet.STETH,
      mainnet.DAI,
      amountConverter,
      orderSample,
      3600,
      1_00,
      50
    )
    await stonks.waitForDeployment()

    snapshot = await takeSnapshot()
  })

  afterEach(async () => snapshot.restore())

  it('setOwner()', async () => {
    assert.equal(await relayer.owner(), owner.address)
    await expect(relayer.connect(stranger).setOwner(stranger))
      .to.revertedWithCustomError(relayer, 'NotOwner')
      .withArgs(stranger.address, owner.address)

    const tx = await relayer.connect(owner).setOwner(stranger)
    const receipt = await tx.wait()
    expect(receipt).to.emit(relayer, 'OwnerSet').withArgs(stranger.address)

    assert.equal(await relayer.owner(), stranger.address)
  })

  it('fill()', async () => {
    await impersonateAccount(mainnet.AGENT)
    await setBalance(mainnet.AGENT, 100n * 10n ** 18n)

    const agentUnlocked = await ethers.getSigner(mainnet.AGENT)

    const stETH = IERC20__factory.connect(mainnet.STETH, ethers.provider)
    await stETH.connect(agentUnlocked).transfer(stonks, 10n ** 18n)

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

    // when manager is set only it may fill orders
    await expect(relayer.connect(stranger).fill(order))
      .revertedWithCustomError(relayer, 'NotManager')
      .withArgs(stranger.address, manager.address)

    // when manager is zero address anyone can fill order
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
