// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

/**
 * @title MathHelpers
 * @author swissarmytowel <info@lido.fi>
 * @notice Small math helpers shared across buyback contracts.
 */
library MathHelpers {
    /**
     * @dev Unsigned saturating subtraction, bounds to zero on underflow.
     */
    function saturatingSub(uint256 a_, uint256 b_) internal pure returns (uint256) {
        unchecked {
            uint256 c = a_ - b_;
            bool success = c <= a_;
            uint256 result = c * _toUint(success);

            return result;
        }
    }

    /**
     * @dev Cast a boolean (false or true) to a uint256 (0 or 1) with no jump.
     */
    function _toUint(bool b_) internal pure returns (uint256 u) {
        assembly ("memory-safe") {
            u := iszero(iszero(b_))
        }
    }
}
