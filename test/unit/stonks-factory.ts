import { ethers, network } from 'hardhat'
import {
  TokenAmountConverter,
  StonksFactory,
} from '../../typechain-types'

import { mainnet } from '../../utils/contracts'

describe.skip('Stonks factory', function () {
  let subject: StonksFactory
  let snapshotId: string

  this.beforeAll(async function () {
    const ContractFactory = await ethers.getContractFactory('StonksFactory')

    subject = await ContractFactory.deploy()
    await subject.waitForDeployment()

    snapshotId = await network.provider.send('evm_snapshot')
  })

  describe('Deploing price checker', async function () {
    let tokenConverter: TokenAmountConverter

    it('Should deploy price checker with correct params', async () => {
      const deployTx = await subject.deployChainLinkTokenConverter(
        mainnet.CHAINLINK_PRICE_FEED_REGISTRY,
        [mainnet.STETH],
        [mainnet.DAI]
      )
    })
  })
  describe('Deploing stonks', async function () {})

  this.afterAll(async function () {
    await network.provider.send('evm_revert', [snapshotId])
  })
})
