// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {GPv2Order} from "./lib/GPv2Order.sol";
import {IPriceChecker} from "./interfaces/IPriceChecker.sol";

import {ICoWSwapSettlement} from "./interfaces/ICoWSwapSettlement.sol";
import {ERC1271_MAGIC_VALUE, IERC1271} from "./interfaces/IERC1271.sol";

contract Order is IERC1271 {
    address public immutable operator;
    address public immutable stonks;
    address public immutable priceChecker;

    IERC20 public immutable tokenFrom;
    IERC20 public immutable tokenTo;

    uint32 public immutable validTo;

    bytes32 public orderHash;

    constructor(
        address operator_,
        address priceChecker_,
        address settlement_,
        bytes32 orderHash_,
        address tokenFrom_,
        address tokenTo_,
        uint32 validTo_
    ) {
        operator = operator_;
        priceChecker = priceChecker_;
        stonks = msg.sender;

        tokenFrom = IERC20(tokenFrom_);
        tokenTo = IERC20(tokenTo_);
        validTo = validTo_;
        orderHash = orderHash_;

        tokenFrom.approve(settlement_, type(uint256).max);
    }

    function isValidSignature(bytes32 hash, bytes calldata) external view returns (bytes4 magicValue) {
        require(hash == orderHash, "Order: invalid order");
        require(block.timestamp <= validTo, "invalid time");

        // uint256 expectedOut = IPriceChecker(priceChecker).getExpectedOut(
        //     IERC20(tokenFrom).balanceOf(address(this)),
        //     address(tokenFrom),
        //     address(tokenTo),
        //     new bytes(0)
        // );

        // TODO: check if price is much higher than suggested

        return ERC1271_MAGIC_VALUE;
    }

    function cancel() external {
        require(msg.sender == operator, "Order: not operator");
        require(validTo < block.timestamp, "Order: not expired");

        tokenFrom.transfer(stonks, tokenFrom.balanceOf(address(this)));
    }
}
