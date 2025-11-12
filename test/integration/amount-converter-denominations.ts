import { ethers } from 'hardhat'
import { expect } from 'chai'
import { parseEther, parseUnits } from 'ethers'
import { takeSnapshot, SnapshotRestorer } from '@nomicfoundation/hardhat-network-helpers'
import type { AmountConverter, AmountConverterFactory, OracleRouter } from '../../typechain-types'
import { getContracts } from '../../utils/contracts'
import { deployStonks } from '../../scripts/deployments/stonks'
import { isClose } from '../../utils/assert'
import {
  getAllTestTokens,
  refreshTestFeedData,
  resetTestFeedRegistryStub,
} from '../../utils/test-feed-registry'
import { getTestOracleRouter, resetTestOracleRouter } from '../../utils/test-oracle-router'

const contracts = getContracts()

describe('Integration: AmountConverter Denominations', () => {
  let router: OracleRouter
  let factory: AmountConverterFactory
  let snapshot: SnapshotRestorer

  before(async () => {
    snapshot = await takeSnapshot()

    router = await getTestOracleRouter({
      tokens: getAllTestTokens(),
      useRealPrices: true,
    })

    await refreshTestFeedData(getAllTestTokens())

    await router.setTokenEthFeed(contracts.STETH, 86400, 18, true)
    await router.setTokenEthFeed(contracts.LDO, 86400, 18, true)

    const factoryContract = await ethers.getContractFactory('AmountConverterFactory')
    factory = await factoryContract.deploy(await router.getAddress())
    await factory.waitForDeployment()
  })

  after(async () => {
    await snapshot.restore()
    resetTestOracleRouter()
    resetTestFeedRegistryStub()
  })

  describe('ETH-quoted to ETH-quoted with ETH mode', () => {
    let converter: AmountConverter

    beforeEach(async () => {
      const tx = await factory.deployAmountConverter([contracts.STETH], [contracts.LDO], true)
      const receipt = await tx.wait()
      const event = receipt?.logs.find((log: any) => {
        try {
          return factory.interface.parseLog(log)?.name === 'AmountConverterDeployed'
        } catch {
          return false
        }
      })
      const converterAddress = factory.interface.parseLog(event as any)?.args[0]
      converter = await ethers.getContractAt('AmountConverter', converterAddress)
    })

    it('should convert stETH to LDO', async () => {
      const amount = parseEther('10')
      const result = await converter.getExpectedOut(contracts.STETH, contracts.LDO, amount)

      expect(result).to.be.gt(0)

      const prices = await router.getEthPricesAndDecimals(contracts.STETH, contracts.LDO)
      const manualCalc = (amount * prices.baseEthPrice) / prices.quoteEthPrice

      expect(isClose(result, manualCalc, 2n)).to.be.true
    })

    it('should handle small conversions', async () => {
      const amount = parseEther('0.1')
      const result = await converter.getExpectedOut(contracts.STETH, contracts.LDO, amount)

      expect(result).to.be.gt(0)

      // Verify using router directly
      const prices = await router.getEthPricesAndDecimals(contracts.STETH, contracts.LDO)
      const manualCalc = (amount * prices.baseEthPrice) / prices.quoteEthPrice

      expect(isClose(result, manualCalc, 2n)).to.be.true
    })

    it('should produce consistent results for multiple conversions', async () => {
      const amount = parseEther('1')
      const result1 = await converter.getExpectedOut(contracts.STETH, contracts.LDO, amount)
      const result2 = await converter.getExpectedOut(contracts.STETH, contracts.LDO, amount)

      // Same input should always produce same output
      expect(result1).to.equal(result2)
    })
  })

  describe('ETH-quoted to USD-quoted with USD mode', () => {
    let converter: AmountConverter

    beforeEach(async () => {
      // Reconfigure STETH as USD-quoted for mixed denomination tests
      // This uses the ETH/USD bridge internally
      await router.setTokenUsdFeed(contracts.STETH, 86400, 18, true)
      await router.setEthUsdBridge(86400)

      const tx = await factory.deployAmountConverter(
        [contracts.STETH],
        [contracts.DAI, contracts.USDC, contracts.USDT],
        false // USD mode (required for mixed denominations)
      )
      const receipt = await tx.wait()
      const event = receipt?.logs.find((log: any) => {
        try {
          return factory.interface.parseLog(log)?.name === 'AmountConverterDeployed'
        } catch {
          return false
        }
      })
      const converterAddress = factory.interface.parseLog(event as any)?.args[0]
      converter = await ethers.getContractAt('AmountConverter', converterAddress)
    })

    it('should convert stETH → DAI using USD prices', async () => {
      const amount = parseEther('1')
      const result = await converter.getExpectedOut(contracts.STETH, contracts.DAI, amount)

      expect(result).to.be.gt(0)

      // stETH should be worth roughly 2000-4000 DAI
      expect(result).to.be.gte(parseEther('1000'))
      expect(result).to.be.lte(parseEther('10000'))
    })

    it('should convert stETH → USDC (6 decimals) using USD prices', async () => {
      const amount = parseEther('1')
      const result = await converter.getExpectedOut(contracts.STETH, contracts.USDC, amount)

      expect(result).to.be.gt(0)

      // Result should be in 6 decimals
      expect(result).to.be.gte(parseUnits('1000', 6))
      expect(result).to.be.lte(parseUnits('10000', 6))
    })

    it('should convert stETH → USDT (6 decimals) correctly', async () => {
      const amount = parseEther('1')
      const result = await converter.getExpectedOut(contracts.STETH, contracts.USDT, amount)

      expect(result).to.be.gt(0)

      // Result should be in 6 decimals, similar to USDC
      expect(result).to.be.gte(parseUnits('1000', 6))
      expect(result).to.be.lte(parseUnits('10000', 6))
    })

    it('should handle precision differences between stETH (18) and USDC (6)', async () => {
      const amount = parseEther('1.123456789123456789')
      const result = await converter.getExpectedOut(contracts.STETH, contracts.USDC, amount)

      expect(result).to.be.gt(0)
      // Result should be in 6 decimals - verify it's a reasonable value
      expect(result).to.be.gte(parseUnits('1000', 6))
    })
  })
})
