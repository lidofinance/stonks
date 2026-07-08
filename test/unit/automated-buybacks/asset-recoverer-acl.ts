import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture, setBalance } from '@nomicfoundation/hardhat-toolbox/network-helpers'

import {
  AssetRecovererACLHarness__factory,
  RevertingEtherReceiver__factory,
  NoReturnValueERC20__factory,
  ERC_20__factory,
} from '../../../typechain-types'

const MANAGER_ROLE = ethers.id('NEST.MANAGER_ROLE')
const DEFAULT_ADMIN_ROLE = ethers.ZeroHash

const ONE_ETHER = 10n ** 18n
const ZERO_AMOUNT = 0n
const TOKEN_AMOUNT = 1000n * ONE_ETHER

// OZ v4.9.3 `onlyRole` reverts with this exact string. Addresses and role hashes are
// rendered lowercase by `Strings.toHexString`.
function missingRoleMessage(account: string, role: string): string {
  return `AccessControl: account ${account.toLowerCase()} is missing role ${role}`
}

describe('AssetRecovererACL', function () {
  // Deploy the harness and a mock token. No role beyond the constructor grant, so the
  // constructor tests can assert that `MANAGER_ROLE` has no members at deploy.
  async function deployFixture() {
    const [admin, manager, stranger, treasury] = await ethers.getSigners()

    const harnessFactory = new AssetRecovererACLHarness__factory(admin)
    const assetRecovererACL = await harnessFactory.deploy(admin.address, treasury.address)
    await assetRecovererACL.waitForDeployment()

    const tokenFactory = new ERC_20__factory(admin)
    const token = await tokenFactory.deploy()
    await token.waitForDeployment()

    return {
      assetRecovererACL,
      token,
      harnessFactory,
      admin,
      manager,
      stranger,
      treasury,
    }
  }

  // Grant `MANAGER_ROLE` to the manager once. `loadFixture` snapshots after the grant and
  // restores it between tests, so the grant never re-runs.
  async function deployWithManagerFixture() {
    const context = await deployFixture()
    await context.assetRecovererACL
      .connect(context.admin)
      .grantRole(MANAGER_ROLE, context.manager.address)
    return context
  }

  // Manager-enabled harness pre-funded with the mock token for the ERC-20 recovery tests.
  async function deployFundedFixture() {
    const context = await deployWithManagerFixture()
    await context.token
      .connect(context.admin)
      .transfer(await context.assetRecovererACL.getAddress(), TOKEN_AMOUNT)
    return context
  }

  describe('constructor:', function () {
    it('should grant DEFAULT_ADMIN_ROLE to admin and emit RoleGranted', async function () {
      const { assetRecovererACL, admin } = await loadFixture(deployFixture)

      expect(await assetRecovererACL.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true)
      expect(await assetRecovererACL.getRoleMemberCount(DEFAULT_ADMIN_ROLE)).to.equal(1n)
      expect(await assetRecovererACL.getRoleMember(DEFAULT_ADMIN_ROLE, 0)).to.equal(admin.address)

      await expect(assetRecovererACL.deploymentTransaction())
        .to.emit(assetRecovererACL, 'RoleGranted')
        .withArgs(DEFAULT_ADMIN_ROLE, admin.address, admin.address)
    })

    it('should set the immutable TREASURY to treasury_', async function () {
      const { assetRecovererACL, treasury } = await loadFixture(deployFixture)
      expect(await assetRecovererACL.TREASURY()).to.equal(treasury.address)
    })

    it('should revert InvalidAdminAddress when admin_ is zero', async function () {
      const { assetRecovererACL, harnessFactory, treasury } = await loadFixture(deployFixture)

      await expect(
        harnessFactory.deploy(ethers.ZeroAddress, treasury.address)
      ).to.be.revertedWithCustomError(assetRecovererACL, 'InvalidAdminAddress')
    })

    it('should revert InvalidTreasuryAddress when treasury_ is zero', async function () {
      const { assetRecovererACL, harnessFactory, admin } = await loadFixture(deployFixture)

      await expect(
        harnessFactory.deploy(admin.address, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(assetRecovererACL, 'InvalidTreasuryAddress')
    })

    it('should expose MANAGER_ROLE as keccak256("NEST.MANAGER_ROLE") with no members at deploy', async function () {
      const { assetRecovererACL } = await loadFixture(deployFixture)

      expect(await assetRecovererACL.MANAGER_ROLE()).to.equal(MANAGER_ROLE)
      expect(await assetRecovererACL.getRoleMemberCount(MANAGER_ROLE)).to.equal(ZERO_AMOUNT)
    })
  })

  describe('#recoverEther', function () {
    it('should revert for a caller without MANAGER_ROLE', async function () {
      const { assetRecovererACL, stranger } = await loadFixture(deployWithManagerFixture)

      await expect(assetRecovererACL.connect(stranger).recoverEther()).to.be.revertedWith(
        missingRoleMessage(stranger.address, MANAGER_ROLE)
      )
    })

    it('should sweep the entire ETH balance to TREASURY', async function () {
      const { assetRecovererACL, manager, treasury } = await loadFixture(deployWithManagerFixture)
      const assetRecovererACLAddress = await assetRecovererACL.getAddress()
      await setBalance(assetRecovererACLAddress, ONE_ETHER)

      await expect(assetRecovererACL.connect(manager).recoverEther()).to.changeEtherBalances(
        [assetRecovererACL, treasury],
        [-ONE_ETHER, ONE_ETHER]
      )

      expect(await ethers.provider.getBalance(assetRecovererACLAddress)).to.equal(ZERO_AMOUNT)
    })

    it('should move nothing when the balance is zero', async function () {
      const { assetRecovererACL, manager, treasury } = await loadFixture(deployWithManagerFixture)

      expect(await ethers.provider.getBalance(await assetRecovererACL.getAddress())).to.equal(
        ZERO_AMOUNT
      )

      await expect(assetRecovererACL.connect(manager).recoverEther()).to.changeEtherBalances(
        [assetRecovererACL, treasury],
        [ZERO_AMOUNT, ZERO_AMOUNT]
      )
    })

    it('should let DEFAULT_ADMIN_ROLE grant MANAGER_ROLE and then recover', async function () {
      const { assetRecovererACL, admin, stranger, treasury } = await loadFixture(deployFixture)
      await setBalance(await assetRecovererACL.getAddress(), ONE_ETHER)

      await assetRecovererACL.connect(admin).grantRole(MANAGER_ROLE, stranger.address)

      await expect(assetRecovererACL.connect(stranger).recoverEther()).to.changeEtherBalances(
        [assetRecovererACL, treasury],
        [-ONE_ETHER, ONE_ETHER]
      )
    })

    it('should propagate the revert when TREASURY rejects ETH', async function () {
      const { harnessFactory, admin, manager } = await loadFixture(deployFixture)

      const receiver = await new RevertingEtherReceiver__factory(admin).deploy()
      await receiver.waitForDeployment()

      const rejectingRecoverer = await harnessFactory.deploy(
        admin.address,
        await receiver.getAddress()
      )
      await rejectingRecoverer.waitForDeployment()
      await rejectingRecoverer.connect(admin).grantRole(MANAGER_ROLE, manager.address)
      await setBalance(await rejectingRecoverer.getAddress(), ONE_ETHER)

      await expect(rejectingRecoverer.connect(manager).recoverEther()).to.be.revertedWith(
        'Address: unable to send value, recipient may have reverted'
      )
    })

    it('should emit EtherRecovered with the swept amount', async function () {
      const { assetRecovererACL, manager } = await loadFixture(deployWithManagerFixture)
      await setBalance(await assetRecovererACL.getAddress(), ONE_ETHER)

      await expect(assetRecovererACL.connect(manager).recoverEther())
        .to.emit(assetRecovererACL, 'EtherRecovered')
        .withArgs(ONE_ETHER)
    })

    it('should emit EtherRecovered(0) when the balance is zero', async function () {
      const { assetRecovererACL, manager } = await loadFixture(deployWithManagerFixture)

      await expect(assetRecovererACL.connect(manager).recoverEther())
        .to.emit(assetRecovererACL, 'EtherRecovered')
        .withArgs(ZERO_AMOUNT)
    })
  })

  describe('#recoverERC20', function () {
    it('should revert for a caller without MANAGER_ROLE', async function () {
      const { assetRecovererACL, token, stranger } = await loadFixture(deployFundedFixture)

      await expect(
        assetRecovererACL.connect(stranger).recoverERC20(await token.getAddress(), TOKEN_AMOUNT)
      ).to.be.revertedWith(missingRoleMessage(stranger.address, MANAGER_ROLE))
    })

    it('should revert when amount_ exceeds the contract balance', async function () {
      const { assetRecovererACL, token, manager } = await loadFixture(deployFundedFixture)

      await expect(
        assetRecovererACL.connect(manager).recoverERC20(await token.getAddress(), TOKEN_AMOUNT + 1n)
      ).to.be.revertedWith('ERC20: transfer amount exceeds balance')
    })

    it('should transfer amount_ of token_ to TREASURY', async function () {
      const { assetRecovererACL, token, manager, treasury } = await loadFixture(deployFundedFixture)

      await expect(
        assetRecovererACL.connect(manager).recoverERC20(await token.getAddress(), TOKEN_AMOUNT)
      ).to.changeTokenBalances(token, [assetRecovererACL, treasury], [-TOKEN_AMOUNT, TOKEN_AMOUNT])
    })

    it('should emit ERC20Recovered with the indexed token and amount', async function () {
      const { assetRecovererACL, token, manager } = await loadFixture(deployFundedFixture)
      const tokenAddress = await token.getAddress()

      await expect(assetRecovererACL.connect(manager).recoverERC20(tokenAddress, TOKEN_AMOUNT))
        .to.emit(assetRecovererACL, 'ERC20Recovered')
        .withArgs(tokenAddress, TOKEN_AMOUNT)
    })

    it('should emit ERC20Recovered before performing the transfer', async function () {
      const { assetRecovererACL, token, manager } = await loadFixture(deployFundedFixture)
      const assetRecovererACLAddress = await assetRecovererACL.getAddress()
      const tokenAddress = await token.getAddress()

      const tx = await assetRecovererACL.connect(manager).recoverERC20(tokenAddress, TOKEN_AMOUNT)
      const receipt = await tx.wait()

      const recoveredLog = receipt!.logs.find((log) => log.address === assetRecovererACLAddress)
      const transferLog = receipt!.logs.find((log) => log.address === tokenAddress)

      expect(recoveredLog!.index).to.be.lessThan(transferLog!.index)
    })

    it('should recover a partial balance and leave the remainder', async function () {
      const { assetRecovererACL, token, manager, treasury } = await loadFixture(deployFundedFixture)
      const partialAmount = TOKEN_AMOUNT / 4n

      await expect(
        assetRecovererACL.connect(manager).recoverERC20(await token.getAddress(), partialAmount)
      ).to.changeTokenBalances(
        token,
        [assetRecovererACL, treasury],
        [-partialAmount, partialAmount]
      )

      expect(await token.balanceOf(await assetRecovererACL.getAddress())).to.equal(
        TOKEN_AMOUNT - partialAmount
      )
    })

    it('should recover a token that returns no value from transfer', async function () {
      const { assetRecovererACL, admin, manager, treasury } =
        await loadFixture(deployWithManagerFixture)
      const assetRecovererACLAddress = await assetRecovererACL.getAddress()

      const noReturnToken = await new NoReturnValueERC20__factory(admin).deploy(TOKEN_AMOUNT)
      await noReturnToken.waitForDeployment()
      const noReturnTokenAddress = await noReturnToken.getAddress()
      await noReturnToken.connect(admin).transfer(assetRecovererACLAddress, TOKEN_AMOUNT)

      await assetRecovererACL.connect(manager).recoverERC20(noReturnTokenAddress, TOKEN_AMOUNT)

      expect(await noReturnToken.balanceOf(assetRecovererACLAddress)).to.equal(ZERO_AMOUNT)
      expect(await noReturnToken.balanceOf(treasury.address)).to.equal(TOKEN_AMOUNT)
    })
  })
})
