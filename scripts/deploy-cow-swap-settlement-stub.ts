import { network } from 'hardhat'

import fmt from '../utils/format'
import { confirmOrAbort } from '../utils/prompt'
import { getDeployer, verify } from '../utils/deployment'
import { CoWSwapSettlementStub__factory } from '../typechain-types/factories/contracts/stubs'

async function main() {
  // prettier-ignore
  console.log(
    `Preparing for ${fmt.name('CoWSwapSettlementStub')} deployment on "${fmt.network(network.name)}" network...\n`
  )

  const deployer = await getDeployer()

  await confirmOrAbort()

  const settlement = await new CoWSwapSettlementStub__factory(deployer).deploy()
  await settlement.waitForDeployment()

  const settlementAddress = await settlement.getAddress()

  console.log(`${fmt.name('CoWSwapSettlementStub')} deployed at ${fmt.address(settlementAddress)}`)

  if (network.name !== 'hardhat') {
    await verify(settlementAddress, [])
  } else {
    console.log(`Run on developer network, verification is skipped`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
