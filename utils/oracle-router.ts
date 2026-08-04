import { ethers } from 'hardhat'
import { OracleRouter, OracleRouter__factory } from '../typechain-types'

// QuoteDenomination enum values from IOracleRouter.QuoteDenomination
export const QuoteDenomination = {
  USD: 0,
  ETH: 1,
} as const

type DeployOptions = {
  admin?: string
  feedRegistry: string
  tokensUsd: string[]
  tokensEth?: string[]
  maxStaleness?: number
  skipEthUsdBridge?: boolean
}

export async function deployAndConfigureOracleRouter(
  options: DeployOptions
): Promise<OracleRouter> {
  const {
    admin,
    feedRegistry,
    tokensUsd,
    tokensEth = [],
    maxStaleness = 86_400,
    skipEthUsdBridge = false,
  } = options

  const [deployer] = await ethers.getSigners()
  const adminAddress = admin ?? (await deployer.getAddress())

  const router = await new OracleRouter__factory(deployer).deploy(adminAddress, feedRegistry)
  await router.waitForDeployment()

  if (!skipEthUsdBridge) {
    await router.setEthUsdBridge(maxStaleness)
  }

  for (const token of tokensUsd) {
    await router.setTokenFeed(token, QuoteDenomination.USD, maxStaleness, true)
  }

  for (const token of tokensEth) {
    await router.setTokenFeed(token, QuoteDenomination.ETH, maxStaleness, true)
  }

  return router
}
