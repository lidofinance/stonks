// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {AccessControlEnumerable} from "@openzeppelin/contracts/access/AccessControlEnumerable.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";

/**
 * @title RevenueSource
 * @notice Base contract for revenue data providers consumed by `NESTController`. Owns the shared
 *         `_lastRevenueUSD` / `_lastReportTimestamp` storage, the daily-rate normalization in
 *         `_updateRevenue`, and the staleness check exposed via `getRevenue`. Concrete sources
 *         only supply the revenue computation and call `_updateRevenue` with the raw figure.
 * @dev    Does not inherit `AssetRecovererACL` because revenue sources hold no recoverable
 *         assets. `EMERGENCY_ROLE` is defined locally and shares the `keccak256("EMERGENCY_ROLE")`
 *         hash with the ACL variant, so the same operators can pause every NEST component.
 */
abstract contract RevenueSource is AccessControlEnumerable, Pausable {
    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Role gating `pause` / `unpause`. Not granted at construction — the admin assigns it
    ///         post-deployment to the Emergency Committee via `grantRole`.
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");

    /// @notice Seconds in a day, used by `_updateRevenue` to normalize raw revenue to a daily rate.
    uint256 internal constant ONE_DAY = 86400;

    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice Maximum age of a revenue report before `getRevenue` flags it as stale. Set at
    ///         construction and never updated.
    uint256 public immutable STALENESS_WINDOW_SECONDS;

    /*//////////////////////////////////////////////////////////////
                           STORAGE VARIABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice Most recent revenue figure normalized to a 24h rate, 1e18-scaled USD. Zero before
    ///         the first `_updateRevenue` call.
    uint256 internal _lastRevenueUSD;

    /// @notice Timestamp passed to the most recent `_updateRevenue` call. Zero before the first
    ///         report.
    uint256 internal _lastReportTimestamp;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event RevenueUpdated(uint256 revenueUSD, uint256 reportTimestamp);

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error InvalidAdminAddress(address admin);
    error InvalidStalenessWindow(uint256 stalenessWindowSeconds);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Grants `DEFAULT_ADMIN_ROLE` to `admin_`. `EMERGENCY_ROLE` is intentionally withheld
     *         so pause authority can be delegated to the Emergency Committee post-deployment.
     */
    constructor(address admin_, uint256 stalenessWindowSeconds_) {
        if (admin_ == address(0)) {
            revert InvalidAdminAddress(admin_);
        }
        if (stalenessWindowSeconds_ == 0) {
            revert InvalidStalenessWindow(stalenessWindowSeconds_);
        }

        STALENESS_WINDOW_SECONDS = stalenessWindowSeconds_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
    }

    /*//////////////////////////////////////////////////////////////
                           EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Halts new revenue reports. Aggregation on `NESTController` skips paused sources.
    function pause() external onlyRole(EMERGENCY_ROLE) {
        _pause();
    }

    /// @notice Resumes revenue reporting.
    function unpause() external onlyRole(EMERGENCY_ROLE) {
        _unpause();
    }

    /*//////////////////////////////////////////////////////////////
                        EXTERNAL VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Returns the latest reported revenue along with its recording timestamp and a
     *         staleness flag. Reported as a daily rate regardless of the source's actual cadence.
     * @return revenueUSD      Normalized daily revenue in 1e18-scaled USD.
     * @return reportTimestamp Timestamp of the last successful update.
     * @return isStale         `true` before the first report, or once the staleness window elapses.
     */
    function getRevenue()
        external
        view
        returns (uint256 revenueUSD, uint256 reportTimestamp, bool isStale)
    {
        revenueUSD = _lastRevenueUSD;
        reportTimestamp = _lastReportTimestamp;
        isStale =
            reportTimestamp == 0 ||
            block.timestamp > reportTimestamp + STALENESS_WINDOW_SECONDS;
    }

    /*//////////////////////////////////////////////////////////////
                           INTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Writes a new revenue figure, normalizing to a daily rate over the elapsed period.
     *         Called by concrete sources after computing the raw revenue for the current window.
     * @dev    The first report (or any zero-length period) is stored raw — there is no prior
     *         baseline to scale against. Subsequent reports scale as
     *         `revenueUSD_ * ONE_DAY / (reportTimestamp_ - _lastReportTimestamp)`. A decreasing
     *         `reportTimestamp_` underflows intentionally, so callers must guarantee monotonicity.
     */
    function _updateRevenue(uint256 revenueUSD_, uint256 reportTimestamp_) internal {
        uint256 periodSeconds = reportTimestamp_ - _lastReportTimestamp;

        uint256 dailyRevenueUSD = _lastReportTimestamp == 0 || periodSeconds == 0
            ? revenueUSD_
            : (revenueUSD_ * ONE_DAY) / periodSeconds;

        _lastRevenueUSD = dailyRevenueUSD;
        _lastReportTimestamp = reportTimestamp_;

        emit RevenueUpdated(dailyRevenueUSD, reportTimestamp_);
    }
}
