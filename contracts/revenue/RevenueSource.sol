// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";

/**
 * @title RevenueSource
 * @author swissarmytowel
 * @notice Abstract contract that defines the interface for contracts that can receive revenue and report it to the NESTController.
 * @dev This contract is intended to be inherited by any contract that needs to report revenue to the NESTController.
 */
abstract contract RevenueSource is Pausable {
    // ==================== Storage Variables ====================

    /// @notice The last reported revenue in USD
    uint256 internal _lastRevenueUsd;
    /// @notice The timestamp of the last report
    uint256 internal _lastReportTimestamp;

    // ==================== Events ====================

    event RevenueUpdated(uint256 revenueUsd, uint256 reportTimestamp);

    // ==================== External Functions ====================

    /**
     * @notice Returns the amount of revenue that the contract has generated and is ready to be reported to the NESTController.
     * @return The amount of revenue in USD and the timestamp of the last report.
     */
    function getRevenue() external view whenNotPaused returns (uint256, uint256) {
        return (_lastRevenueUsd, _lastReportTimestamp);
    }

    // ==================== Internal Functions ====================

    function _updateRevenue(uint256 revenueUsd_, uint256 reportTimestamp_) internal {
        _lastRevenueUsd = revenueUsd_;
        _lastReportTimestamp = reportTimestamp_;

        emit RevenueUpdated(revenueUsd_, reportTimestamp_);
    }
}
