# Lido Stonks

## What is a Stonks?

Stonks is a sophisticated solution designed for token exchanges, leveraging the offchain CoWSwap platform. This system enables a specialized Token Management Committee within the DAO framework to safely conduct token swaps without ever taking custody of the tokens on their balance.

## How does it work?

Stonks leverages a combination of advanced blockchain protocols and smart contract mechanisms to facilitate secure and efficient token swaps:

#### Utilizing CoWSwap's Offchain Orderbook
- Front-Running Mitigation: CoWSwap's offchain orderbook prevents front-running, a common issue in on-chain environments, by hiding order details until execution.
- Efficient Price Discovery: Batch auctions in CoWSwap match overlapping orders, ensuring fair pricing.
#### Chainlink for Accurate Pricing
- Real-Time Market Prices: Stonks uses Chainlink to obtain real-time, reliable market prices, ensuring swaps are executed at rates reflecting current market conditions.
#### Onchain Order Creation
- EIP-712 and EIP-1271 Standards: Orders are created onchain using EIP-712 for clear, secure data signing and EIP-1271 for smart contract verification, enhancing security and trust.
#### Price Verification at Execution
- Mitigating Price Volatility: Stonks checks prices at execution time to mitigate risks from sudden market movements, ensuring swaps occur under favorable conditions.
#### Fixed Swap Parameters
- Hard-Coded in Smart Contracts: Exchange parameters are embedded in the smart contracts, eliminating the need for manual configuration and ensuring consistent, automated swap operations.


## Contributing

Before starting, ensure you have installed:

- node.js 16>
- npm (Node Package Manager)

### Installation

```sh
git clone git@github.com:lidofinance/stonks.git
cd stonks
npm install
```

### Configuration
Create a `.env` file in the root directory of your project and add the following environment variables:

```sh
RPC_URL="your_rpc_link"
WALLET_PRIVATE_KEY="your_private_key"
ETHERSCAN_API_KEY="your_etherscan_api_key"
```

### Usage
You can run a local Ethereum node for development and testing purposes using the command:
```sh
npm run node
```
> Note: this command should be run in a separate terminal tab and kept active during development.

To run the tests, open a new terminal tab and execute the following command:

```sh
npm run test
```