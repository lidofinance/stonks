// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/**
 * @title IRevenueSource
 * @notice Read surface every revenue contributor exposes to the NESTController aggregator.
 *         Concrete sources extend the abstract `RevenueSource`, which implements both methods.
 */
interface IRevenueSource {
    function getRevenue()
        external
        view
        returns (uint256 revenueUSD, uint256 reportTimestamp, bool isStale);

    function paused() external view returns (bool);
}
