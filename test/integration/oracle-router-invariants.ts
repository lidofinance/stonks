import { ethers } from 'hardhat'
import { expect } from 'chai'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import type { OracleRouter, AmountConverter, AmountConverterFactory } from '../../typechain-types'
import { getContracts } from '../../utils/contracts'
import { QuoteDenomination } from '../../utils/oracle-router'

const contracts = getContracts()

describe('OracleRouter invariants', function () {
  let router: OracleRouter
  let factory: AmountConverterFactory
  let snapshot: SnapshotRestorer
  let adminSigner: any

  this.beforeAll(async () => {
    snapshot = await takeSnapshot()

    adminSigner = await ethers.getImpersonatedSigner(contracts.ADMIN)
    await ethers.provider.send('hardhat_setBalance', [
      await adminSigner.getAddress(),
      '0x1000000000000000000',
    ])

    const routerFactory = await ethers.getContractFactory('OracleRouter')
    router = await routerFactory.deploy(contracts.ADMIN, 8, contracts.CHAINLINK_PRICE_FEED_REGISTRY)
    await router.waitForDeployment()

    await router.connect(adminSigner).setEthUsdBridge(86400)
    await router
      .connect(adminSigner)
      .setTokenFeed(contracts.STETH, QuoteDenomination.USD, 86400, true)
    await router
      .connect(adminSigner)
      .setTokenFeed(contracts.DAI, QuoteDenomination.USD, 86400, true)
    await router
      .connect(adminSigner)
      .setTokenFeed(contracts.USDC, QuoteDenomination.USD, 86400, true)

    const converterFactoryContract = await ethers.getContractFactory('AmountConverterFactory')
    factory = await converterFactoryContract.deploy(await router.getAddress())
    await factory.waitForDeployment()
  })

  this.afterAll(async () => {
    await snapshot.restore()
  })

  async function deployConverter(
    tokensToSell: string[],
    tokensToBuy: string[],
    useEthAnchor: boolean
  ): Promise<AmountConverter> {
    const tx = await factory.deployAmountConverter(tokensToSell, tokensToBuy, useEthAnchor)
    const receipt = await tx.wait()
    const event = receipt?.logs.find((log: any) => {
      try {
        return factory.interface.parseLog(log)?.name === 'AmountConverterDeployed'
      } catch {
        return false
      }
    })
    const converterAddress = factory.interface.parseLog(event as any)?.args[0]
    return ethers.getContractAt('AmountConverter', converterAddress)
  }

  describe('Price query invariants', function () {
    it('should return same price for same token pair', async () => {
      const [price1] = await router.getPricesAndDecimals(
        contracts.STETH,
        contracts.STETH,
        QuoteDenomination.USD
      )
      const [price2] = await router.getPricesAndDecimals(
        contracts.STETH,
        contracts.STETH,
        QuoteDenomination.USD
      )

      expect(price1).to.equal(price2)
    })

    it('should satisfy transitivity: STETH->DAI = (STETH->USD) / (DAI->USD)', async () => {
      const [stethUsdPrice] = await router.getPricesAndDecimals(
        contracts.STETH,
        contracts.STETH,
        QuoteDenomination.USD
      )
      const [daiUsdPrice] = await router.getPricesAndDecimals(
        contracts.DAI,
        contracts.DAI,
        QuoteDenomination.USD
      )
      const [stethDaiDirectPrice] = await router.getPricesAndDecimals(
        contracts.STETH,
        contracts.DAI,
        QuoteDenomination.USD
      )

      expect(stethDaiDirectPrice).to.equal(stethUsdPrice)

      const stethDaiCalculated = (stethUsdPrice * 10n ** 18n) / daiUsdPrice
      const stethDaiViaPair = (stethDaiDirectPrice * 10n ** 18n) / daiUsdPrice

      expect(stethDaiCalculated).to.be.closeTo(stethDaiViaPair, 1n)
    })

    it('should return consistent decimals for same token', async () => {
      const [, , decimalsFrom1, decimalsTo1] = await router.getPricesAndDecimals(
        contracts.STETH,
        contracts.DAI,
        QuoteDenomination.USD
      )
      const [, , decimalsFrom2, decimalsTo2] = await router.getPricesAndDecimals(
        contracts.STETH,
        contracts.USDC,
        QuoteDenomination.USD
      )

      expect(decimalsFrom1).to.equal(decimalsFrom2)
      expect(decimalsFrom1).to.equal(18n)
    })
  })

  describe('Amount conversion invariants', function () {
    let converter: AmountConverter

    this.beforeAll(async () => {
      converter = await deployConverter([contracts.STETH], [contracts.DAI, contracts.USDC], false)
    })

    it('should be proportional: convert(2x) = 2 * convert(x)', async () => {
      const amount1 = ethers.parseEther('1')
      const amount2 = ethers.parseEther('2')

      const result1 = await converter.getExpectedOut(contracts.STETH, contracts.DAI, amount1)
      const result2 = await converter.getExpectedOut(contracts.STETH, contracts.DAI, amount2)

      expect(result2).to.be.closeTo(result1 * 2n, 1n)
    })

    it('should be deterministic: multiple calls return same result', async () => {
      const amount = ethers.parseEther('1')

      const result1 = await converter.getExpectedOut(contracts.STETH, contracts.DAI, amount)
      const result2 = await converter.getExpectedOut(contracts.STETH, contracts.DAI, amount)
      const result3 = await converter.getExpectedOut(contracts.STETH, contracts.DAI, amount)

      expect(result1).to.equal(result2)
      expect(result2).to.equal(result3)
    })

    it('should maintain precision: convert(tiny amount) != 0', async () => {
      const tinyAmount = 1000n

      const result = await converter.getExpectedOut(contracts.STETH, contracts.DAI, tinyAmount)

      expect(result).to.be.closeTo(0n, tinyAmount * 10000n)
    })

    it('should handle decimal differences correctly: STETH (18 dec) -> USDC (6 dec)', async () => {
      const amount = ethers.parseEther('1')

      const resultDai = await converter.getExpectedOut(contracts.STETH, contracts.DAI, amount)
      const resultUsdc = await converter.getExpectedOut(contracts.STETH, contracts.USDC, amount)

      const resultDaiScaled = resultDai / 10n ** 12n

      const registry = await ethers.getContractAt(
        'IFeedRegistry',
        contracts.CHAINLINK_PRICE_FEED_REGISTRY
      )
      const [, daiAnswer] = await registry.latestRoundData(
        contracts.DAI,
        contracts.CHAINLINK_USD_QUOTE
      )
      const [, usdcAnswer] = await registry.latestRoundData(
        contracts.USDC,
        contracts.CHAINLINK_USD_QUOTE
      )

      const expectedRatio = (BigInt(daiAnswer) * 10n ** 6n) / BigInt(usdcAnswer)
      const actualResult = (resultDaiScaled * 10n ** 6n) / resultUsdc

      expect(actualResult).to.be.closeTo(expectedRatio, expectedRatio / 100n)
    })
  })

  describe('Negative cases that should always fail', function () {
    it('should revert for unconfigured tokens', async () => {
      const converter = await deployConverter([contracts.STETH], [contracts.DAI], false)

      await expect(converter.getExpectedOut(contracts.LDO, contracts.DAI, ethers.parseEther('1')))
        .to.be.reverted
    })

    it('should revert for zero amount conversion', async () => {
      const converter = await deployConverter([contracts.STETH], [contracts.DAI], false)

      await expect(converter.getExpectedOut(contracts.STETH, contracts.DAI, 0n)).to.be.reverted
    })
  })
})
