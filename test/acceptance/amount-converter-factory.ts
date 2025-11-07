import { ethers } from 'hardhat'
import { expect } from 'chai'
import { getContracts } from '../../utils/contracts'

const AMOUNT_CONVERTER_FACTORY_ADDRESS: string = ''

describe('AmountConverterFactory: acceptance', async function () {
  it('should have correct oracle router', async function () {
    if (AMOUNT_CONVERTER_FACTORY_ADDRESS === '') this.skip()
    const contracts = getContracts()
    const amountConverterFactory = await ethers.getContractAt(
      'AmountConverterFactory',
      AMOUNT_CONVERTER_FACTORY_ADDRESS
    )

    expect(await amountConverterFactory.ORACLE_ROUTER()).to.hexEqual(contracts.ORACLE_ROUTER)
  })
})
