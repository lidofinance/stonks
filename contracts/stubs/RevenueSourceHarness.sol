// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {RevenueSource} from "../revenue/RevenueSource.sol";

/**
 * @title RevenueSourceHarness
 * @dev Minimal test harness that makes the abstract RevenueSource concrete and
 *      exposes the internal _updateRevenue for unit testing.
 *      pause() and unpause() are inherited directly from RevenueSource.
 */
contract RevenueSourceHarness is RevenueSource {
    function updateRevenue(uint256 revenueUsd_, uint256 reportTimestamp_) external {
        _updateRevenue(revenueUsd_, reportTimestamp_);
    }
}
