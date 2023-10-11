// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Order} from "./Order.sol";
import {GPv2Order} from "./lib/GPv2Order.sol";

import {ICoWSwapSettlement} from "./interfaces/ICoWSwapSettlement.sol";

contract Stonks {
    using GPv2Order for *;

    address public priceChecker;
    uint16 public immutable maxMargin;

    IERC20 public immutable tokenFrom;
    IERC20 public immutable tokenTo;

    address public constant ARAGON_AGENT = address(0);
    address public constant TREASURY = address(0);
    address public constant TREASURY_MULTISIG = address(0);

    constructor(address tokenFrom_, address tokenTo_, address priceChecker_, uint16 maxMargin_) {
        tokenFrom = IERC20(tokenFrom_);
        tokenTo = IERC20(tokenTo_);
        priceChecker = priceChecker_;
        maxMargin = maxMargin_;
    }

    function createOrder() external {
        uint256 balance = tokenFrom.balanceOf(msg.sender);

        require(balance > 0, "Stonks: no balance"); 

        Order instance = new Order(
            TREASURY_MULTISIG, 
            tokenFrom,
            tokenTo,
            uint32(block.timestamp),
            uint32(block.timestamp + 7 days),
            bytes32(0),
            address(0)
        );

        tokenFrom.transferFrom(msg.sender, address(instance), balance);
    }

    modifier onlyOperator() {
        require(msg.sender == TREASURY_MULTISIG || msg.sender == ARAGON_AGENT, "Stonks: not operator");
        _;
    }
}
