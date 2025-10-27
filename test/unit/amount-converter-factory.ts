import { ethers } from 'hardhat'
import { expect } from 'chai'
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import {
  AmountConverterFactory,
  AmountConverterFactory__factory,
  OracleRouter,
} from '../../typechain-types'
import { getTestOracleRouter, resetTestOracleRouter } from '../../utils/test-oracle-router'
import {
  getAllTestTokens,
  refreshTestFeedData,
  resetTestFeedRegistryStub,
} from '../../utils/test-feed-registry'
import { getContracts } from '../../utils/contracts'

const contracts = getContracts()

describe('AmountConverterFactory', function () {
  let subject: AmountConverterFactory
  let contractFactory: AmountConverterFactory__factory
  let oracleRouter: OracleRouter
  let feedRegistryAddress: string
  let snapshot: SnapshotRestorer

  this.beforeAll(async function () {
    snapshot = await takeSnapshot()

    oracleRouter = await getTestOracleRouter({
      tokens: getAllTestTokens(),
    })

    await refreshTestFeedData(getAllTestTokens())

    feedRegistryAddress = await oracleRouter.FEED_REGISTRY()

    contractFactory = await ethers.getContractFactory('AmountConverterFactory')
    subject = await contractFactory.deploy(feedRegistryAddress, await oracleRouter.getAddress())
    await subject.waitForDeployment()
  })

  describe('initialization:', async function () {
    it('should have right treasury address after deploy', async function () {
      expect(await subject.FEED_REGISTRY()).to.equal(feedRegistryAddress)
    })
    it('should revert with zero feed registry address', async function () {
      await expect(contractFactory.deploy(ethers.ZeroAddress, contracts.ORACLE_ROUTER))
        .to.be.revertedWithCustomError(contractFactory, 'InvalidFeedRegistryAddress')
        .withArgs(ethers.ZeroAddress)
    })
    it('should revert with zero oracle router address', async function () {
      await expect(contractFactory.deploy(feedRegistryAddress, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(contractFactory, 'InvalidOracleRouterAddress')
        .withArgs(ethers.ZeroAddress)
    })
    it('should emit FeedRegistrySet event on deployment', async function () {
      const subject = await contractFactory.deploy(
        feedRegistryAddress,
        await oracleRouter.getAddress()
      )
      const tx = subject.deploymentTransaction()
      await expect(tx).to.emit(subject, 'FeedRegistrySet').withArgs(feedRegistryAddress)
    })
  })
  describe('amount converter deployment:', async function () {
    it('should emit AmountConverterDeployed event with correct params at Stonks deploy', async function () {
      const tokensFrom = [contracts.STETH]
      const tokensTo = [contracts.DAI]

      await expect(subject.deployAmountConverter(tokensFrom, tokensTo))
        .to.emit(subject, 'AmountConverterDeployed')
        .withArgs(anyValue, await oracleRouter.getAddress(), tokensFrom, tokensTo)
    })
  })

  this.afterAll(async function () {
    await snapshot.restore()
    resetTestOracleRouter() // Clean up global state
    resetTestFeedRegistryStub()
  })
})
