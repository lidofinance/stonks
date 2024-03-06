import { ethers } from 'hardhat'
import { expect } from 'chai'

const STONKS_FACTORY_ADDRESS = ''

describe('StonksFactory: acceptance', async function () {
  it('should have correct agent address', async function () {
    if (STONKS_FACTORY_ADDRESS === '') this.skip()
    const stonksFactory = await ethers.getContractAt('StonksFactory', STONKS_FACTORY_ADDRESS)
    // https://docs.lido.fi/deployed-contracts/
    expect(await stonksFactory.AGENT()).to.equal('0x3e40D73EB977Dc6a537aF587D48316feE66E9C8c')
  })
})
