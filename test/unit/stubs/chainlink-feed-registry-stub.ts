import { ethers } from 'hardhat'
import { assert, expect } from 'chai'
import { ChainlinkFeedRegistryStub } from '../../../typechain-types/contracts/stubs'
import { ChainlinkFeedRegistryStub__factory } from '../../../typechain-types/factories/contracts/stubs'
import { SnapshotRestorer, takeSnapshot } from '@nomicfoundation/hardhat-network-helpers'

type HardhatEthersSigner = Awaited<ReturnType<(typeof ethers)['getSigners']>>[number]

describe('ChainlinkFeedRegistryStub', () => {
  const baseToken = '0x0000000000000000000000000000000000000001'
  const quoteToken = '0x0000000000000000000000000000000000000002'

  let owner: HardhatEthersSigner
  let manager: HardhatEthersSigner
  let deployer: HardhatEthersSigner
  let stranger: HardhatEthersSigner
  let registry: ChainlinkFeedRegistryStub
  let snapshot: SnapshotRestorer

  before(async () => {
    ;[owner, manager, deployer, stranger] = await ethers.getSigners()
    registry = await new ChainlinkFeedRegistryStub__factory(deployer).deploy(owner, manager)

    assert.equal(await registry.owner(), owner.address)
    assert.equal(await registry.manager(), manager.address)

    snapshot = await takeSnapshot()
  })

  afterEach(async () => snapshot.restore())

  it('setOwner()', async () => {
    assert.equal(await registry.owner(), owner.address)
    await expect(registry.connect(stranger).setOwner(stranger))
      .to.revertedWithCustomError(registry, 'NotOwner')
      .withArgs(stranger.address, owner.address)

    const tx = await registry.connect(owner).setOwner(stranger)
    const receipt = await tx.wait()
    expect(receipt).to.emit(registry, 'OwnerSet').withArgs(stranger.address)

    assert.equal(await registry.owner(), stranger.address)
  })

  it('setManager()', async () => {
    assert.equal(await registry.owner(), owner.address)
    await expect(registry.connect(stranger).setManager(stranger))
      .to.revertedWithCustomError(registry, 'NotOwner')
      .withArgs(stranger.address, owner.address)

    const tx = await registry.connect(owner).setManager(ethers.ZeroAddress)
    const receipt = await tx.wait()
    expect(receipt).to.emit(registry, 'ManagerSet').withArgs(ethers.ZeroAddress)

    assert.equal(await registry.manager(), ethers.ZeroAddress)

    // when manager is set to zero address, anyone can set feeds
    for (const sender of [stranger, deployer]) {
      const feedBefore = await registry.feeds(baseToken, quoteToken)
      const tx = await registry.connect(sender).setFeed(baseToken, quoteToken, {
        roundId: feedBefore.roundId + 1n,
        answeredInRound: feedBefore.answeredInRound + 2n,
        answer: feedBefore.answer + 3n,
        startedAt: feedBefore.startedAt + 4n,
        updatedAt: feedBefore.updatedAt + 5n,
        decimals: feedBefore.decimals + 6n,
      })
      await tx.wait()
      const feedAfter = await registry.feeds(baseToken, quoteToken)
      assert.equal(feedAfter.roundId, feedBefore.roundId + 1n)
      assert.equal(feedAfter.answeredInRound, feedBefore.answeredInRound + 2n)
      assert.equal(feedAfter.answer, feedBefore.answer + 3n)
      assert.equal(feedAfter.startedAt, feedBefore.startedAt + 4n)
      assert.equal(feedAfter.updatedAt, feedBefore.updatedAt + 5n)
      assert.equal(feedAfter.decimals, feedBefore.decimals + 6n)
    }
  })

  it('getFeed()', async () => {
    assert.equal(await registry.getFeed(baseToken, quoteToken), await registry.getAddress())
  })

  it('setFeed(), decimals(), latestRoundData()', async () => {
    const feedStub = {
      roundId: 1n,
      answeredInRound: 2n,
      answer: 3n,
      startedAt: 4n,
      updatedAt: 5n,
      decimals: 6n,
    }
    const tx = await registry.connect(manager).setFeed(baseToken, quoteToken, feedStub)
    const receipt = await tx.wait()

    expect(receipt).to.emit(receipt, 'FeedSet').withArgs(baseToken, quoteToken, feedStub)

    const [decimals, latestRoundData] = await Promise.all([
      registry.decimals(baseToken, quoteToken),
      registry.latestRoundData(baseToken, quoteToken),
    ])
    assert.equal(latestRoundData.roundId, feedStub.roundId)
    assert.equal(latestRoundData.answeredInRound, feedStub.answeredInRound)
    assert.equal(latestRoundData.answer, feedStub.answer)
    assert.equal(latestRoundData.startedAt, feedStub.startedAt)
    assert.equal(latestRoundData.updatedAt, feedStub.updatedAt)
    assert.equal(decimals, feedStub.decimals)
  })
})
