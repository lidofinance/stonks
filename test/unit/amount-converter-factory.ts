import { ethers, network } from 'hardhat'
import { expect } from 'chai'
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs'
import { AmountConverterFactory } from '../../typechain-types'

import { mainnet } from '../../utils/contracts'

describe('AmountConverterFactory', function () {
  let subject: AmountConverterFactory
  let snapshotId: string

  this.beforeAll(async function () {
    snapshotId = await network.provider.send('evm_snapshot')

    const ContractFactory = await ethers.getContractFactory(
      'AmountConverterFactory'
    )
    subject = await ContractFactory.deploy(
      mainnet.CHAINLINK_PRICE_FEED_REGISTRY
    )
    await subject.waitForDeployment()
  })

  describe('initialization:', async function () {
    it('should have right treasury address', async function () {
      expect(await subject.FEED_REGISTRY()).to.equal(
        mainnet.CHAINLINK_PRICE_FEED_REGISTRY
      )
    })
    it('should revert with zero address', async function () {
      const ContractFactory = await ethers.getContractFactory(
        'AmountConverterFactory'
      )
      await expect(
        ContractFactory.deploy(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(ContractFactory, 'ZeroAddress')
    })
  })
  describe('amount converter deployment:', async function () {
    it('should deploy stonks with correct params', async function () {
      const conversionTarget = mainnet.CHAINLINK_USD_QUOTE
      const tokensFrom = [mainnet.STETH]
      const tokensTo = [mainnet.DAI]
      const priceFeedsHeartbeatTimeouts = [3600]

      await expect(
        subject.deployAmountConverter(
          conversionTarget,
          tokensFrom,
          tokensTo,
          priceFeedsHeartbeatTimeouts
        )
      )
        .to.emit(subject, 'AmountConverterDeployed')
        .withArgs(
          anyValue,
          mainnet.CHAINLINK_PRICE_FEED_REGISTRY,
          conversionTarget,
          tokensFrom,
          tokensTo,
          priceFeedsHeartbeatTimeouts
        )
    })
  })

  this.afterAll(async function () {
    await network.provider.send('evm_revert', [snapshotId])
  })
})
