import { ethers } from 'hardhat'
import { expect } from 'chai'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs'
import { StonksFactory, StonksFactory__factory } from '../../typechain-types'

import { getContracts } from '../../utils/contracts'

const contracts = getContracts()

describe('StonksFactory', function () {
  let subject: StonksFactory
  let snapshot: SnapshotRestorer
  let ContractFactory: StonksFactory__factory

  this.beforeAll(async function () {
    snapshot = await takeSnapshot()
    ContractFactory = await ethers.getContractFactory('StonksFactory')

    subject = await ContractFactory.deploy(contracts.AGENT, contracts.SETTLEMENT, contracts.VAULT_RELAYER)
    await subject.waitForDeployment()
  })

  describe('initialization:', async function () {
    it('should have right treasury address', async function () {
      expect(await subject.AGENT()).to.equal(contracts.AGENT)
    })
    it('should have an order sample deployed', async function () {
      expect(await subject.ORDER_SAMPLE()).to.not.equal(ethers.ZeroAddress)
    })
    it('should not initialize with agent zero address', async function () {
      await expect(
        ContractFactory.deploy(ethers.ZeroAddress, contracts.SETTLEMENT, contracts.VAULT_RELAYER)
      )
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidAgentAddress')
        .withArgs(ethers.ZeroAddress)
    })
    it('should not initialize with settlement zero address', async function () {
      await expect(ContractFactory.deploy(contracts.AGENT, ethers.ZeroAddress, contracts.VAULT_RELAYER))
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidSettlementAddress')
        .withArgs(ethers.ZeroAddress)
    })
    it('should not initialize with relayer zero address', async function () {
      await expect(ContractFactory.deploy(contracts.AGENT, contracts.SETTLEMENT, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidRelayerAddress')
        .withArgs(ethers.ZeroAddress)
    })
    it('should emit events on deployment', async function () {
      const tx = subject.deploymentTransaction()
      await expect(tx).to.emit(subject, 'AgentSet').withArgs(contracts.AGENT)
    })
  })
  describe('stonks deployment:', async function () {
    it('should deploy stonks with correct params', async function () {
      const signers = await ethers.getSigners()
      const manager = await signers[0].getAddress()
      const tokenFrom = contracts.STETH
      const tokenTo = contracts.DAI
      const amountConverter = await signers[1].getAddress()
      const orderSample = await subject.ORDER_SAMPLE()
      const orderDuration = 3600
      const marginInBP = 100
      const toleranceInBP = 200

      await expect(
        subject.deployStonks(
          manager,
          tokenFrom,
          tokenTo,
          amountConverter,
          orderDuration,
          marginInBP,
          toleranceInBP
        )
      )
        .to.emit(subject, 'StonksDeployed')
        .withArgs(
          anyValue,
          contracts.AGENT,
          manager,
          tokenFrom,
          tokenTo,
          amountConverter,
          orderSample,
          orderDuration,
          marginInBP,
          toleranceInBP
        )
    })
  })

  this.afterAll(async function () {
    await snapshot.restore()
  })
})
