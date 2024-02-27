import { ethers } from 'hardhat'
import { expect } from 'chai'
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import { AmountConverterFactory, AmountConverterFactory__factory } from '../../typechain-types'

import { mainnet } from '../../utils/contracts'

describe('AmountConverterFactory', function () {
  let subject: AmountConverterFactory
  let contractFactory: AmountConverterFactory__factory
  let snapshot: SnapshotRestorer

  this.beforeAll(async function () {
    snapshot = await takeSnapshot()

    contractFactory = await ethers.getContractFactory('AmountConverterFactory')
    subject = await contractFactory.deploy(mainnet.CHAINLINK_PRICE_FEED_REGISTRY)
    await subject.waitForDeployment()
  })

  describe('initialization:', async function () {
    it('should have right treasury address after deploy', async function () {
      expect(await subject.FEED_REGISTRY()).to.equal(mainnet.CHAINLINK_PRICE_FEED_REGISTRY)
    })
    it('should revert with zero feed registry address', async function () {
      await expect(contractFactory.deploy(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(contractFactory, 'InvalidFeedRegistryAddress')
        .withArgs(ethers.ZeroAddress)
    })
    it('should emit FeedRegistrySet event on deployment', async function () {
      const subject = await contractFactory.deploy(mainnet.CHAINLINK_PRICE_FEED_REGISTRY)
      const tx = subject.deploymentTransaction()
      await expect(tx)
        .to.emit(subject, 'FeedRegistrySet')
        .withArgs(mainnet.CHAINLINK_PRICE_FEED_REGISTRY)
    })
  })
  describe('amount converter deployment:', async function () {
    it('should emit AmountConverterDeployed event with correct params at Stonks deploy', async function () {
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
    await snapshot.restore()
  })
})
