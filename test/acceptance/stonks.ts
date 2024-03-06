import { ethers } from 'hardhat'
import { expect } from 'chai'

type StonksParams = {
  address: string
  amountConverter: string
  tokenFrom: string
  tokenTo: string
  orderDurationInSeconds: bigint
  marginInBasisPoints: bigint
  priceToleranceInBasisPoints: bigint
}

const stonksInstances: StonksParams[] = []

describe('Stonks: acceptance', async function () {
  stonksInstances.forEach((params: StonksParams) => {
    it('should have correct params', async function () {
      const stonks = await ethers.getContractAt('Stonks', params.address)

      // https://docs.lido.fi/deployed-contracts/#lido-contributors-group-multisigs
      expect(await stonks.manager()).to.equal("0xa02FC823cCE0D016bD7e17ac684c9abAb2d6D647")
      expect(await stonks.AGENT()).to.equal("0x3e40D73EB977Dc6a537aF587D48316feE66E9C8c")

      expect(await stonks.AMOUNT_CONVERTER()).to.equal(params.amountConverter)
      expect(await stonks.TOKEN_FROM()).to.equal(params.tokenFrom)
      expect(await stonks.TOKEN_TO()).to.equal(params.tokenTo)
      expect(await stonks.ORDER_DURATION_IN_SECONDS()).to.equal(params.orderDurationInSeconds)
      expect(await stonks.MARGIN_IN_BASIS_POINTS()).to.equal(params.marginInBasisPoints)
      expect(await stonks.PRICE_TOLERANCE_IN_BASIS_POINTS()).to.equal(params.priceToleranceInBasisPoints)
    })
  })
})
