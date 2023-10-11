// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {GPv2Order} from "./lib/GPv2Order.sol";

import {ICoWSwapSettlement} from "./interfaces/ICoWSwapSettlement.sol";
import {ERC1271_MAGIC_VALUE, IERC1271} from "./interfaces/IERC1271.sol";

contract Order is IERC1271 {
    address public immutable owner;

    IERC20 public immutable tokenFrom;
    IERC20 public immutable tokenTo;

    uint32 public immutable validFrom;
    uint32 public immutable validTo;

    bytes32 public orderHash;

    constructor(
        address owner_,
        IERC20 tokenFrom_,
        IERC20 tokenTo_,
        uint32 validFrom_,
        uint32 validTo_,
        bytes32 orderHash_,
        address relayer_
    ) {
        owner = owner_;

        tokenFrom = tokenFrom_;
        tokenTo = tokenTo_;

        validFrom = validFrom_;
        validTo = validTo_;

        orderHash = orderHash_;

        tokenFrom.approve(relayer_, type(uint256).max);
    }

    function isValidSignature(bytes32 hash, bytes calldata) external view returns (bytes4 magicValue) {
        require(hash == orderHash, "invalid order");
        require(validFrom <= block.timestamp && block.timestamp <= validTo, "invalid time");

        return ERC1271_MAGIC_VALUE;
    }
}
