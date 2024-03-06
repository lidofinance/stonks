import { ethers } from 'hardhat'
import { expect } from 'chai'
import { getContracts } from '../../utils/contracts'

type StonksParams = {
  address: string
  orderSample: string
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
      const contracts = await getContracts()
      const stonks = await ethers.getContractAt('Stonks', params.address)

      expect(await stonks.manager()).to.equal(contracts.MANAGER)
      expect(await stonks.AGENT()).to.equal(contracts.AGENT)

      expect(await stonks.ORDER_SAMPLE()).to.equal(params.orderSample)
      expect(await stonks.AMOUNT_CONVERTER()).to.equal(params.amountConverter)
      expect(await stonks.TOKEN_FROM()).to.equal(params.tokenFrom)
      expect(await stonks.TOKEN_TO()).to.equal(params.tokenTo)
      expect(await stonks.ORDER_DURATION_IN_SECONDS()).to.equal(params.orderDurationInSeconds)
      expect(await stonks.MARGIN_IN_BASIS_POINTS()).to.equal(params.marginInBasisPoints)
      expect(await stonks.PRICE_TOLERANCE_IN_BASIS_POINTS()).to.equal(
        params.priceToleranceInBasisPoints
      )

      expect(await stonks.getPriceTolerance()).to.equal(params.priceToleranceInBasisPoints)
      expect(await stonks.getOrderParameters()).to.equal([
        params.tokenFrom,
        params.tokenTo,
        params.orderDurationInSeconds,
      ])

      const managerSetFilter = stonks.filters['ManagerSet(address)']
      const agentSetFilter = stonks.filters['AgentSet(address)']
      const orderSampleSetFilter = stonks.filters['OrderSampleSet(address)']
      const amountConverterSetFilter = stonks.filters['AmountConverterSet(address)']
      const tokenFromSetFilter = stonks.filters['TokenFromSet(address)']
      const tokenToSetFilter = stonks.filters['TokenToSet(address)']
      const orderDurationInSecondsSetFilter = stonks.filters['OrderDurationInSecondsSet(uint256)']
      const marginInBasisPointsSetFilter = stonks.filters['MarginInBasisPointsSet(uint256)']
      const priceToleranceInBasisPointsSetFilter = stonks.filters['PriceToleranceInBasisPointsSet(uint256)']

      const managerSetEvents = await stonks.queryFilter(managerSetFilter)
      const agentSetEvents = await stonks.queryFilter(agentSetFilter)
      const orderSampleSetEvents = await stonks.queryFilter(orderSampleSetFilter)
      const amountConverterSetEvents = await stonks.queryFilter(amountConverterSetFilter)
      const tokenFromSetEvents = await stonks.queryFilter(tokenFromSetFilter)
      const tokenToSetEvents = await stonks.queryFilter(tokenToSetFilter)
      const orderDurationInSecondsSetEvents = await stonks.queryFilter(orderDurationInSecondsSetFilter)
      const marginInBasisPointsSetEvents = await stonks.queryFilter(marginInBasisPointsSetFilter)
      const priceToleranceInBasisPointsSetEvents = await stonks.queryFilter(priceToleranceInBasisPointsSetFilter)

      expect(managerSetEvents.length).to.equal(1)
      expect(agentSetEvents.length).to.equal(1)
      expect(orderSampleSetEvents.length).to.equal(1)
      expect(amountConverterSetEvents.length).to.equal(1)
      expect(tokenFromSetEvents.length).to.equal(1)
      expect(tokenToSetEvents.length).to.equal(1)
      expect(orderDurationInSecondsSetEvents.length).to.equal(1)
      expect(marginInBasisPointsSetEvents.length).to.equal(1)
      expect(priceToleranceInBasisPointsSetEvents.length).to.equal(1)
        
      expect(managerSetEvents[0].args[0]).to.equal(contracts.MANAGER)
      expect(agentSetEvents[0].args[0]).to.equal(contracts.AGENT)
      expect(orderSampleSetEvents[0].args[0]).to.equal(params.orderSample)
      expect(amountConverterSetEvents[0].args[0]).to.equal(params.amountConverter)
      expect(tokenFromSetEvents[0].args[0]).to.equal(params.tokenFrom)
      expect(tokenToSetEvents[0].args[0]).to.equal(params.tokenTo)
      expect(orderDurationInSecondsSetEvents[0].args[0]).to.equal(params.orderDurationInSeconds)
      expect(marginInBasisPointsSetEvents[0].args[0]).to.equal(params.marginInBasisPoints)
      expect(priceToleranceInBasisPointsSetEvents[0].args[0]).to.equal(params.priceToleranceInBasisPoints)

      const order = await ethers.getContractAt('Order', await stonks.ORDER_SAMPLE())

      expect(await order.AGENT()).to.equal(contracts.AGENT)
      expect(await order.manager()).to.equal(contracts.MANAGER)
      expect(await order.RELAYER()).to.equal(contracts.VAULT_RELAYER)
      expect(await order.DOMAIN_SEPARATOR()).to.equal(contracts.DOMAIN_SEPARATOR)

      const agentSetFilterOrder = order.filters['AgentSet(address)']
      const managerSetFilterOrder = order.filters['ManagerSet(address)']
      const relayerSetFilterOrder = order.filters['RelayerSet(address)']
      const domainSeparatorSetFilterOrder = order.filters['DomainSeparatorSet(bytes32)']

      const agentSetEventsOrder = await order.queryFilter(agentSetFilterOrder)
      const managerSetEventsOrder = await order.queryFilter(managerSetFilterOrder)
      const relayerSetEventsOrder = await order.queryFilter(relayerSetFilterOrder)
      const domainSeparatorSetEventsOrder = await order.queryFilter(domainSeparatorSetFilterOrder)

      expect(agentSetEventsOrder.length).to.equal(1)
      expect(managerSetEventsOrder.length).to.equal(1)
      expect(relayerSetEventsOrder.length).to.equal(1)
      expect(domainSeparatorSetEventsOrder.length).to.equal(1)

      expect(agentSetEventsOrder[0].args[0]).to.equal(contracts.AGENT)
      expect(managerSetEventsOrder[0].args[0]).to.equal(contracts.MANAGER)
      expect(relayerSetEventsOrder[0].args[0]).to.equal(contracts.VAULT_RELAYER)
      expect(domainSeparatorSetEventsOrder[0].args[0]).to.equal(contracts.DOMAIN_SEPARATOR)
    })
  })
})
