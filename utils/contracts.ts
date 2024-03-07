import { network, ethers } from 'hardhat'

export const mainnet = {
  CHAINLINK_PRICE_FEED_REGISTRY: '0x47Fb2585D2C56Fe188D0E6ec628a38b74fCeeeDf',
  // Conversion targets: https://github.com/smartcontractkit/chainlink/blob/develop/contracts/src/v0.8/Denominations.sol
  CHAINLINK_USD_QUOTE: '0x0000000000000000000000000000000000000348',
  STETH: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84',
  DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  LDO: '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32',
  AGENT: '0x3e40D73EB977Dc6a537aF587D48316feE66E9C8c',
  SETTLEMENT: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
  VAULT_RELAYER: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110',
  DOMAIN_SEPARATOR: '0xc078f884a2676e1345748b1feace7b0abee5d00ecadb6e574dcdd109a63e8943',
  MANAGER: '0xa02FC823cCE0D016bD7e17ac684c9abAb2d6D647'
}

export const holesky = {
  AGENT: '0xE92329EC7ddB11D25e25b3c21eeBf11f15eB325d',
  CHAINLINK_USD_QUOTE: '0x0000000000000000000000000000000000000348',
  LDO: '0x14ae7daeecdf57034f3E9db8564e46Dba8D97344',
  STETH: '0x3F1c547b21f65e10480dE3ad8E19fAAC46C95034',
  DAI: '0x2eb8e9198e647f80ccf62a5e291bcd4a5a3ca68c',
  USDT: '0x86f6c353a0965eb069cd7f4f91c1afef8c725551',
  USDC: '0x9715b2786f1053294fc8952df923b95cab9aac42',
  CHAINLINK_PRICE_FEED_REGISTRY: '0x9dD5144FFB63a423a18f00a6F6fE53d38058DbFe', // Stub
  SETTLEMENT: '0xcEE18ed7d5561dC32b8dA5724ffA4d565d2f53ea', // Stub
  VAULT_RELAYER: '0x36b43D95A6f3C9b6708b57DD5e7C556Dad3C43A0', // Stub
  DOMAIN_SEPARATOR: '0x4af1838ae36255343d7b8dc9f8c01ea03a9366a4cc9713a0e308554891f1b441',
  MANAGER: '0x4BfD997CD068E95577A2917CBCEDD0E99f60f271'
}

export const getContracts = async () => {
  if (network.name === 'holesky') return holesky
  else if (['hardhat', 'mainnet', 'localhost'].includes(network.name)) return mainnet

  throw new Error('Unknown Network')
}
