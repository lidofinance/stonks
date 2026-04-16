import { ethers } from 'hardhat'
import { expect } from 'chai'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs'
import { StonksFactory, StonksFactory__factory } from '../../typechain-types'
import { getTestOracleRouter, resetTestOracleRouter } from '../../utils/test-oracle-router'
import {
  getAllTestTokens,
  refreshTestFeedData,
  resetTestFeedRegistryStub,
} from '../../utils/test-feed-registry'
import { getContracts } from '../../utils/contracts'

const contracts = getContracts()

describe('StonksFactory', function () {
  let subject: StonksFactory
  let snapshot: SnapshotRestorer
  let ContractFactory: StonksFactory__factory

  before(async function () {
    snapshot = await takeSnapshot()

    await refreshTestFeedData(getAllTestTokens())

    ContractFactory = await ethers.getContractFactory('StonksFactory')

    subject = await ContractFactory.deploy(
      contracts.ADMIN,
      contracts.AGENT,
      contracts.SETTLEMENT,
      contracts.VAULT_RELAYER
    )
    await subject.waitForDeployment()
  })

  describe('initialization:', async function () {
    it('should have right admin address', async function () {
      expect(await subject.ADMIN()).to.equal(contracts.ADMIN)
    })
    it('should have right agent address', async function () {
      expect(await subject.AGENT()).to.equal(contracts.AGENT)
    })
    it('should have an order sample deployed', async function () {
      expect(await subject.ORDER_SAMPLE()).to.not.equal(ethers.ZeroAddress)
    })
    it('should not initialize with admin zero address', async function () {
      await expect(
        ContractFactory.deploy(
          ethers.ZeroAddress,
          contracts.AGENT,
          contracts.SETTLEMENT,
          contracts.VAULT_RELAYER
        )
      )
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidAdminAddress')
        .withArgs(ethers.ZeroAddress)
    })
    it('should not initialize with agent zero address', async function () {
      await expect(
        ContractFactory.deploy(
          contracts.ADMIN,
          ethers.ZeroAddress,
          contracts.SETTLEMENT,
          contracts.VAULT_RELAYER
        )
      )
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidAgentAddress')
        .withArgs(ethers.ZeroAddress)
    })
    it('should not initialize with settlement zero address', async function () {
      await expect(
        ContractFactory.deploy(
          contracts.ADMIN,
          contracts.AGENT,
          ethers.ZeroAddress,
          contracts.VAULT_RELAYER
        )
      )
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidSettlementAddress')
        .withArgs(ethers.ZeroAddress)
    })
    it('should not initialize with relayer zero address', async function () {
      await expect(
        ContractFactory.deploy(
          contracts.ADMIN,
          contracts.AGENT,
          contracts.SETTLEMENT,
          ethers.ZeroAddress
        )
      )
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidRelayerAddress')
        .withArgs(ethers.ZeroAddress)
    })
    it('should emit events on deployment', async function () {
      const tx = subject.deploymentTransaction()
      await expect(tx).to.emit(subject, 'AgentSet').withArgs(contracts.AGENT)
    })
  })
  describe('stonks deployment:', async function () {
    const customReceiver = '0x000000000000000000000000000000000000bEEF'

    const getBaseArgs = async () => {
      const oracleRouter = await getTestOracleRouter({
        tokens: getAllTestTokens(),
        useRealPrices: true,
      })

      await refreshTestFeedData(getAllTestTokens())

      const amountConverterTestFactory = await ethers.getContractFactory('AmountConverterTest')
      const amountConverterTest = await amountConverterTestFactory.deploy(
        await oracleRouter.getAddress(),
        [contracts.STETH],
        [contracts.DAI],
        false
      )
      await amountConverterTest.waitForDeployment()

      const signers = await ethers.getSigners()
      return {
        manager: await signers[0].getAddress(),
        tokenFrom: contracts.STETH,
        tokenTo: contracts.DAI,
        amountConverter: await amountConverterTest.getAddress(),
        orderSample: await subject.ORDER_SAMPLE(),
        orderDuration: 3600,
        marginInBP: 100,
        toleranceInBP: 200,
        maxImprovementInBP: 0,
        allowPartialFill: false,
      }
    }

    it('should deploy stonks with correct params (AGENT-receiver fallback)', async function () {
      const args = await getBaseArgs()

      await expect(
        subject.deployStonks(
          args.manager,
          args.tokenFrom,
          args.tokenTo,
          args.amountConverter,
          args.orderDuration,
          args.marginInBP,
          args.toleranceInBP,
          args.maxImprovementInBP,
          args.allowPartialFill,
          ethers.ZeroAddress
        )
      )
        .to.emit(subject, 'StonksDeployed')
        .withArgs(
          anyValue,
          contracts.AGENT,
          contracts.ADMIN,
          args.manager,
          args.tokenFrom,
          args.tokenTo,
          args.amountConverter,
          args.orderSample,
          args.orderDuration,
          args.marginInBP,
          args.toleranceInBP,
          args.maxImprovementInBP,
          args.allowPartialFill,
          ethers.ZeroAddress
        )
    })

    it('should forward a zero receiver so the deployed Stonks defaults RECEIVER to AGENT', async function () {
      const args = await getBaseArgs()

      const tx = await subject.deployStonks(
        args.manager,
        args.tokenFrom,
        args.tokenTo,
        args.amountConverter,
        args.orderDuration,
        args.marginInBP,
        args.toleranceInBP,
        args.maxImprovementInBP,
        args.allowPartialFill,
        ethers.ZeroAddress
      )
      const receipt = await tx.wait()
      if (!receipt) throw new Error('No transaction receipt')

      const deployedEvent = receipt.logs
        .map((log) => {
          try {
            return subject.interface.parseLog(log as any)
          } catch {
            return null
          }
        })
        .find((parsed) => parsed?.name === 'StonksDeployed')

      const stonksAddress = deployedEvent!.args[0] as string
      const stonks = await ethers.getContractAt('Stonks', stonksAddress)
      expect(await stonks.RECEIVER()).to.equal(contracts.AGENT)
    })

    it('should forward an explicit receiver into the deployed Stonks RECEIVER', async function () {
      const args = await getBaseArgs()

      const tx = await subject.deployStonks(
        args.manager,
        args.tokenFrom,
        args.tokenTo,
        args.amountConverter,
        args.orderDuration,
        args.marginInBP,
        args.toleranceInBP,
        args.maxImprovementInBP,
        args.allowPartialFill,
        customReceiver
      )
      const receipt = await tx.wait()
      if (!receipt) throw new Error('No transaction receipt')

      const deployedEvent = receipt.logs
        .map((log) => {
          try {
            return subject.interface.parseLog(log as any)
          } catch {
            return null
          }
        })
        .find((parsed) => parsed?.name === 'StonksDeployed')

      expect(deployedEvent!.args.receiver).to.equal(customReceiver)

      const stonksAddress = deployedEvent!.args[0] as string
      const stonks = await ethers.getContractAt('Stonks', stonksAddress)
      expect(await stonks.RECEIVER()).to.equal(customReceiver)
    })
  })

  after(async function () {
    await snapshot.restore()

    resetTestOracleRouter() // Clean up global state
    resetTestFeedRegistryStub()
  })
})
