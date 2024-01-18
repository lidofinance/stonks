// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Stonks} from "../Stonks.sol";
import {Order} from "../Order.sol";

contract StonksFactory {
    address public immutable AGENT;
    address public immutable ORDER_SAMPLE;
    address public immutable SETTLEMENT;
    address public immutable RELAYER;

    event OrderSampleDeployed(address orderAddress);
    event StonksDeployed(
        address indexed stonksAddress,
        address agent,
        address manager,
        address tokenFrom,
        address tokenTo,
        address amountConverter,
        address order,
        uint256 orderDurationInSeconds,
        uint256 marginInBasisPoints,
        uint256 priceToleranceInBasisPoints
    );

    error ZeroAddress();

    constructor(address agent_, address settlement_, address relayer_) {
        if (agent_ == address(0)) revert ZeroAddress();
        if (settlement_ == address(0)) revert ZeroAddress();
        if (relayer_ == address(0)) revert ZeroAddress();

        AGENT = agent_;
        RELAYER = relayer_;
        SETTLEMENT = settlement_;
        ORDER_SAMPLE = address(new Order(agent_, settlement_, relayer_));

        emit OrderSampleDeployed(ORDER_SAMPLE);
    }

    function deployStonks(
        address manager_,
        address tokenFrom_,
        address tokenTo_,
        address amountConverter_,
        uint256 orderDurationInSeconds_,
        uint256 marginInBasisPoints_,
        uint256 priceToleranceInBasisPoints_
    ) public returns (address stonks) {
        stonks = address(
            new Stonks(
                AGENT,
                manager_,
                tokenFrom_, 
                tokenTo_,
                amountConverter_,
                ORDER_SAMPLE,
                orderDurationInSeconds_,
                marginInBasisPoints_,
                priceToleranceInBasisPoints_
            )
        );
        emit StonksDeployed(
            stonks,
            AGENT,
            manager_,
            tokenFrom_,
            tokenTo_,
            amountConverter_,
            ORDER_SAMPLE,
            orderDurationInSeconds_,
            marginInBasisPoints_,
            priceToleranceInBasisPoints_
        );
    }
}
