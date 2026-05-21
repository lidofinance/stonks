// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {AccessControlEnumerable} from "@openzeppelin/contracts/access/AccessControlEnumerable.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";
import {IRevenueSource} from "../../interfaces/IRevenueSource.sol";

/**
 * @title RevenueSource
 * @author swissarmytowel <info@lido.fi>
 * @notice Base contract for revenue data providers consumed by `NESTController`. Holds the
 *         shared report storage, the daily-rate normalization, and the staleness check.
 * @dev    Revenue sources hold no recoverable assets, so `AssetRecovererACL` is not inherited.
 *         `EMERGENCY_ROLE` is defined locally with the same `keccak256("NEST.RevenueSource.EMERGENCY_ROLE")` hash
 *         as the ACL variant, so the same operators can pause every NEST component.
 */
abstract contract RevenueSource is IRevenueSource, AccessControlEnumerable, Pausable {
    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Role gating `pause` / `unpause`. Withheld at construction. The admin delegates it
    ///         post-deployment to the Emergency Committee via `grantRole`.
    bytes32 public constant EMERGENCY_ROLE = keccak256("NEST.RevenueSource.EMERGENCY_ROLE");

    /// @notice Seconds in one day. Used by `_updateRevenue` to normalize raw revenue to a daily rate.
    uint256 internal constant ONE_DAY = 1 days;

    // sanity cap to prevent very large staleness windows
    uint256 internal constant MAX_STALENESS_WINDOW_SECONDS = 30 days;

    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice Maximum age of a revenue report before `getRevenue` flags it as stale.
    uint256 public immutable STALENESS_WINDOW_SECONDS;

    /// @notice Minimum elapsed seconds between consecutive accepted reports. Caps the
    ///         daily-rate amplification factor at `ONE_DAY / MIN_REPORT_INTERVAL_SECONDS` and
    ///         blocks same-block report bursts.
    uint256 public immutable MIN_REPORT_INTERVAL_SECONDS;

    /// @notice Deployment timestamp. The first report normalizes its period against this so a long
    ///         deployment-to-first-report gap is not recorded verbatim as a daily rate.
    uint256 private immutable _deploymentTimestamp;

    /*//////////////////////////////////////////////////////////////
                           STORAGE VARIABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice Most recent revenue figure normalized to a 24h rate, 1e18-scaled USD. Zero before
    ///         the first `_updateRevenue` call.
    uint256 private _lastRevenueUSD;

    /// @notice Timestamp passed to the most recent `_updateRevenue` call. Zero before the first
    ///         report.
    uint256 private _lastReportTimestamp;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event RevenueUpdated(uint256 indexed reportTimestamp, uint256 normalizedRevenueUSD);

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error InvalidAdminAddress(address admin);
    error InvalidStalenessWindow(uint256 stalenessWindowSeconds);
    error InvalidMinReportInterval(uint256 minReportIntervalSeconds);
    error NonMonotonicReport(uint256 reportTimestamp, uint256 baselineTimestamp);
    error ReportTooSoon(uint256 periodSeconds, uint256 minimum);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Grants `DEFAULT_ADMIN_ROLE` to `admin_`. `EMERGENCY_ROLE` is withheld so pause
     *         authority can be delegated to the Emergency Committee post-deployment.
     * @param  admin_ Initial admin and role manager. Non-zero.
     * @param  stalenessWindowSeconds_ Maximum age before `getRevenue` flags a report stale.
     *         Strictly positive and `<= MAX_STALENESS_WINDOW_SECONDS`.
     * @param  minReportIntervalSeconds_ Minimum spacing between consecutive accepted reports.
     *         Strictly positive and `<= stalenessWindowSeconds_`; subclasses choose a value
     *         consistent with their reporter's expected cadence.
     */
    constructor(
        address admin_,
        uint256 stalenessWindowSeconds_,
        uint256 minReportIntervalSeconds_
    ) {
        if (admin_ == address(0)) {
            revert InvalidAdminAddress(admin_);
        }
        if (
            stalenessWindowSeconds_ == 0 || stalenessWindowSeconds_ > MAX_STALENESS_WINDOW_SECONDS
        ) {
            revert InvalidStalenessWindow(stalenessWindowSeconds_);
        }
        if (minReportIntervalSeconds_ == 0 || minReportIntervalSeconds_ > stalenessWindowSeconds_) {
            revert InvalidMinReportInterval(minReportIntervalSeconds_);
        }

        STALENESS_WINDOW_SECONDS = stalenessWindowSeconds_;
        MIN_REPORT_INTERVAL_SECONDS = minReportIntervalSeconds_;
        _deploymentTimestamp = block.timestamp;

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(EMERGENCY_ROLE, admin_);
    }

    /*//////////////////////////////////////////////////////////////
                           EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Halts new revenue reports. The NESTController aggregator skips paused sources.
     */
    function pause() external onlyRole(EMERGENCY_ROLE) {
        _pause();
    }

    /**
     * @notice Resumes revenue reporting.
     */
    function unpause() external onlyRole(EMERGENCY_ROLE) {
        _unpause();
    }

    /*//////////////////////////////////////////////////////////////
                        EXTERNAL VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Latest revenue report, normalized to a daily rate independent of the source's cadence.
     * @return revenueUSD      Normalized daily revenue in 1e18-scaled USD.
     * @return reportTimestamp Timestamp of the last successful update.
     * @return isStale         `true` before the first report or once the staleness window elapses.
     */
    function getRevenue()
        external
        view
        returns (uint256 revenueUSD, uint256 reportTimestamp, bool isStale)
    {
        revenueUSD = _lastRevenueUSD;
        reportTimestamp = _lastReportTimestamp;
        isStale = block.timestamp > reportTimestamp + STALENESS_WINDOW_SECONDS;
    }

    /*///////////////////////////////////////////////////////////////
                    PUBLIC VIEW FUNCTIONS OVERRIDES
    //////////////////////////////////////////////////////////////*/

    function paused() public view virtual override(IRevenueSource, Pausable) returns (bool) {
        return super.paused();
    }

    /*//////////////////////////////////////////////////////////////
                           INTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Writes a new revenue figure, normalizing to a daily rate over the elapsed period.
     * @dev    The first report normalizes against the deployment timestamp; subsequent reports
     *         normalize against the prior report. Reverts with `NonMonotonicReport` if the new
     *         timestamp predates the baseline, and with `ReportTooSoon` if the elapsed period
     *         is below `MIN_REPORT_INTERVAL_SECONDS`. The minimum-interval check also rules out
     *         the same-block bypass that would otherwise skip rate normalization.
     * @param  revenueUSD_ Raw revenue accrued since the previous report, 1e18-scaled USD.
     * @param  reportTimestamp_ Timestamp of the new report. Must be `>= baseline + MIN_REPORT_INTERVAL_SECONDS`.
     */
    function _updateRevenue(uint256 revenueUSD_, uint256 reportTimestamp_) internal whenNotPaused {
        uint256 baseline = _lastReportTimestamp == 0 ? _deploymentTimestamp : _lastReportTimestamp;
        if (reportTimestamp_ < baseline) {
            revert NonMonotonicReport(reportTimestamp_, baseline);
        }

        uint256 periodSeconds = reportTimestamp_ - baseline;
        if (periodSeconds < MIN_REPORT_INTERVAL_SECONDS) {
            revert ReportTooSoon(periodSeconds, MIN_REPORT_INTERVAL_SECONDS);
        }

        uint256 dailyRevenueUSD = (revenueUSD_ * ONE_DAY) / periodSeconds;

        _lastRevenueUSD = dailyRevenueUSD;
        _lastReportTimestamp = reportTimestamp_;

        emit RevenueUpdated(dailyRevenueUSD, reportTimestamp_);
    }
}
