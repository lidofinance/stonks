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
    it('should deploy with USD mode (useEthAnchor=false)', async function () {
      const tokensFrom = [contracts.STETH]
      const tokensTo = [contracts.DAI]

      await expect(subject.deployAmountConverter(tokensFrom, tokensTo, false))
        .to.emit(subject, 'AmountConverterDeployed')
        .withArgs(anyValue, await oracleRouter.getAddress(), tokensFrom, tokensTo, false)
    })

    it('should deploy with ETH anchor mode (useEthAnchor=true)', async function () {
      const tokensFrom = [contracts.STETH]
      const tokensTo = [contracts.LDO]

      await expect(subject.deployAmountConverter(tokensFrom, tokensTo, true))
        .to.emit(subject, 'AmountConverterDeployed')
        .withArgs(anyValue, await oracleRouter.getAddress(), tokensFrom, tokensTo, true)
    })

    it('should deploy USD mode converter that accepts mixed denominations', async function () {
      const tokensFrom = [contracts.STETH]
      const tokensTo = [contracts.DAI, contracts.LDO] // Mixed: USD and ETH quoted

      const tx = await subject.deployAmountConverter(tokensFrom, tokensTo, false)
      const receipt = await tx.wait()

      // Extract deployed address from event
      const event = receipt?.logs.find((log: any) => {
        try {
          return subject.interface.parseLog(log)?.name === 'AmountConverterDeployed'
        } catch {
          return false
        }
      })

      expect(event).to.not.be.undefined

      const converterAddress = subject.interface.parseLog(event as any)?.args[0]
      const converter = await ethers.getContractAt('AmountConverter', converterAddress)

      // Verify it's configured correctly
      expect(await converter.USE_ETH_ANCHOR()).to.be.false
      expect(await converter.ORACLE_ROUTER()).to.equal(await oracleRouter.getAddress())
    })

    it('should deploy ETH anchor converter for ETH-quoted pairs', async function () {
      const tokensFrom = [contracts.STETH]
      const tokensTo = [contracts.LDO]

      const tx = await subject.deployAmountConverter(tokensFrom, tokensTo, true)
      const receipt = await tx.wait()

      // Extract deployed address from event
      const event = receipt?.logs.find((log: any) => {
        try {
          return subject.interface.parseLog(log)?.name === 'AmountConverterDeployed'
        } catch {
          return false
        }
      })

      expect(event).to.not.be.undefined

      const converterAddress = subject.interface.parseLog(event as any)?.args[0]
      const converter = await ethers.getContractAt('AmountConverter', converterAddress)

      // Verify it's configured correctly
      expect(await converter.USE_ETH_ANCHOR()).to.be.true
      expect(await converter.ORACLE_ROUTER()).to.equal(await oracleRouter.getAddress())
    })

    it('should deploy multiple converters with different configurations', async function () {
      const tokensFrom = [contracts.STETH]

      // Deploy USD mode
      const tx1 = await subject.deployAmountConverter(tokensFrom, [contracts.DAI], false)
      const receipt1 = await tx1.wait()
      const event1 = receipt1?.logs.find((log: any) => {
        try {
          return subject.interface.parseLog(log)?.name === 'AmountConverterDeployed'
        } catch {
          return false
        }
      })
      const address1 = subject.interface.parseLog(event1 as any)?.args[0]

      // Deploy ETH mode
      const tx2 = await subject.deployAmountConverter(tokensFrom, [contracts.LDO], true)
      const receipt2 = await tx2.wait()
      const event2 = receipt2?.logs.find((log: any) => {
        try {
          return subject.interface.parseLog(log)?.name === 'AmountConverterDeployed'
        } catch {
          return false
        }
      })
      const address2 = subject.interface.parseLog(event2 as any)?.args[0]

      // Should be different addresses
      expect(address1).to.not.equal(address2)

      // Verify configurations
      const converter1 = await ethers.getContractAt('AmountConverter', address1)
      const converter2 = await ethers.getContractAt('AmountConverter', address2)

      expect(await converter1.USE_ETH_ANCHOR()).to.be.false
      expect(await converter2.USE_ETH_ANCHOR()).to.be.true
    })
  })

  this.afterAll(async function () {
    await snapshot.restore()
    resetTestOracleRouter() // Clean up global state
    resetTestFeedRegistryStub()
  })
})
