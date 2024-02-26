import { ethers, network } from 'hardhat'
import { expect } from 'chai'
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs'
import { StonksFactory, StonksFactory__factory } from '../../typechain-types'

import { mainnet } from '../../utils/contracts'

describe('StonksFactory', function () {
  let subject: StonksFactory
  let snapshotId: string
  let ContractFactory: StonksFactory__factory

  this.beforeAll(async function () {
    snapshotId = await network.provider.send('evm_snapshot')
    ContractFactory = await ethers.getContractFactory('StonksFactory')

    subject = await ContractFactory.deploy(mainnet.AGENT, mainnet.SETTLEMENT, mainnet.VAULT_RELAYER)
    await subject.waitForDeployment()
  })

  describe('initialization:', async function () {
    it('should have right treasury address', async function () {
      expect(await subject.AGENT()).to.equal(mainnet.AGENT)
    })
    it('should have an order sample deployed', async function () {
      expect(await subject.ORDER_SAMPLE()).to.not.equal(ethers.ZeroAddress)
    })
    it('should not initialize with agent zero address', async function () {
      await expect(
        ContractFactory.deploy(ethers.ZeroAddress, mainnet.SETTLEMENT, mainnet.VAULT_RELAYER)
      )
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidAgentAddress')
        .withArgs(ethers.ZeroAddress)
    })
    it('should not initialize with settlement zero address', async function () {
      await expect(ContractFactory.deploy(mainnet.AGENT, ethers.ZeroAddress, mainnet.VAULT_RELAYER))
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidSettlementAddress')
        .withArgs(ethers.ZeroAddress)
    })
    it('should not initialize with relayer zero address', async function () {
      await expect(ContractFactory.deploy(mainnet.AGENT, mainnet.SETTLEMENT, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(ContractFactory, 'InvalidRelayerAddress')
        .withArgs(ethers.ZeroAddress)
    })
    it('should emit events on deployment', async function () {
      const tx = subject.deploymentTransaction()
      await expect(tx).to.emit(subject, 'AgentSet').withArgs(mainnet.AGENT)
    })
  })
  describe('stonks deployment:', async function () {
    it('should deploy stonks with correct params', async function () {
      const signers = await ethers.getSigners()
      const manager = await signers[0].getAddress()
      const tokenFrom = mainnet.STETH
      const tokenTo = mainnet.DAI
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
          mainnet.AGENT,
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
    await network.provider.send('evm_revert', [snapshotId])
  })
})
