import { ethers, network } from 'hardhat'
import { Signer } from 'ethers'
import { expect } from 'chai'
import {
  fillUpBalance,
  fillUpERC20FromTreasury,
} from '../../utils/fill-up-balance'
import { mainnet } from '../../utils/contracts'
import {
  AssetRecovererTest,
  IERC20,
  IERC721,
  IERC1155,
} from '../../typechain-types'

describe('Asset recoverer', async function () {
  let snapshotId: string
  let subject: AssetRecovererTest
  let manager: Signer

  this.beforeAll(async function () {
    snapshotId = await network.provider.send('evm_snapshot')
    manager = (await ethers.getSigners())[1]

    const ContractFactory =
      await ethers.getContractFactory('AssetRecovererTest')
    const assetRecoverer = await ContractFactory.deploy(mainnet.AGENT, manager)

    await assetRecoverer.waitForDeployment()
    subject = await ethers.getContractAt(
      'AssetRecovererTest',
      await assetRecoverer.getAddress(),
      manager
    )
  })

  describe('initialization:', async function () {
    it('should have right manager and agent addresses', async function () {
      expect(await subject.agent()).to.equal(mainnet.AGENT)
      expect(await subject.manager()).to.equal(await manager.getAddress())
    })
    it('should revert with agent zero adress', async function () {
      const ContractFactory =
        await ethers.getContractFactory('AssetRecovererTest')
      await expect(
        ContractFactory.deploy(ethers.ZeroAddress, manager)
      ).to.be.revertedWithCustomError(ContractFactory, 'InvalidAgentAddress')
    })
  })

  describe('manager changing:', async function () {
    let localSnapshotId: string
    this.beforeAll(async function () {
      localSnapshotId = await network.provider.send('evm_snapshot')
    })
    it('should allow agent to change manager', async function () {
      expect(await subject.manager()).to.equal(await manager.getAddress())
      fillUpBalance(mainnet.AGENT, ethers.parseEther('100'))
      await network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: [mainnet.AGENT],
      })
      const agent = await ethers.provider.getSigner(mainnet.AGENT)
      const newManager = await (await ethers.getSigners())[2].getAddress()
      const subjectAgentSigner = await ethers.getContractAt(
        'AssetRecovererTest',
        await subject.getAddress(),
        agent
      )

      await subjectAgentSigner.setManager(newManager, {
        from: agent,
      })
      expect(await subject.manager()).to.equal(newManager)
    })
    it("shouldn't allow manager to change manager", async function () {
      const newManager = await (await ethers.getSigners())[2].getAddress()
      const subjectManagerSigner = await ethers.getContractAt(
        'AssetRecovererTest',
        await subject.getAddress(),
        manager
      )
      await expect(
        subjectManagerSigner.setManager(newManager)
      ).to.be.revertedWithCustomError(subject, 'NotAgent')
    })
    it("shouldn't allow stranger to change manager", async function () {
      const newManager = await (await ethers.getSigners())[2].getAddress()
      const subjectStrangerSigner = await ethers.getContractAt(
        'AssetRecovererTest',
        await subject.getAddress(),
        (await ethers.getSigners())[3]
      )
      await expect(
        subjectStrangerSigner.setManager(newManager)
      ).to.be.revertedWithCustomError(subject, 'NotAgent')
    })
    this.afterAll(async function () {
      await network.provider.send('evm_revert', [localSnapshotId])
    })
  })

  describe('recovering:', async function () {
    const amount = BigInt(10 ** 18)
    let token: IERC20
    let subjectAddress: string

    const nftId = 0
    let nft721: IERC721
    let nft1155: IERC1155

    this.beforeAll(async function () {
      token = await ethers.getContractAt('IERC20', mainnet.DAI)
      subjectAddress = await subject.getAddress()

      const NFT721 = await ethers.getContractFactory('NFT_721')
      nft721 = await NFT721.deploy('NFT_721', 'N721')
      await nft721.waitForDeployment()
      const NFT1155 = await ethers.getContractFactory('NFT_1155')
      nft1155 = await NFT1155.deploy('https://game.example/api/item/{id}.json')
      await nft1155.waitForDeployment()
    })

    describe('recovering Ether:', async function () {
      let snapshotId: string
      this.beforeEach(async function () {
        snapshotId = await network.provider.send('evm_snapshot')
        await fillUpBalance(subjectAddress, amount)
      })

      this.afterEach(async function () {
        await network.provider.send('evm_revert', [snapshotId])
      })

      it('should successfully recover Ether', async () => {
        const subjectBalanceBefore =
          await ethers.provider.getBalance(subjectAddress)
        const treasuryBalanceBefore = await ethers.provider.getBalance(
          mainnet.AGENT
        )

        expect(subjectBalanceBefore).to.be.equal(amount)

        const recoverTx = await subject.recoverEther()
        await recoverTx.wait()

        const subjectBalanceAfter =
          await ethers.provider.getBalance(subjectAddress)
        const treasuryBalanceAfter = await ethers.provider.getBalance(
          mainnet.AGENT
        )

        expect(subjectBalanceAfter).to.be.equal(subjectBalanceBefore - amount)
        expect(treasuryBalanceAfter).to.be.equal(treasuryBalanceBefore + amount)
      })

      it('should revert if it is called by stranger Ether', async () => {
        const localSubject = await ethers.getContractAt(
          'Order',
          await subject.getAddress(),
          (await ethers.getSigners())[2]
        )

        await expect(localSubject.recoverEther()).to.be.revertedWithCustomError(
          subject,
          'NotAgentOrManager'
        )
      })
    })

    describe('recovering ERC20:', async function () {
      let snapshotId: string
      this.beforeEach(async function () {
        snapshotId = await network.provider.send('evm_snapshot')
        await fillUpERC20FromTreasury({
          amount,
          token: mainnet.DAI,
          address: subjectAddress,
        })
      })

      this.afterEach(async function () {
        await network.provider.send('evm_revert', [snapshotId])
      })

      it('should successfully recover ERC20', async () => {
        expect(await token.balanceOf(await subject.getAddress())).to.be.equal(
          amount
        )

        const recoverTx = await subject.recoverERC20(mainnet.DAI, amount)
        await recoverTx.wait()

        expect(await token.balanceOf(await subject.getAddress())).to.be.equal(
          BigInt(0)
        )
      })
      it('should successfully recover by manager ERC20', async () => {
        expect(await token.balanceOf(await subject.getAddress())).to.be.equal(
          amount
        )
        const localSubject = await ethers.getContractAt(
          'Order',
          await subject.getAddress(),
          manager
        )

        const recoverTx = await localSubject.recoverERC20(mainnet.DAI, amount)
        await recoverTx.wait()

        expect(await token.balanceOf(await subject.getAddress())).to.be.equal(
          BigInt(0)
        )
      })

      it('should successfully recover by agent ERC20', async () => {
        expect(await token.balanceOf(await subject.getAddress())).to.be.equal(
          amount
        )
        network.provider.request({
          method: 'hardhat_impersonateAccount',
          params: [mainnet.AGENT],
        })
        const agent = await ethers.provider.getSigner(mainnet.AGENT)
        const localSubject = await ethers.getContractAt(
          'Order',
          await subject.getAddress(),
          agent
        )
        const recoverTx = await localSubject.recoverERC20(mainnet.DAI, amount)
        await recoverTx.wait()

        expect(await token.balanceOf(await subject.getAddress())).to.be.equal(
          BigInt(0)
        )
      })

      it('should revert if it is called by stranger ERC20', async () => {
        const localSubject = await ethers.getContractAt(
          'Order',
          await subject.getAddress(),
          (await ethers.getSigners())[2]
        )

        await expect(
          localSubject.recoverERC20(mainnet.DAI, amount)
        ).to.be.revertedWithCustomError(subject, 'NotAgentOrManager')
      })
    })

    describe('recovering ERC721:', async function () {
      let snapshotId: string
      this.beforeEach(async function () {
        snapshotId = await network.provider.send('evm_snapshot')

        const nftHolder = (await ethers.getSigners())[0].address
        await nft721.transferFrom(nftHolder, subjectAddress, nftId)
      })

      this.afterEach(async function () {
        await network.provider.send('evm_revert', [snapshotId])
      })

      it('should successfully recover ERC721', async () => {
        const nftAddress = await nft721.getAddress()

        expect(await nft721.ownerOf(nftId)).to.equal(subjectAddress)

        const recoverTx = await subject.recoverERC721(nftAddress, nftId)
        await recoverTx.wait()

        expect(await nft721.ownerOf(nftId)).to.equal(mainnet.AGENT)
      })

      it('should successfully recover by agent ERC721', async () => {
        const nftAddress = await nft721.getAddress()

        expect(await nft721.ownerOf(nftId)).to.equal(subjectAddress)

        network.provider.request({
          method: 'hardhat_impersonateAccount',
          params: [mainnet.AGENT],
        })

        const recoverTx = await subject.recoverERC721(nftAddress, nftId)
        await recoverTx.wait()

        expect(await nft721.ownerOf(nftId)).to.equal(mainnet.AGENT)
      })

      it('should revert if it is called by stranger ERC721', async () => {
        const nftAddress = await nft721.getAddress()

        expect(await nft721.ownerOf(nftId)).to.equal(subjectAddress)
        const stranger = (await ethers.getSigners())[2]

        network.provider.request({
          method: 'hardhat_impersonateAccount',
          params: [stranger],
        })

        const localSubject = await ethers.getContractAt(
          'Order',
          await subject.getAddress(),
          stranger
        )

        expect(
          localSubject.recoverERC721(nftAddress, nftId)
        ).to.be.revertedWithCustomError(localSubject, 'NotAgentOrManager')
      })
    })

    describe('recovering ERC1155:', async function () {
      it('should successfully recover recover ERC1155', async () => {
        const nftHolder = (await ethers.getSigners())[0].address

        expect(await nft1155.balanceOf(nftHolder, nftId)).to.equal(10)
        expect(await nft1155.balanceOf(mainnet.AGENT, nftId)).to.equal(0)

        // cannot fully test recoverERC115 because subjectAddress can't receive ERC1155
        await expect(
          nft1155.safeTransferFrom(
            nftHolder,
            subjectAddress,
            BigInt(nftId),
            BigInt(4),
            '0x'
          )
        ).to.be.revertedWith(
          'ERC1155: transfer to non-ERC1155Receiver implementer'
        )
      })
    })
  })

  this.afterAll(async function () {
    await network.provider.send('evm_revert', [snapshotId])
  })
})
