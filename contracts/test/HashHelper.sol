// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {GPv2Order} from "../lib/GPv2Order.sol";

contract HashHelper {
    using GPv2Order for GPv2Order.Data;
    using GPv2Order for bytes;

    function hash(GPv2Order.Data memory order, bytes32 domainSeparator) external pure returns (bytes32 orderDigest) {
        return order.hash(domainSeparator);
    }
}
