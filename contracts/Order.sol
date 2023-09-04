// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Order {
    address internal immutable ROOT;
    bytes32 public orderHash;

    constructor() {
        ROOT = address(this);
    }

    function initialize(address sellToken_, bytes32 orderHash_) external {
        require(orderHash == bytes32(0), "Order: already initialized");

        orderHash = orderHash_;
    }

    function requestSwap() external {}
}
