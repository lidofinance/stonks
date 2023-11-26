import { ethers, network } from 'hardhat'
import { Signer } from 'ethers'
import { expect } from 'chai'
import {
  fillUpBalance,
  fillUpERC20FromTreasury,
} from '../../utils/fill-up-balance'
import { mainnet } from '../../utils/contracts'
import { AssetRecovererTest, IERC20 } from '../../typechain-types'

describe('Asset recoverer', async function () {
  let snapshotId: string
  let subject: AssetRecovererTest
  let manager: Signer

  this.beforeAll(async function () {
    manager = (await ethers.getSigners())[1]

    const ContractFactory =
      await ethers.getContractFactory('AssetRecovererTest')
    const assetRecoverer = await ContractFactory.deploy(
      mainnet.TREASURY,
      manager
    )

    await assetRecoverer.waitForDeployment()
    subject = await ethers.getContractAt(
      'AssetRecovererTest',
      await assetRecoverer.getAddress(),
      manager
    )
    snapshotId = await network.provider.send('evm_snapshot')
  })

  describe('initialization:', async function () {
    it('Should have right manager and agent addresses', async function () {
      expect(await subject.agent()).to.equal(mainnet.TREASURY)
      expect(await subject.manager()).to.equal(await manager.getAddress())
    })
  })

  describe('recovering:', async function () {
    const amount = BigInt(10 ** 18)
    let token: IERC20
    let subjectAddress: string

    this.beforeAll(async function () {
      token = await ethers.getContractAt('IERC20', mainnet.DAI)
      subjectAddress = await subject.getAddress()

      await fillUpBalance(await subject.getAddress(), amount)
      await fillUpERC20FromTreasury({
        amount,
        token: mainnet.DAI,
        address: await subject.getAddress(),
      })
    })

    it('should succesfully recover Ether', async () => {
      const subjectBalanceBefore =
        await ethers.provider.getBalance(subjectAddress)
      const treasuryBalanceBefore = await ethers.provider.getBalance(
        mainnet.TREASURY
      )

      expect(subjectBalanceBefore).to.be.equal(amount)

      const recoverTx = await subject.recoverEther()
      await recoverTx.wait()

      const subjectBalanceAfter =
        await ethers.provider.getBalance(subjectAddress)
      const treasuryBalanceAfter = await ethers.provider.getBalance(
        mainnet.TREASURY
      )

      expect(subjectBalanceAfter).to.be.equal(subjectBalanceBefore - amount)
      expect(treasuryBalanceAfter).to.be.equal(treasuryBalanceBefore + amount)
    })
    it('should succesfully recover ERC20', async () => {
      expect(await token.balanceOf(await subject.getAddress())).to.be.equal(
        amount
      )

      const recoverTx = await subject.recoverERC20(mainnet.DAI, amount)
      await recoverTx.wait()

      expect(await token.balanceOf(await subject.getAddress())).to.be.equal(
        BigInt(0)
      )
    })
    it('should succesfully recover ERC721', async () => {})
    it('should succesfully recover recoverERC1155', async () => {})
    it('should revert if it is called by stranger', async () => {
      const localSubject = await ethers.getContractAt(
        'Order',
        await subject.getAddress(),
        (await ethers.getSigners())[2]
      )

      expect(localSubject.recoverEther()).to.be.revertedWith(
        'NotAgentOrManager'
      )
    })
    it('should succesfully recover by manager', async () => {
      const localSubject = await ethers.getContractAt(
        'Order',
        await subject.getAddress(),
        manager
      )

      localSubject.recoverERC20(mainnet.DAI, amount)
    })
    it('should succesfully recover by agent', async () => {
      network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: [mainnet.TREASURY],
      })
      const agent = await ethers.provider.getSigner(mainnet.TREASURY)
      const localSubject = await ethers.getContractAt(
        'Order',
        await subject.getAddress(),
        agent
      )
      localSubject.recoverERC20(mainnet.DAI, amount)
    })
  })

  this.afterAll(async function () {
    await network.provider.send('evm_revert', [snapshotId])
  })
})
