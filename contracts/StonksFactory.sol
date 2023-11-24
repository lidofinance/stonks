// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Stonks} from "./Stonks.sol";
import {Order} from "./Order.sol";
import {TokenAmountConverter} from "./TokenAmountConverter.sol";

contract StonksFactory {
    address public immutable agent;
    address public immutable orderSample;
    address public immutable settlement;
    address public immutable relayer;
    address public immutable feedRegistry;

    event OrderDeployed(address orderAddress);
    event TokenAmountConverterDeployed(
        address indexed tokenAmountConverterAddress,
        address feedRegistryAddress,
        address[] allowedTokensToSell,
        address[] allowedStableTokensToBuy
    );
    event StonksDeployed(
        address indexed stonksAddress,
        address agent,
        address operator,
        address tokenFrom,
        address tokenTo,
        address tokenAmountConverter,
        address order,
        uint256 orderDurationInSeconds,
        uint256 marginBasisPoints,
        uint256 priceToleranceInBasisPoints
    );

    constructor(address agent_, address settlement_, address relayer_, address feedRegistry_) {
        agent = agent_;
        relayer = relayer_;
        settlement = settlement_;
        feedRegistry = feedRegistry_;
        orderSample = address(new Order(agent_, settlement_, relayer_));
        emit OrderDeployed(orderSample);
    }

    function deployStonks(
        address manager_,
        address tokenFrom_,
        address tokenTo_,
        address tokenAmountConverter_,
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
                tokenAmountConverter_,
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
            tokenAmountConverter_,
            orderSample,
            orderDurationInSeconds_,
            marginBasisPoints_,
            priceToleranceInBasisPoints_
        );
    }

    function deployTokenAmountConverter(
        address[] memory allowedTokensToSell_,
        address[] memory allowedStableTokensToBuy_
    ) public returns (address tokenAmountConverter) {
        tokenAmountConverter =
            address(new TokenAmountConverter(feedRegistry, allowedTokensToSell_, allowedStableTokensToBuy_));
        emit TokenAmountConverterDeployed(
            tokenAmountConverter, feedRegistry, allowedTokensToSell_, allowedStableTokensToBuy_
        );
    }
}
