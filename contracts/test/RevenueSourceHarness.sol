// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {RevenueSource} from "../automated-buybacks/revenue/RevenueSource.sol";

/**
 * @title RevenueSourceHarness
 * @notice Test-only concretion of the abstract `RevenueSource`. Exposes `_updateRevenue`
 *         unrestricted so the base-class normalization logic can be exercised directly
 *         without a full subclass (e.g. `StakingRevenueSource`) in scope.
 */
contract RevenueSourceHarness is RevenueSource {
    constructor(
        address admin_,
        uint256 stalenessWindowSeconds_
    ) RevenueSource(admin_, stalenessWindowSeconds_) {}

    function updateRevenue(uint256 revenueUSD_, uint256 reportTimestamp_) external {
        _updateRevenue(revenueUSD_, reportTimestamp_);
    }
}
