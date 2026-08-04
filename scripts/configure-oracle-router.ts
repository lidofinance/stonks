import { assert } from 'chai'
import { ethers, network } from 'hardhat'

import fmt from '../utils/format'
import { QuoteDenomination } from '../utils/oracle-router'
import { confirmOrAbort } from '../utils/prompt'
import { getDeployer, waitForDeployment } from '../utils/deployment'
import { OracleRouter__factory } from '../typechain-types'

const ORACLE_ROUTER = ''

const ETH_USD_MAX_STALENESS_SECONDS: number = 0

const LDO = '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32'
const STETH = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84'

const LDO_PRIMARY_QUOTE = QuoteDenomination.ETH
const STETH_PRIMARY_QUOTE = QuoteDenomination.ETH

const LDO_MAX_STALENESS_SECONDS: number = 0
const STETH_MAX_STALENESS_SECONDS: number = 0

const LDO_ETH_USD_STALENESS_OVERRIDE_SECONDS: number = 0
const STETH_ETH_USD_STALENESS_OVERRIDE_SECONDS: number = 0

assert(ethers.isAddress(ORACLE_ROUTER), 'ORACLE_ROUTER is not a valid address')
assert(ETH_USD_MAX_STALENESS_SECONDS > 0, 'ETH_USD_MAX_STALENESS_SECONDS must be > 0')

assert(
  LDO_PRIMARY_QUOTE === QuoteDenomination.ETH,
  'LDO_PRIMARY_QUOTE must be QuoteDenomination.USD or QuoteDenomination.ETH'
)
assert(
  STETH_PRIMARY_QUOTE === QuoteDenomination.ETH,
  'STETH_PRIMARY_QUOTE must be QuoteDenomination.USD or QuoteDenomination.ETH'
)

assert(LDO_MAX_STALENESS_SECONDS > 0, 'LDO_MAX_STALENESS_SECONDS must be > 0')
assert(STETH_MAX_STALENESS_SECONDS > 0, 'STETH_MAX_STALENESS_SECONDS must be > 0')

function quoteName(q: number): string {
  return q === QuoteDenomination.USD ? 'USD' : 'ETH'
}

async function main() {
  // prettier-ignore
  console.log(
    `Preparing for ${fmt.name('OracleRouter')} configuration on "${fmt.network(network.name)}" network...\n`
  )

  const signer = await getDeployer()
  const router = OracleRouter__factory.connect(ORACLE_ROUTER, signer)

  console.log(`Configuration parameters:`)
  console.log(`  * Oracle router: ${fmt.address(ORACLE_ROUTER)}`)
  console.log(`  * ETH/USD max staleness (sec): ${fmt.value(ETH_USD_MAX_STALENESS_SECONDS)}`)
  console.log()

  console.log(`  * LDO token: ${fmt.value(LDO)}`)
  console.log(`    - primary quote: ${fmt.value(quoteName(LDO_PRIMARY_QUOTE))}`)
  console.log(`    - max staleness (sec): ${fmt.value(LDO_MAX_STALENESS_SECONDS)}`)
  console.log(
    `    - ETH/USD staleness override (sec): ${fmt.value(LDO_ETH_USD_STALENESS_OVERRIDE_SECONDS)}`
  )
  console.log()

  console.log(`  * stETH token: ${fmt.value(STETH)}`)
  console.log(`    - primary quote: ${fmt.value(quoteName(STETH_PRIMARY_QUOTE))}`)
  console.log(`    - max staleness (sec): ${fmt.value(STETH_MAX_STALENESS_SECONDS)}`)
  console.log(
    `    - ETH/USD staleness override (sec): ${fmt.value(STETH_ETH_USD_STALENESS_OVERRIDE_SECONDS)}`
  )
  console.log()

  await confirmOrAbort('Proceed?')

  const tx1 = await router.setEthUsdBridge(ETH_USD_MAX_STALENESS_SECONDS)
  await waitForDeployment(tx1)

  const tx2 = await router.setTokenFeed(LDO, LDO_PRIMARY_QUOTE, LDO_MAX_STALENESS_SECONDS, true)
  await waitForDeployment(tx2)

  const tx3 = await router.setTokenFeed(
    STETH,
    STETH_PRIMARY_QUOTE,
    STETH_MAX_STALENESS_SECONDS,
    true
  )
  await waitForDeployment(tx3)

  if (LDO_ETH_USD_STALENESS_OVERRIDE_SECONDS > 0) {
    const tx4 = await router.setTokenEthUsdStalenessOverride(
      LDO,
      LDO_ETH_USD_STALENESS_OVERRIDE_SECONDS
    )
    await waitForDeployment(tx4)
  }

  if (STETH_ETH_USD_STALENESS_OVERRIDE_SECONDS > 0) {
    const tx5 = await router.setTokenEthUsdStalenessOverride(
      STETH,
      STETH_ETH_USD_STALENESS_OVERRIDE_SECONDS
    )
    await waitForDeployment(tx5)
  }

  console.log(`${fmt.name('OracleRouter')} configuration finished.\n`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
