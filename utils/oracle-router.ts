import { ethers } from 'hardhat'
import { OracleRouter, OracleRouter__factory } from '../typechain-types'

// QuoteDenomination enum values from IOracleRouter.QuoteDenomination
export const QuoteDenomination = {
  USD: 0,
  ETH: 1,
} as const

type DeployOptions = {
  admin?: string
  unitDecimals?: number
  feedRegistry: string
  tokensUsd: string[]
  tokensEth?: string[]
  maxStaleness?: number
}

export async function deployAndConfigureOracleRouter(
  options: DeployOptions
): Promise<OracleRouter> {
  const {
    admin,
    unitDecimals = 18,
    feedRegistry,
    tokensUsd,
    tokensEth = [],
    maxStaleness = 86_400,
  } = options

  const [deployer] = await ethers.getSigners()
  const adminAddress = admin ?? (await deployer.getAddress())

  const router = await new OracleRouter__factory(deployer).deploy(
    adminAddress,
    unitDecimals,
    feedRegistry as any
  )
  await router.waitForDeployment()

  // Bridge ETH/USD (skip silently if registry lacks ETH/USD in stub)
  try {
    await router.setEthUsdBridge(maxStaleness)
  } catch (_) {
    // ignore
  }

  // Configure TOKEN/USD feeds
  for (const token of tokensUsd) {
    await router.setTokenFeed(token, QuoteDenomination.USD, maxStaleness, true)
  }

  // Configure TOKEN/ETH feeds (optional)
  for (const token of tokensEth) {
    await router.setTokenFeed(token, QuoteDenomination.ETH, maxStaleness, true)
  }

  return router
}
