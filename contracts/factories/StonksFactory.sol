// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {Stonks} from "../Stonks.sol";
import {Order} from "../Order.sol";

contract StonksFactory {
    address public immutable agent;
    address public immutable orderSample;
    address public immutable settlement;
    address public immutable relayer;

    event OrderSampleDeployed(address orderAddress);
    event StonksDeployed(
        address indexed stonksAddress,
        address agent,
        address operator,
        address tokenFrom,
        address tokenTo,
        address amountConverter,
        address order,
        uint256 orderDurationInSeconds,
        uint256 marginBasisPoints,
        uint256 priceToleranceInBasisPoints
    );

    error InvalidAgentAddress();
    error InvalidSettlementAddress();
    error InvalidRelayerAddress();

    constructor(address agent_, address settlement_, address relayer_) {
        if (agent_ == address(0)) revert InvalidAgentAddress();
        if (settlement_ == address(0)) revert InvalidSettlementAddress();
        if (relayer_ == address(0)) revert InvalidRelayerAddress();

        agent = agent_;
        relayer = relayer_;
        settlement = settlement_;
        orderSample = address(new Order(agent_, settlement_, relayer_));

        emit OrderSampleDeployed(orderSample);
    }

    function deployStonks(
        address manager_,
        address tokenFrom_,
        address tokenTo_,
        address amountConverter_,
        uint256 orderDurationInSeconds_,
        uint256 marginBasisPoints_,
        uint256 priceToleranceInBasisPoints_
    ) public returns (address stonks) {
        stonks = address(
            new Stonks(
                agent,
                manager_,
                tokenFrom_, 
                tokenTo_,
                amountConverter_,
                orderSample,
                orderDurationInSeconds_,
                marginBasisPoints_,
                priceToleranceInBasisPoints_
            )
        );
        emit StonksDeployed(
            stonks,
            agent,
            manager_,
            tokenFrom_,
            tokenTo_,
            amountConverter_,
            orderSample,
            orderDurationInSeconds_,
            marginBasisPoints_,
            priceToleranceInBasisPoints_
        );
    }
}
