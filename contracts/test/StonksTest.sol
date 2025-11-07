// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Stonks} from "../Stonks.sol";

/**
 * @title Test contract for Stonks functionality.
 */
contract StonksTest is Stonks {
    // ==================== Constructor ====================

    /**
     * @notice Initializes the test contract with Stonks parameters.
     * @param agent_ Agent address.
     * @param manager_ Manager address.
     * @param tokenFrom_ Token to sell.
     * @param tokenTo_ Token to buy.
     * @param amountConverter_ Amount converter address.
     * @param orderSample_ Order sample address.
     * @param oracleRouter_ Oracle router address.
     * @param orderDurationInSeconds_ Order duration in seconds.
     * @param marginInBasisPoints_ Margin in basis points.
     * @param priceToleranceInBasisPoints_ Price tolerance in basis points.
     * @param maxImprovementInBasisPoints_ Maximum price improvement allowed in basis points.
     * @param allowPartialFill_ Whether orders should allow partial fills (useful for rebasable tokens).
     */
    constructor(
        address agent_,
        address manager_,
        address tokenFrom_,
        address tokenTo_,
        address amountConverter_,
        address orderSample_,
        address oracleRouter_,
        uint256 orderDurationInSeconds_,
        uint256 marginInBasisPoints_,
        uint256 priceToleranceInBasisPoints_,
        uint256 maxImprovementInBasisPoints_,
        bool allowPartialFill_
    )
        Stonks(
            agent_,
            manager_,
            tokenFrom_,
            tokenTo_,
            amountConverter_,
            orderSample_,
            oracleRouter_,
            orderDurationInSeconds_,
            marginInBasisPoints_,
            priceToleranceInBasisPoints_,
            maxImprovementInBasisPoints_,
            allowPartialFill_
        )
    {}

    // ==================== External View Functions ====================

    /**
     * @notice Gets the margin value for testing.
     * @return Margin in basis points.
     */
    function getMargin() external view returns (uint256) {
        return MARGIN_IN_BASIS_POINTS;
    }
}
