// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Stonks} from "../Stonks.sol";

contract StonksTest is Stonks {
    constructor(
        address agent_,
        address manager_,
        address tokenFrom_,
        address tokenTo_,
        address amountConverter_,
        address orderSample_,
        uint256 orderDurationInSeconds_,
        uint256 marginInBasisPoints_,
        uint256 priceToleranceInBasisPoints_
    )
        Stonks(
            agent_,
            manager_,
            tokenFrom_,
            tokenTo_,
            amountConverter_,
            orderSample_,
            orderDurationInSeconds_,
            marginInBasisPoints_,
            priceToleranceInBasisPoints_
        )
    {}

    function getMargin() external view returns (uint256) {
        return MARGIN_IN_BASIS_POINTS;
    }
}
