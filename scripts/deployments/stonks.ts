import { ethers } from 'hardhat'

import { deployStonksFactory } from './stonks-factory'
import { deployAmountConverterFactory } from './amount-converter-factory'
import { getStonksDeployment, getTokenConverterDeployment } from '../../utils/get-events'
import { AmountConverter, Stonks, OracleRouter, OracleRouter__factory } from '../../typechain-types'
import { getContracts } from '../../utils/contracts'

export type DeployStonksParams = {
  factoryParams: {
    agent: string
    relayer: string
    settlement: string
    priceFeedRegistry: string
  }
  stonksParams: {
    manager: string
    tokenFrom: string
    tokenTo: string
    orderDuration: number
    marginInBps: number
    priceToleranceInBps: number
    amountConverterAddress?: string
    oracleRouterAddress?: string
  }
  amountConverterParams: {
    oracleRouter?: string
    allowedTokensToSell: string[]
    allowedStableTokensToBuy: string[]
  }
}
type ReturnType = {
  stonks: Stonks
  amountConverter: AmountConverter
}

export async function deployStonks({
  factoryParams: { agent, settlement, relayer, priceFeedRegistry },
  stonksParams: {
    manager,
    tokenFrom,
    tokenTo,
    amountConverterAddress,
    oracleRouterAddress,
    orderDuration,
    marginInBps,
    priceToleranceInBps,
  },
  amountConverterParams,
}: DeployStonksParams): Promise<ReturnType> {
  const { stonksFactory } = await deployStonksFactory(agent, settlement, relayer)

  let amountConverter: AmountConverter | undefined
  let oracleRouter: OracleRouter | undefined

  if (amountConverterAddress && oracleRouterAddress) {
    amountConverter = await ethers.getContractAt('AmountConverter', amountConverterAddress)
    oracleRouter = await ethers.getContractAt('OracleRouter', oracleRouterAddress)
  } else if (amountConverterParams) {
    const { amountConverterFactory } = await deployAmountConverterFactory(priceFeedRegistry)

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

      // Configure ETH/USD bridge
      await oracleRouter.setEthUsdBridge(ethers.ZeroAddress, 86_400)

      // Configure tokenFrom and tokenTo feeds as TOKEN/USD
      const tokenInterface = new ethers.Interface(['function decimals() view returns (uint8)'])
      const erc20 = (addr: string) => new ethers.Contract(addr, tokenInterface, deployer)
      const tokenFromDecimals = await erc20(tokenFrom).getFunction('decimals').staticCall()
      const tokenToDecimals = await erc20(tokenTo).getFunction('decimals').staticCall()

      await oracleRouter.setTokenUsdFeed(
        tokenFrom,
        ethers.ZeroAddress,
        86_400,
        tokenFromDecimals,
        true
      )
      await oracleRouter.setTokenUsdFeed(tokenTo, ethers.ZeroAddress, 86_400, tokenToDecimals, true)
    } else {
      oracleRouter = await ethers.getContractAt('OracleRouter', oracleRouterAddressLocal)

      // Ensure the router has both pair feeds configured when reusing an external router
      try {
        const [signer0] = await ethers.getSigners()
        const tokenInterface = new ethers.Interface(['function decimals() view returns (uint8)'])
        const erc20 = (addr: string) => new ethers.Contract(addr, tokenInterface, signer0)
        const tokenFromDecimals = await erc20(tokenFrom).getFunction('decimals').staticCall()
        const tokenToDecimals = await erc20(tokenTo).getFunction('decimals').staticCall()
        await oracleRouter.setEthUsdBridge(ethers.ZeroAddress, 86_400)
        await oracleRouter.setTokenUsdFeed(
          tokenFrom,
          ethers.ZeroAddress,
          86_400,
          tokenFromDecimals,
          true
        )
        await oracleRouter.setTokenUsdFeed(
          tokenTo,
          ethers.ZeroAddress,
          86_400,
          tokenToDecimals,
          true
        )
      } catch (_) {
        // ignore if caller is not authorized or feeds already set
      }
    }

    const deployTokenConverterTX = await amountConverterFactory.deployAmountConverter(
      oracleRouterAddressLocal,
      amountConverterParams.allowedTokensToSell,
      amountConverterParams.allowedStableTokensToBuy
    )
    const receipt = await deployTokenConverterTX.wait()

    if (!receipt) throw new Error('No transaction receipt')

    const { address } = getTokenConverterDeployment(receipt)
    amountConverter = await ethers.getContractAt('AmountConverter', address)
  } else {
    throw new Error()
  }

  const deployStonksTx = await stonksFactory.deployStonks(
    manager,
    tokenFrom,
    tokenTo,
    await amountConverter.getAddress(),
    oracleRouter ? await oracleRouter.getAddress() : oracleRouterAddress!,
    orderDuration,
    marginInBps,
    priceToleranceInBps
  )
  const receipt = await deployStonksTx.wait()

  if (!receipt) throw new Error('No transaction receipt')

  const { address } = getStonksDeployment(receipt)
  const stonks = await ethers.getContractAt('Stonks', address)

  return { stonks, amountConverter }
}
