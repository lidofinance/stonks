import { ethers } from 'hardhat'
import { OracleRouter, OracleRouter__factory } from '../typechain-types'

type DeployOptions = {
  agent?: string
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
    agent,
    unitDecimals = 18,
    feedRegistry,
    tokensUsd,
    tokensEth = [],
    maxStaleness = 86_400,
  } = options

  const [deployer] = await ethers.getSigners()
  const agentAddress = agent ?? (await deployer.getAddress())

  const router = await new OracleRouter__factory(deployer).deploy(
    agentAddress,
    unitDecimals,
    feedRegistry as any
  )
  await router.waitForDeployment()

  const erc20Interface = new ethers.Interface(['function decimals() view returns (uint8)'])
  const readDecimals = async (token: string) => {
    const c = new ethers.Contract(token, erc20Interface, deployer)
    return c.getFunction('decimals').staticCall()
  }
  // Bridge ETH/USD (skip silently if registry lacks ETH/USD in stub)
  try {
    await router.setEthUsdBridge(maxStaleness)
  } catch (_) {
    // ignore
  }

  // Configure TOKEN/USD feeds
  for (const token of tokensUsd) {
    await router.setTokenUsdFeed(token, maxStaleness, await readDecimals(token), true)
  }

  // Configure TOKEN/ETH feeds (optional)
  for (const token of tokensEth) {
    await router.setTokenEthFeed(token, maxStaleness, await readDecimals(token), true)
  }

  return router
}
