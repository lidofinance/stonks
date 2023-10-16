// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {Order} from "./Order.sol";
import {GPv2Order} from "./lib/GPv2Order.sol";

import {IPriceChecker} from "./interfaces/IPriceChecker.sol";
import {ICoWSwapSettlement} from "./interfaces/ICoWSwapSettlement.sol";

import "hardhat/console.sol";

contract Stonks {
    using GPv2Order for *;

    address public priceChecker;

    address public immutable tokenFrom;
    address public immutable tokenTo;

    address public constant ARAGON_AGENT = address(0);
    address public constant TREASURY = 0x3e40D73EB977Dc6a537aF587D48316feE66E9C8c;
    address public constant TREASURY_MULTISIG = address(0);
    address public constant SETTLEMENT = 0x9008D19f58AAbD9eD0D60971565AA8510560ab41;

    bytes32 public constant APP_DATA = keccak256("Lido does stonks");

    event OrderCreated(address indexed order, GPv2Order.Data orderData);

    constructor(address tokenFrom_, address tokenTo_, address priceChecker_) {
        require(tokenFrom_ != address(0), "Stonks: invalid tokenFrom_ address");
        require(tokenTo_ != address(0), "Stonks: invalid tokenTo_ address");
        require(tokenFrom_ != tokenTo_, "Stonks: tokenFrom_ and tokenTo_ cannot be the same");
        require(priceChecker_ != address(0), "Stonks: invalid price checker address");

        tokenFrom = tokenFrom_;
        tokenTo = tokenTo_;
        priceChecker = priceChecker_;
    }

    function placeOrder() external {
        uint256 balance = IERC20(tokenFrom).balanceOf(address(this));

        require(balance > 0, "Stonks: no balance");

        uint256 buyAmount = IPriceChecker(priceChecker).getExpectedOut(balance, address(tokenFrom), address(tokenTo));

        GPv2Order.Data memory order = GPv2Order.Data({
            sellToken: IERC20Metadata(tokenFrom),
            buyToken: IERC20Metadata(tokenTo),
            receiver: TREASURY,
            sellAmount: balance,
            buyAmount: buyAmount,
            validTo: uint32(block.timestamp + 60 minutes),
            appData: APP_DATA,
            feeAmount: 0,
            kind: GPv2Order.KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: GPv2Order.BALANCE_ERC20,
            buyTokenBalance: GPv2Order.BALANCE_ERC20
        });
        bytes32 orderHash = order.hash(ICoWSwapSettlement(SETTLEMENT).domainSeparator());
        Order instance = new Order(
            TREASURY_MULTISIG,
            priceChecker,
            SETTLEMENT,
            orderHash,
            order
        );

        IERC20(tokenFrom).transfer(address(instance), balance);

        emit OrderCreated(address(instance), order);
    }

    modifier onlyOperator() {
        require(msg.sender == TREASURY_MULTISIG || msg.sender == ARAGON_AGENT, "Stonks: not operator");
        _;
    }
}
