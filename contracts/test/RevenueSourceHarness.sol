// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {RevenueSource} from "../automated-buybacks/revenue/RevenueSource.sol";

/**
 * @title RevenueSourceHarness
 * @notice Test-only concretion of the abstract `RevenueSource`. Exposes `_addRevenueUSD`
 *         unrestricted so the base-class accumulator can be exercised directly without a
 *         full subclass (e.g. `StakingRevenueSource`) in scope.
 */
contract RevenueSourceHarness is RevenueSource {
    constructor(address admin_) RevenueSource(admin_) {}

    function addRevenueUSD(uint256 amountUSD_) external {
        _addRevenueUSD(amountUSD_);
    }
}
