// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {IRevenueSource} from "../../interfaces/IRevenueSource.sol";

/**
 * @title RevenueSource
 * @author swissarmytowel <info@lido.fi>
 * @notice Base contract for revenue data providers. Maintains a monotonic cumulative USD
 *         revenue accumulator and exposes it as the sole read.
 */
abstract contract RevenueSource is IRevenueSource {
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
     * @param  amountUSD_ Revenue accrued since the previous accepted report, 1e18-scaled USD.
     */
    function _addRevenueUSD(uint256 amountUSD_) internal {
        uint256 newTotal = _cumulativeRevenueUSD + amountUSD_;
        _cumulativeRevenueUSD = newTotal;
        emit RevenueAdded(amountUSD_, newTotal);
    }
}
