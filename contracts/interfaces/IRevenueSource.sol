// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/**
 * @title IRevenueSource
 * @notice Read surface every revenue contributor exposes to the buyback revenue aggregator.
 *         Returns the source's monotonic cumulative revenue in USD; consumers diff successive
 *         reads to derive accrued revenue. Concrete sources extend the abstract `RevenueSource`,
 *         which implements this method.
 * @dev    Extends `IERC165` so the base `RevenueSource` carries the `supportsInterface`
 *         advertisement for `IRevenueSource`, and every concrete source inherits it. Consumers
 *         like `BuybackAllocator` gate registration on `supportsInterface(type(IRevenueSource))`.
 * @dev    Implementations must stay monotonic, always-live, and fully settled: the cumulative
 *         only grows, the read never reverts, and it reflects all revenue earned up to the read.
 */
interface IRevenueSource is IERC165 {
    function getCumulativeRevenueUSD() external view returns (uint256);
}
