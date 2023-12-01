import { ethers, network } from 'hardhat'
import { expect } from 'chai'
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { StonksFactory, StonksFactory__factory } from '../../typechain-types'

import { mainnet } from '../../utils/contracts'

describe('StonksFactory', function () {
  let subject: StonksFactory
  let snapshotId: string
  let ContractFactory: StonksFactory__factory
  this.beforeAll(async function () {
    ContractFactory = await ethers.getContractFactory('StonksFactory')

    subject = await ContractFactory.deploy(
      mainnet.AGENT,
      mainnet.SETTLEMENT,
      mainnet.VAULT_RELAYER
    )
    await subject.waitForDeployment()

    snapshotId = await network.provider.send('evm_snapshot')
  })

  describe('initialization:', async function () {
    it('should have right treasury address', async function () {
      expect(await subject.agent()).to.equal(mainnet.AGENT)
    })
    it('should have right settlement address', async function () {
      expect(await subject.settlement()).to.equal(mainnet.SETTLEMENT)
    })
    it('should have right vault relayer address', async function () {
      expect(await subject.relayer()).to.equal(mainnet.VAULT_RELAYER)
    })
    it('should have an order sample deployed', async function () {
      expect(await subject.orderSample()).to.not.equal(ethers.ZeroAddress)
    })
    it('should not initialize with agent zero address', async function () {
      await expect(ContractFactory.deploy(
        ethers.ZeroAddress,
        mainnet.SETTLEMENT,
        mainnet.VAULT_RELAYER
      )).to.be.revertedWithCustomError(ContractFactory, 'ZeroAddress')
    })
    it('should not initialize with settlement zero address', async function () {
      await expect(ContractFactory.deploy(
        mainnet.AGENT,
        ethers.ZeroAddress,
        mainnet.VAULT_RELAYER
      )).to.be.revertedWithCustomError(ContractFactory, 'ZeroAddress')
    })
    it('should not initialize with relayer zero address', async function () {
      await expect(ContractFactory.deploy(
        mainnet.AGENT,
        mainnet.SETTLEMENT,
        ethers.ZeroAddress
      )).to.be.revertedWithCustomError(ContractFactory, 'ZeroAddress')
    })
  })
  describe('stonks deployment:', async function () {
    it('should deploy stonks with correct params', async function () {
      const signers = await ethers.getSigners()
      const manager = await signers[0].getAddress()
      const tokenFrom = mainnet.STETH
      const tokenTo = mainnet.DAI
      const amountConverter = await signers[1].getAddress()
      const orderSample = await subject.orderSample()
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
