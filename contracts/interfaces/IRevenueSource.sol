// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

interface IRevenueSource {
    function getRevenue()
        external
        view
        returns (uint256 revenueUSD, uint256 reportTimestamp, bool isStale);

    function paused() external view returns (bool);
}
