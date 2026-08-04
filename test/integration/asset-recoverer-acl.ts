import { ethers } from 'hardhat'
import { expect } from 'chai'
import { parseEther, Signer } from 'ethers'
import {
  impersonateAccount,
  setBalance,
  takeSnapshot,
  SnapshotRestorer,
} from '@nomicfoundation/hardhat-network-helpers'
import { getContracts } from '../../utils/contracts'
import { AssetRecovererACLHarness, AssetRecovererACLHarness__factory } from '../../typechain-types'

const contracts = getContracts()

const MANAGER_ROLE = ethers.id('Buybacks.MANAGER_ROLE')
const RECOVERY_AMOUNT = parseEther('10')

// stETH transfers move shares and lose up to 1 wei each. Funding then recovery is two transfers.
const STETH_ROUNDING_TOLERANCE = 2n

describe('AssetRecovererACL: real-token recovery (mainnet fork)', function () {
  let snapshot: SnapshotRestorer
  let assetRecovererACL: AssetRecovererACLHarness
  let assetRecovererACLAddress: string
  let manager: Signer
  let treasuryAddress: string
  let agent: Signer

  before(async function () {
    snapshot = await takeSnapshot()

    const [admin, managerSigner, treasury] = await ethers.getSigners()
    manager = managerSigner
    treasuryAddress = treasury.address

    assetRecovererACL = await new AssetRecovererACLHarness__factory(admin).deploy(
      admin.address,
      treasury.address
    )
    await assetRecovererACL.waitForDeployment()
    assetRecovererACLAddress = await assetRecovererACL.getAddress()
    await assetRecovererACL.connect(admin).grantRole(MANAGER_ROLE, await manager.getAddress())

    await impersonateAccount(contracts.AGENT)
    await setBalance(contracts.AGENT, parseEther('100'))
    agent = await ethers.getSigner(contracts.AGENT)
  })

  after(async function () {
    await snapshot.restore()
  })

  it('should recover rebasing stETH to TREASURY', async function () {
    const stETH = await ethers.getContractAt('IERC20', contracts.STETH)
    await stETH.connect(agent).transfer(assetRecovererACLAddress, RECOVERY_AMOUNT)

    const held = await stETH.balanceOf(assetRecovererACLAddress)
    const treasuryBefore = await stETH.balanceOf(treasuryAddress)

    await assetRecovererACL.connect(manager).recoverERC20(contracts.STETH, held)

    expect(await stETH.balanceOf(assetRecovererACLAddress)).to.be.closeTo(
      0n,
      STETH_ROUNDING_TOLERANCE
    )
    expect(await stETH.balanceOf(treasuryAddress)).to.be.closeTo(
      treasuryBefore + held,
      STETH_ROUNDING_TOLERANCE
    )
  })

  it('should recover standard LDO to TREASURY', async function () {
    const ldo = await ethers.getContractAt('IERC20', contracts.LDO)
    await ldo.connect(agent).transfer(assetRecovererACLAddress, RECOVERY_AMOUNT)

    await expect(
      assetRecovererACL.connect(manager).recoverERC20(contracts.LDO, RECOVERY_AMOUNT)
    ).to.changeTokenBalances(
      ldo,
      [assetRecovererACL, treasuryAddress],
      [-RECOVERY_AMOUNT, RECOVERY_AMOUNT]
    )
  })

  it('should recover standard wstETH to TREASURY', async function () {
    const wstETH = await ethers.getContractAt('IWstETH', contracts.WSTETH)
    const stETH = await ethers.getContractAt('IERC20', contracts.STETH)

    // AGENT holds stETH, not wstETH. Wrap a fixed stETH amount and fund the harness with the
    // exact minted wstETH, which equals getWstETHByStETH of the wrapped amount.
    const wrappedAmount = await wstETH.getWstETHByStETH(RECOVERY_AMOUNT)
    await stETH.connect(agent).approve(contracts.WSTETH, RECOVERY_AMOUNT)
    await wstETH.connect(agent).wrap(RECOVERY_AMOUNT)
    await wstETH.connect(agent).transfer(assetRecovererACLAddress, wrappedAmount)

    await expect(
      assetRecovererACL.connect(manager).recoverERC20(contracts.WSTETH, wrappedAmount)
    ).to.changeTokenBalances(
      wstETH,
      [assetRecovererACL, treasuryAddress],
      [-wrappedAmount, wrappedAmount]
    )
  })
})
