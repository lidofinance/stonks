import { ethers, network } from 'hardhat'
import { expect } from 'chai'
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs'
import { AmountConverterFactory } from '../../typechain-types'

import { mainnet } from '../../utils/contracts'

describe('AmountConverterFactory', function () {
  let subject: AmountConverterFactory
  let snapshotId: string

  this.beforeAll(async function () {
    const ContractFactory = await ethers.getContractFactory(
      'AmountConverterFactory'
    )

    subject = await ContractFactory.deploy(
      mainnet.CHAINLINK_PRICE_FEED_REGISTRY
    )
    await subject.waitForDeployment()

    snapshotId = await network.provider.send('evm_snapshot')
  })

  describe('initialization:', async function () {
    it('should have right treasury address', async function () {
      expect(await subject.feedRegistry()).to.equal(
        mainnet.CHAINLINK_PRICE_FEED_REGISTRY
      )
    })
  })
  describe('amount converter deployment:', async function () {
    it('should deploy stonks with correct params', async function () {
      const conversionTarget = mainnet.CHAINLINK_USD_QUOTE
      const tokensFrom = [mainnet.STETH]
      const tokensTo = [mainnet.DAI]

      await expect(
        subject.deployAmountConverter(conversionTarget, tokensFrom, tokensTo)
      )
        .to.emit(subject, 'AmountConverterDeployed')
        .withArgs(
          anyValue,
          mainnet.CHAINLINK_PRICE_FEED_REGISTRY,
          conversionTarget,
          tokensFrom,
          tokensTo
        )
    })
  })

  this.afterAll(async function () {
    await network.provider.send('evm_revert', [snapshotId])
  })
})
