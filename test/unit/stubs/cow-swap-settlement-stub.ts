import { assert } from 'chai'
import { ethers } from 'hardhat'
import { CoWSwapSettlementStub__factory } from '../../../typechain-types/factories/contracts/stubs'

describe('CoWSwapSettlementStub', () => {
  it('domainSeparator()', async () => {
    const [deployer] = await ethers.getSigners()
    const settlement = await new CoWSwapSettlementStub__factory(deployer).deploy()

    const domainTypeHash = ethers.id(
      'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
    )
    const domainName = ethers.id('Settlement Instance Stub')
    const domainVersion = ethers.id('v2')

    const { chainId } = await ethers.provider.getNetwork()
    const expectedDomainSeparator = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
        [domainTypeHash, domainName, domainVersion, chainId, await settlement.getAddress()]
      )
    )
    assert.equal(await settlement.domainSeparator(), expectedDomainSeparator)
  })
})
