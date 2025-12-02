import { ethers } from 'hardhat'
import { OracleRouter, ChainlinkFeedRegistryStub } from '../typechain-types'
import { getContracts } from './contracts'
import { deployStonks } from '../scripts/deployments/stonks'
import {
  getTestFeedRegistryStub as getSharedFeedRegistryStub,
  resetTestFeedRegistryStub,
} from './test-feed-registry'

const contracts = getContracts()

let globalOracleRouter: OracleRouter | null = null
let globalFeedRegistryStub: ChainlinkFeedRegistryStub | null = null

export type TestOracleRouterConfig = {
  tokens: string[]
  admin?: string
  unitDecimals?: number
  useRealPrices?: boolean
}

async function initializeGlobalOracleRouter(config: TestOracleRouterConfig): Promise<void> {
  if (globalOracleRouter && globalFeedRegistryStub) {
    return
  }

  const { tokens, admin, unitDecimals = 18, useRealPrices = true } = config
  const [deployer] = await ethers.getSigners()
  const adminAddress = admin || (await deployer.getAddress())

  const stub = await getSharedFeedRegistryStub({ tokens, useRealPrices })
  globalFeedRegistryStub = stub

  const oracleRouterFactory = await ethers.getContractFactory('OracleRouter')
  const oracleRouter = await oracleRouterFactory.deploy(
    adminAddress,
    unitDecimals,
    await stub.getAddress()
  )
  await oracleRouter.waitForDeployment()
  globalOracleRouter = oracleRouter

  const adminSigner = await ethers.getImpersonatedSigner(adminAddress)
  await ethers.provider.send('hardhat_setBalance', [adminAddress, '0x1000000000000000000'])

  try {
    await oracleRouter.connect(adminSigner).setEthUsdBridge(86_400)
  } catch {
    // Ignore if already configured
  }

  for (const token of tokens) {
    try {
      const usdFeed = await stub.getFeed(token, contracts.CHAINLINK_USD_QUOTE)

      if (usdFeed !== ethers.ZeroAddress) {
        await oracleRouter.connect(adminSigner).setTokenFeed(token, 0, 86_400, true)
      } else {
        const ethFeed = await stub.getFeed(token, contracts.CHAINLINK_ETH_QUOTE)
        if (ethFeed !== ethers.ZeroAddress) {
          await oracleRouter.connect(adminSigner).setTokenFeed(token, 1, 86_400, true)
        } else {
          console.warn(`No feeds available for token ${token}, skipping configuration`)
        }
      }
    } catch (e) {
      console.warn(`Failed to configure token ${token}:`, e)
    }
  }
}

export async function getTestOracleRouter(config: TestOracleRouterConfig): Promise<OracleRouter> {
  await initializeGlobalOracleRouter(config)
  if (!globalOracleRouter) {
    throw new Error('Failed to initialize OracleRouter')
  }
  return globalOracleRouter
}

export function resetTestOracleRouter(): void {
  globalOracleRouter = null
  globalFeedRegistryStub = null
  resetTestFeedRegistryStub()
}

export async function deployTestOracleRouter(
  config: TestOracleRouterConfig
): Promise<OracleRouter> {
  return getTestOracleRouter(config)
}

export async function deployStonksWithTestOracle(params: any) {
  const tokens = [params.stonksParams.tokenFrom, params.stonksParams.tokenTo]
  const oracleRouter = await getTestOracleRouter({
    tokens: tokens,
    admin: params.factoryParams.admin ?? params.factoryParams.agent,
  })
  const updatedParams = {
    ...params,
    factoryParams: {
      ...params.factoryParams,
      oracleRouterAddress: await oracleRouter.getAddress(),
    },
    amountConverterParams: {
      ...params.amountConverterParams,
      oracleRouter: await oracleRouter.getAddress(),
    },
  }
  return deployStonks(updatedParams)
}

/**
 * Helper to simulate negative rebase by transferring tokens out of the order contract
 * stETH uses a shares-based system, so we transfer tokens instead of manipulating storage
 * @param tokenAddress The address of the token contract (e.g., stETH)
 * @param orderAddress The address of the order contract whose balance should decrease
 * @param rebaseAmount The amount to simulate being rebased away (will transfer min(rebaseAmount, currentBalance))
 */
export async function simulateNegativeRebase(
  tokenAddress: string,
  orderAddress: string,
  rebaseAmount: bigint
): Promise<void> {
  // Get the token contract
  const token = await ethers.getContractAt('IERC20', tokenAddress)
  const currentBalance = await token.balanceOf(orderAddress)

  // Calculate amount to transfer
  const amountToTransfer = currentBalance > rebaseAmount ? rebaseAmount : currentBalance

  // Impersonate the order contract to transfer tokens out
  await ethers.provider.send('hardhat_impersonateAccount', [orderAddress])
  await ethers.provider.send('hardhat_setBalance', [orderAddress, '0x1000000000000000000'])
  const orderSigner = await ethers.getSigner(orderAddress)

  // Transfer tokens to a recipient (simulate rebase loss)
  const [, recipient] = await ethers.getSigners()
  await token.connect(orderSigner).transfer(await recipient.getAddress(), amountToTransfer)

  // Verify the balance decreased
  const newBalance = await token.balanceOf(orderAddress)
  const expectedBalance = currentBalance - amountToTransfer

  // Allow for small rounding differences (1-2 wei) due to stETH shares
  if (newBalance > expectedBalance + 2n || newBalance < expectedBalance - 2n) {
    throw new Error(`Balance transfer failed: expected ~${expectedBalance}, got ${newBalance}`)
  }
}
