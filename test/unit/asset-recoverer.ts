import { ethers, network } from 'hardhat'
import { Signer } from 'ethers'
import { expect } from 'chai'
import {
  setBalance,
  impersonateAccount,
  takeSnapshot,
  SnapshotRestorer,
} from '@nomicfoundation/hardhat-network-helpers'
import { fillUpERC20FromTreasury } from '../../utils/fill-up-balance'
import { getContracts } from '../../utils/contracts'
import {
  AssetRecovererTest,
  IERC20,
  IERC721,
  IERC1155,
  AssetRecovererTest__factory,
} from '../../typechain-types'

const contracts = getContracts()

describe('Asset recoverer', async function () {
  let snapshot: SnapshotRestorer
  let subject: AssetRecovererTest
  let manager: Signer
  let anotherManager: Signer
  let contractFactory: AssetRecovererTest__factory

  before(async function () {
    snapshot = await takeSnapshot()
    manager = (await ethers.getSigners())[1]
    anotherManager = (await ethers.getSigners())[2]

    contractFactory = await ethers.getContractFactory('AssetRecovererTest')
    const assetRecoverer = await contractFactory.deploy(
      contracts.ADMIN,
      contracts.AGENT,
      await manager.getAddress()
    )

    await assetRecoverer.waitForDeployment()
    subject = assetRecoverer.connect(manager)
  })

  describe('initialization:', async function () {
    it('should have right admin, manager and agent addresses after deploy', async function () {
      expect(await subject.ADMIN()).to.equal(contracts.ADMIN)
      expect(await subject.AGENT()).to.equal(contracts.AGENT)
      expect(await subject.manager()).to.equal(await manager.getAddress())
    })
    it('should revert deploy with agent zero adress', async function () {
      await expect(contractFactory.deploy(contracts.ADMIN, ethers.ZeroAddress, manager)).to.be
        .reverted
    })
  })

  describe('manager changing:', async function () {
    let localSnapshotId: string
    before(async function () {
      localSnapshotId = await network.provider.send('evm_snapshot')
    })
    it('should allow an admin to change manager', async function () {
      expect(await subject.manager()).to.equal(await manager.getAddress())

      await setBalance(contracts.ADMIN, ethers.parseEther('100'))
      await impersonateAccount(contracts.ADMIN)

      const admin = await ethers.provider.getSigner(contracts.ADMIN)
      const newManagerAddress = await anotherManager.getAddress()
      const subjectAdminSigner = subject.connect(admin)

      await subjectAdminSigner.setManager(anotherManager, {
        from: admin,
      })
      expect(await subject.manager()).to.equal(newManagerAddress)
      expect(await subject.manager()).to.not.equal(await manager.getAddress())
    })
    it("shouldn't allow a manager to change manager", async function () {
      const subjectManagerSigner = subject.connect(manager)
      await expect(subjectManagerSigner.setManager(anotherManager))
        .to.be.revertedWithCustomError(subject, 'NotAdmin')
        .withArgs(await manager.getAddress())
    })
    it("shouldn't allow a stranger to change manager", async function () {
      const signer = (await ethers.getSigners())[3]
      const subjectStrangerSigner = subject.connect(signer)
      await expect(subjectStrangerSigner.setManager(anotherManager))
        .to.be.revertedWithCustomError(subject, 'NotAdmin')
        .withArgs(await signer.getAddress())
    })
    after(async function () {
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

    before(async function () {
      token = await ethers.getContractAt('IERC20', contracts.DAI)
      subjectAddress = await subject.getAddress()

      const NFT721 = await ethers.getContractFactory('NFT_721')
      nft721 = await NFT721.deploy('NFT_721', 'N721')
      await nft721.waitForDeployment()
    })

    describe('recovering Ether:', async function () {
      let snapshotId: string
      beforeEach(async function () {
        snapshotId = await network.provider.send('evm_snapshot')
        await setBalance(subjectAddress, amount)
      })

      afterEach(async function () {
        await network.provider.send('evm_revert', [snapshotId])
      })

      it('should successfully recover Ether', async function () {
        const subjectBalanceBefore = await ethers.provider.getBalance(subject)
        const treasuryBalanceBefore = await ethers.provider.getBalance(contracts.AGENT)

        expect(subjectBalanceBefore).to.be.equal(amount)

        const recoverTx = await subject.recoverEther()
        await recoverTx.wait()

        const subjectBalanceAfter = await ethers.provider.getBalance(subject)
        const treasuryBalanceAfter = await ethers.provider.getBalance(contracts.AGENT)

        expect(subjectBalanceAfter).to.be.equal(subjectBalanceBefore - amount)
        expect(treasuryBalanceAfter).to.be.equal(treasuryBalanceBefore + amount)
      })

      it('should revert if it is called by stranger Ether', async function () {
        const signer = (await ethers.getSigners())[2]
        const localSubject = await ethers.getContractAt('Order', subject, signer)

        await expect(localSubject.recoverEther())
          .to.be.revertedWithCustomError(subject, 'NotAdminOrManager')
          .withArgs(await signer.getAddress())
      })
    })

    describe('recovering ERC20:', async function () {
      let snapshotId: string
      beforeEach(async function () {
        snapshotId = await network.provider.send('evm_snapshot')
        await fillUpERC20FromTreasury({
          amount,
          token: contracts.DAI,
          address: subjectAddress,
        })
      })

      afterEach(async function () {
        await network.provider.send('evm_revert', [snapshotId])
      })

      it('should successfully recover ERC20', async function () {
        expect(await token.balanceOf(subject)).to.be.equal(amount)

        const recoverTx = await subject.recoverERC20(contracts.DAI, amount)
        await recoverTx.wait()

        expect(await token.balanceOf(subject)).to.be.equal(BigInt(0))
      })
      it('should successfully recover by manager ERC20', async function () {
        expect(await token.balanceOf(subject)).to.be.equal(amount)
        const localSubject = subject.connect(manager)

        const recoverTx = await localSubject.recoverERC20(contracts.DAI, amount)
        await recoverTx.wait()

        expect(await token.balanceOf(subject)).to.be.equal(BigInt(0))
      })

      it('should successfully recover by admin ERC20', async function () {
        expect(await token.balanceOf(subject)).to.be.equal(amount)

        await impersonateAccount(contracts.ADMIN)
        await setBalance(contracts.ADMIN, ethers.parseEther('1'))

        const admin = await ethers.provider.getSigner(contracts.ADMIN)
        const localSubject = subject.connect(admin)
        const recoverTx = await localSubject.recoverERC20(contracts.DAI, amount)
        await recoverTx.wait()

        expect(await token.balanceOf(subject)).to.be.equal(BigInt(0))
      })

      it('should revert if it is called by stranger ERC20', async function () {
        const localSubject = subject.connect(anotherManager)

        await expect(localSubject.recoverERC20(contracts.DAI, amount))
          .to.be.revertedWithCustomError(subject, 'NotAdminOrManager')
          .withArgs(await anotherManager.getAddress())
      })
    })

    describe('recovering ERC721:', async function () {
      let snapshotId: string
      beforeEach(async function () {
        snapshotId = await network.provider.send('evm_snapshot')

        const nftReceiver = (await ethers.getSigners())[0].address
        await nft721.transferFrom(nftReceiver, subjectAddress, nftId)
      })

      afterEach(async function () {
        await network.provider.send('evm_revert', [snapshotId])
      })

      it('should successfully recover ERC721', async function () {
        const nftAddress = await nft721.getAddress()

        expect(await nft721.ownerOf(nftId)).to.equal(subjectAddress)

        const recoverTx = await subject.recoverERC721(nftAddress, nftId)
        await recoverTx.wait()

        expect(await nft721.ownerOf(nftId)).to.equal(contracts.AGENT)
      })

      it('should successfully recover by agent ERC721', async function () {
        const nftAddress = await nft721.getAddress()

        expect(await nft721.ownerOf(nftId)).to.equal(subjectAddress)

        impersonateAccount(contracts.AGENT)

        const recoverTx = await subject.recoverERC721(nftAddress, nftId)
        await recoverTx.wait()

        expect(await nft721.ownerOf(nftId)).to.equal(contracts.AGENT)
      })

      it('should revert if it is called by stranger ERC721', async function () {
        const nftAddress = await nft721.getAddress()

        expect(await nft721.ownerOf(nftId)).to.equal(subjectAddress)

        const localSubject = subject.connect(anotherManager)

        expect(localSubject.recoverERC721(nftAddress, nftId))
          .to.be.revertedWithCustomError(localSubject, 'NotAdminOrManager')
          .withArgs(await anotherManager.getAddress())
      })
    })

    describe('recovering ERC1155:', async function () {
      let nft1155Receiver: string
      let nft1155ReceiverSigner: Signer

      before(async function () {
        nft1155Receiver = ethers.getCreateAddress({
          from: '0x0000000000000000000000000000000000000001',
          nonce: 0,
        })

        await setBalance(nft1155Receiver, ethers.parseEther('1'))
        await impersonateAccount(nft1155Receiver)
        nft1155ReceiverSigner = await ethers.getSigner(nft1155Receiver)

        const NFT1155 = await ethers.getContractFactory('NFT_1155')
        nft1155 = await NFT1155.deploy('https://game.example/api/item/{id}.json', nft1155Receiver)

        await nft1155.waitForDeployment()
      })

      it('should successfully recover recover ERC1155', async function () {
        expect(await nft1155.balanceOf(nft1155Receiver, nftId)).to.equal(10)
        expect(await nft1155.balanceOf(subjectAddress, nftId)).to.equal(0)
        expect(await nft1155.balanceOf(contracts.AGENT, nftId)).to.equal(0)

        await expect(
          nft1155
            .connect(nft1155ReceiverSigner)
            .safeTransferFrom(nft1155Receiver, subjectAddress, BigInt(nftId), BigInt(4), '0x')
        ).to.be.revertedWith('ERC1155: transfer to non-ERC1155Receiver implementer')
      })
    })
  })

  after(async function () {
    await snapshot.restore()
  })
})
