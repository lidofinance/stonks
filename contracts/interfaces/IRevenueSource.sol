// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

/**
 * @title IRevenueSource
 * @notice Read surface every revenue contributor exposes to the NESTController aggregator.
 *         Concrete sources extend the abstract `RevenueSource`, which implements this method.
 */
interface IRevenueSource {
    function getCumulativeRevenueUSD() external view returns (uint256);
}
