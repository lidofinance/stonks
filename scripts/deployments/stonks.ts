import { ethers } from 'hardhat'

import { deployStonksFactory } from './stonks-factory'
import { deployAmountConverterFactory } from './amount-converter-factory'
import { getStonksDeployment, getTokenConverterDeployment } from '../../utils/get-events'
import { AmountConverter, Stonks, OracleRouter, OracleRouter__factory } from '../../typechain-types'

export type DeployStonksParams = {
  factoryParams: {
    agent: string
    relayer: string
    settlement: string
    priceFeedRegistry: string
    oracleRouterAddress: string
  }
  stonksParams: {
    manager: string
    tokenFrom: string
    tokenTo: string
    orderDuration: number
    marginInBps: number
    priceToleranceInBps: number
    maxImprovementInBps?: number
    minFillBps?: number
    allowPartialFill?: boolean
    amountConverterAddress?: string
  }
  amountConverterParams: {
    oracleRouter?: string
    allowedTokensToSell: string[]
    allowedStableTokensToBuy: string[]
    useEthAnchor?: boolean
  }
  skipRouterConfiguration?: boolean
}
type ReturnType = {
  stonks: Stonks
  amountConverter: AmountConverter
}

export async function deployStonks({
  factoryParams: { agent, settlement, relayer, priceFeedRegistry, oracleRouterAddress },
  stonksParams: {
    manager,
    tokenFrom,
    tokenTo,
    amountConverterAddress,
    orderDuration,
    marginInBps,
    priceToleranceInBps,
    maxImprovementInBps = 0,
    minFillBps = 0,
    allowPartialFill = false,
  },
  amountConverterParams,
  skipRouterConfiguration = false,
}: DeployStonksParams): Promise<ReturnType> {
  const { stonksFactory } = await deployStonksFactory(
    agent,
    settlement,
    relayer,
    oracleRouterAddress
  )

  let amountConverter: AmountConverter | undefined
  let oracleRouter: OracleRouter | undefined

  if (amountConverterAddress && oracleRouterAddress) {
    amountConverter = await ethers.getContractAt('AmountConverter', amountConverterAddress)
    oracleRouter = await ethers.getContractAt('OracleRouter', oracleRouterAddress)
  } else if (amountConverterParams) {
    // Ensure OracleRouter exists; deploy and configure if not provided
    let oracleRouterAddressLocal = amountConverterParams.oracleRouter
    if (!oracleRouterAddressLocal) {
      const [deployer] = await ethers.getSigners()
      oracleRouter = await new OracleRouter__factory(deployer).deploy(
        deployer.address,
        18,
        priceFeedRegistry as any
      )
      await oracleRouter.waitForDeployment()
      oracleRouterAddressLocal = await oracleRouter.getAddress()

      // Configure ETH/USD bridge (ignore if already set)
      try {
        await oracleRouter!.setEthUsdBridge(86_400)
      } catch (_) {}

      const tokenInterface = new ethers.Interface(['function decimals() view returns (uint8)'])
      const erc20 = (addr: string) => new ethers.Contract(addr, tokenInterface, deployer)
      const configureToken = async (tokenAddr: string) => {
        const dec = await erc20(tokenAddr).getFunction('decimals').staticCall()
        // Try USD first, fallback to ETH if it reverts for any reason
        try {
          await oracleRouter!.setTokenFeed(tokenAddr, 0, 86_400, dec, true)
          return
        } catch (_) {}
        try {
          await oracleRouter!.setTokenFeed(tokenAddr, 1, 86_400, dec, true)
          return
        } catch (e) {
          // final attempt: USD again to surface error details
          await oracleRouter!.setTokenFeed(tokenAddr, 0, 86_400, dec, true)
        }
      }
      await configureToken(tokenFrom)
      await configureToken(tokenTo)
    } else {
      oracleRouter = await ethers.getContractAt('OracleRouter', oracleRouterAddressLocal)

      // Ensure the router has both pair feeds configured when reusing an external router
      if (!skipRouterConfiguration) {
        try {
          const [signer0] = await ethers.getSigners()
          const tokenInterface = new ethers.Interface(['function decimals() view returns (uint8)'])
          const erc20 = (addr: string) => new ethers.Contract(addr, tokenInterface, signer0)
          const tokenFromDecimals = await erc20(tokenFrom).getFunction('decimals').staticCall()
          const tokenToDecimals = await erc20(tokenTo).getFunction('decimals').staticCall()
          try {
            await oracleRouter!.setEthUsdBridge(86_400)
          } catch (_) {}

          await oracleRouter!.setTokenFeed(tokenFrom, 0, 86_400, tokenFromDecimals, true)
          await oracleRouter!.setTokenFeed(tokenTo, 0, 86_400, tokenToDecimals, true)
        } catch (_) {
          // ignore if caller is not authorized or feeds already set
        }
      }
    }

    // Deploy AmountConverterFactory with the oracle router
    const { amountConverterFactory } = await deployAmountConverterFactory(oracleRouterAddressLocal)

    const deployTokenConverterTX = await amountConverterFactory.deployAmountConverter(
      amountConverterParams.allowedTokensToSell,
      amountConverterParams.allowedStableTokensToBuy,
      amountConverterParams.useEthAnchor ?? false
    )
    const receipt = await deployTokenConverterTX.wait()

    if (!receipt) throw new Error('No transaction receipt')

    const { address } = getTokenConverterDeployment(receipt)
    amountConverter = await ethers.getContractAt('AmountConverter', address)
  } else {
    throw new Error(
      'Invalid params: provide either both amountConverterAddress and oracleRouterAddress, or amountConverterParams'
    )
  }

  const deployStonksTx = await stonksFactory.deployStonks(
    manager,
    tokenFrom,
    tokenTo,
    await amountConverter.getAddress(),
    orderDuration,
    marginInBps,
    priceToleranceInBps,
    maxImprovementInBps,
    minFillBps,
    allowPartialFill
  )
  const receipt = await deployStonksTx.wait()

  if (!receipt) throw new Error('No transaction receipt')

  const { address } = getStonksDeployment(receipt)
  const stonks = await ethers.getContractAt('Stonks', address)

  return { stonks, amountConverter }
}
