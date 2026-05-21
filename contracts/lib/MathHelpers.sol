// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

/**
 * @title MathHelpers
 * @author swissarmytowel <info@lido.fi>
 * @notice Small math helpers shared across NEST contracts.
 */
library MathHelpers {
    /**
     * @notice Subtracts `b_` from `a_`, returning 0 when `b_ >= a_` instead of reverting.
     * @param  a_ Minuend.
     * @param  b_ Subtrahend.
     * @return Difference, or 0 if the subtraction would underflow.
     */
    function saturatedSub(uint256 a_, uint256 b_) internal pure returns (uint256) {
        unchecked {
            return a_ > b_ ? a_ - b_ : 0;
        }
    }
}
