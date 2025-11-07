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
  let snapshot: SnapshotRestorer

  this.beforeAll(async function () {
    snapshot = await takeSnapshot()

    oracleRouter = await getTestOracleRouter({
      tokens: getAllTestTokens(),
    })

    await refreshTestFeedData(getAllTestTokens())

    contractFactory = await ethers.getContractFactory('AmountConverterFactory')
    subject = await contractFactory.deploy(await oracleRouter.getAddress())
    await subject.waitForDeployment()
  })

  describe('initialization:', async function () {
    it('should revert with zero oracle router address', async function () {
      await expect(contractFactory.deploy(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(contractFactory, 'InvalidOracleRouterAddress')
        .withArgs(ethers.ZeroAddress)
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
