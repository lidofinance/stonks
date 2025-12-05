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

  before(async function () {
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
    const extractConverterAddress = async (logs: any[]) => {
      const factoryAddress = (await subject.getAddress()).toLowerCase()
      const eventLog = logs.find((log: any) => log.address?.toLowerCase() === factoryAddress)
      if (!eventLog) {
        throw new Error('AmountConverterDeployed event not found')
      }
      return subject.interface.parseLog(eventLog)?.args[0]
    }

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
      const converterAddress = await extractConverterAddress(receipt?.logs ?? [])
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
      const converterAddress = await extractConverterAddress(receipt?.logs ?? [])
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
      const address1 = await extractConverterAddress(receipt1?.logs ?? [])

      // Deploy ETH mode
      const tx2 = await subject.deployAmountConverter(tokensFrom, [contracts.LDO], true)
      const receipt2 = await tx2.wait()
      const address2 = await extractConverterAddress(receipt2?.logs ?? [])

      // Should be different addresses
      expect(address1).to.not.equal(address2)

      // Verify configurations
      const converter1 = await ethers.getContractAt('AmountConverter', address1)
      const converter2 = await ethers.getContractAt('AmountConverter', address2)

      expect(await converter1.USE_ETH_ANCHOR()).to.be.false
      expect(await converter2.USE_ETH_ANCHOR()).to.be.true
    })
  })

  after(async function () {
    await snapshot.restore()
    resetTestOracleRouter() // Clean up global state
    resetTestFeedRegistryStub()
  })
})
