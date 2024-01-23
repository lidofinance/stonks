// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {ICoWSwapSettlement} from "../interfaces/ICoWSwapSettlement.sol";

import {Stonks} from "../Stonks.sol";
import {Order} from "../Order.sol";

/**
 * @title StonksFactory
 * @dev Deploys new instances of the Stonks contract.
 */
contract StonksFactory {
    address public immutable ORDER_SAMPLE;
    address public immutable AGENT;

    event AgentSet(address agent);
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

    error InvalidAgentAddress();
    error InvalidSettlementAddress();
    error InvalidRelayerAddress();

    /**
     * @param agent_ Address of the Lido DAO agent
     * @param settlement_ Address of the Cow Protocol settlement contract
     * @param relayer_ Address of the Cow Protocol relayer contract
     */
    constructor(address agent_, address settlement_, address relayer_) {
        if (agent_ == address(0)) revert InvalidAgentAddress();
        if (relayer_ == address(0)) revert InvalidRelayerAddress();
        if (settlement_ == address(0)) revert InvalidSettlementAddress();

        AGENT = agent_;
        ORDER_SAMPLE = address(new Order(agent_, relayer_, ICoWSwapSettlement(settlement_).domainSeparator()));

        emit AgentSet(agent_);
        emit OrderSampleDeployed(ORDER_SAMPLE);
    }

    /**
     * @notice Deploys a new Stonks contract with specified parameters
     * @param manager_ Address of the manager for the new Stonks contract
     * @param tokenFrom_ Address of the token to be sold
     * @param tokenTo_ Address of the token to be bought
     * @param amountConverter_ Address of the amount converter contract
     * @param orderDurationInSeconds_ Duration of the order in seconds
     * @param marginInBasisPoints_ Margin represented in basis points
     * @param priceToleranceInBasisPoints_ Price tolerance in basis points
     * @return stonks The address of the newly deployed Stonks contract
     */
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
