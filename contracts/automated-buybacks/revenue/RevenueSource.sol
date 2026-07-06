// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IRevenueSource} from "../../interfaces/IRevenueSource.sol";

/**
 * @title RevenueSource
 * @author swissarmytowel <info@lido.fi>
 * @notice Base contract for revenue data providers. Maintains a monotonic cumulative USD
 *         revenue accumulator and exposes it as the sole read.
 * @dev    Carries the ERC-165 advertisement for `IRevenueSource` so every concrete source is
 *         registrable by consumers (e.g. `BuybackAllocator`) without re-declaring it. Children
 *         that expose extra interfaces override `supportsInterface` and chain through `super`.
 * @dev    Every source must stay monotonic, always-live, and fully settled: the cumulative only
 *         grows, `getCumulativeRevenueUSD` never reverts, and it reflects all revenue earned up
 *         to the read. `BuybackAllocator` budget integrity rests on these properties.
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

    /**
     * @notice ERC-165 support. Advertises `IRevenueSource` and `IERC165` for every concrete
     *         source. Children that add interfaces override and chain via `super`.
     * @param  interfaceId_ Interface identifier to probe.
     * @return `true` for `IRevenueSource` and `IERC165`.
     */
    function supportsInterface(bytes4 interfaceId_) public view virtual override returns (bool) {
        return
            interfaceId_ == type(IRevenueSource).interfaceId ||
            interfaceId_ == type(IERC165).interfaceId;
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
