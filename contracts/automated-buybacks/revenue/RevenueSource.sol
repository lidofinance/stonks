// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {AccessControlEnumerable} from "@openzeppelin/contracts/access/AccessControlEnumerable.sol";
import {IRevenueSource} from "../../interfaces/IRevenueSource.sol";

/**
 * @title RevenueSource
 * @author swissarmytowel <info@lido.fi>
 * @notice Base contract for revenue data providers. Maintains a monotonic cumulative USD
 *         revenue accumulator and exposes it as the sole read.
 * @dev    Revenue sources hold no recoverable assets, so `AssetRecovererACL` is not inherited.
 */
abstract contract RevenueSource is IRevenueSource, AccessControlEnumerable {
    /*//////////////////////////////////////////////////////////////
                           STORAGE VARIABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice Monotonic cumulative revenue in 1e18-scaled USD.
    uint256 private _cumulativeRevenueUSD;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event RevenueAdded(uint256 amountUSD, uint256 cumulativeRevenueUSD);

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error InvalidAdminAddress(address admin);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Grants `DEFAULT_ADMIN_ROLE` to `admin_`.
     * @param  admin_ Initial admin and role manager. Non-zero.
     */
    constructor(address admin_) {
        if (admin_ == address(0)) {
            revert InvalidAdminAddress(admin_);
        }

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
    }

    /*//////////////////////////////////////////////////////////////
                        EXTERNAL VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Monotonic cumulative revenue contributed by this source since deployment.
     * @return Cumulative revenue in 1e18-scaled USD.
     */
    function getCumulativeRevenueUSD() external view returns (uint256) {
        return _cumulativeRevenueUSD;
    }

    /*//////////////////////////////////////////////////////////////
                           INTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Appends `amountUSD_` to the cumulative revenue accumulator.
     * @dev    Concrete sources call this after computing the revenue accrued since their
     *         previous report. Passing zero is a no-op write that still emits, which subclasses
     *         can use to signal a processed-but-zero-revenue event; if that signal is
     *         unnecessary, the subclass should skip the call entirely.
     * @param  amountUSD_ Revenue accrued since the previous accepted report, 1e18-scaled USD.
     */
    function _addRevenueUSD(uint256 amountUSD_) internal {
        uint256 newTotal = _cumulativeRevenueUSD + amountUSD_;
        _cumulativeRevenueUSD = newTotal;
        emit RevenueAdded(amountUSD_, newTotal);
    }
}
