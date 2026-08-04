import { ethers } from 'hardhat'
import { expect } from 'chai'
import { getContracts } from '../../utils/contracts'
import { QuoteDenomination } from '../../utils/oracle-router'

const ORACLE_ROUTER_ADDRESS: string = ''

const ETH_USD_MAX_STALENESS_SECONDS: bigint = 0n

const LDO_PRIMARY_QUOTE = QuoteDenomination.ETH
const STETH_PRIMARY_QUOTE = QuoteDenomination.ETH

const LDO_MAX_STALENESS_SECONDS: bigint = 0n
const STETH_MAX_STALENESS_SECONDS: bigint = 0n

describe('OracleRouter: acceptance', async function () {
  it('should have correct params and configured feeds for LDO and stETH', async function () {
    if (ORACLE_ROUTER_ADDRESS === '') this.skip()

    expect(ETH_USD_MAX_STALENESS_SECONDS).to.be.gt(0n)
    expect(LDO_MAX_STALENESS_SECONDS).to.be.gt(0n)
    expect(STETH_MAX_STALENESS_SECONDS).to.be.gt(0n)

    const contracts = getContracts()
    const router = await ethers.getContractAt('OracleRouter', ORACLE_ROUTER_ADDRESS)

    expect(await router.ADMIN()).to.hexEqual(contracts.ADMIN)
    expect(await router.FEED_REGISTRY()).to.hexEqual(contracts.CHAINLINK_PRICE_FEED_REGISTRY)

    const adminSetFilter = router.filters['AdminSet(address)']
    const adminSetEvents = await router.queryFilter(adminSetFilter)
    expect(adminSetEvents.length).to.equal(1)
    expect(adminSetEvents[0].args[0]).to.hexEqual(contracts.ADMIN)

    const bridge = await router.ethUsdBridge()
    expect(bridge.aggregator).to.not.equal(ethers.ZeroAddress)
    expect(bridge.aggregatorDecimals).to.not.equal(0n)
    expect(bridge.maxStalenessSeconds).to.equal(ETH_USD_MAX_STALENESS_SECONDS)
    expect(await router.isBridgeInSync()).to.equal(true)

    const ldo = ethers.getAddress(contracts.LDO)
    const steth = ethers.getAddress(contracts.STETH)

    const ldoConfig = await router.tokenConfig(ldo)
    expect(ldoConfig.isActive).to.equal(true)
    expect(ldoConfig.primaryQuote).to.equal(BigInt(LDO_PRIMARY_QUOTE))
    expect(ldoConfig.primaryFeed.aggregator).to.not.equal(ethers.ZeroAddress)
    expect(ldoConfig.primaryFeed.aggregatorDecimals).to.not.equal(0n)
    expect(ldoConfig.primaryFeed.maxStalenessSeconds).to.equal(LDO_MAX_STALENESS_SECONDS)
    expect(await router.isFeedInSync(ldo)).to.equal(true)

    const stethConfig = await router.tokenConfig(steth)
    expect(stethConfig.isActive).to.equal(true)
    expect(stethConfig.primaryQuote).to.equal(BigInt(STETH_PRIMARY_QUOTE))
    expect(stethConfig.primaryFeed.aggregator).to.not.equal(ethers.ZeroAddress)
    expect(stethConfig.primaryFeed.aggregatorDecimals).to.not.equal(0n)
    expect(stethConfig.primaryFeed.maxStalenessSeconds).to.equal(STETH_MAX_STALENESS_SECONDS)
    expect(await router.isFeedInSync(steth)).to.equal(true)

    const tokenConfiguredFilter =
      router.filters[
        'TokenConfigured(address,uint8,address,uint8,uint32,uint8,uint128,uint128,bool)'
      ]
    const tokenConfiguredEvents = await router.queryFilter(tokenConfiguredFilter)
    expect(tokenConfiguredEvents.some((e) => e.args[0] === ldo)).to.equal(true)
    expect(tokenConfiguredEvents.some((e) => e.args[0] === steth)).to.equal(true)

    const [basePrice, quotePrice, baseDecimals, quoteDecimals] = await router.getPricesAndDecimals(
      ldo,
      steth,
      QuoteDenomination.ETH
    )
    expect(basePrice).to.not.equal(0n)
    expect(quotePrice).to.not.equal(0n)
    expect(baseDecimals).to.not.equal(0n)
    expect(quoteDecimals).to.not.equal(0n)
  })
})
