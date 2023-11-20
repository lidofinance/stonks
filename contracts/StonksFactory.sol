// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Stonks} from "./Stonks.sol";
import {Order} from "./Order.sol";
import {ChainLinkUsdTokensConverter} from "./ChainLinkUsdTokensConverter.sol";

contract StonksFactory {
    address public immutable order;

    event OrderDeployed(address orderAddress);
    event TokenConverterDeployed(
        address indexed tokenConverterAddress,
        address feedRegistryAddress,
        address[] allowedTokensToSell,
        address[] allowedStableTokensToBuy
    );
    event StonksDeployed(
        address indexed stonksAddress,
        address tokenFrom,
        address tokenTo,
        address tokenConverter,
        address operator,
        address order,
        uint256 marginBasisPoints,
        uint256 priceToleranceInBasisPoints
    );

    constructor() {
        order = address(new Order());
        emit OrderDeployed(order);
    }

    function deployStonks(
        address tokenFrom_,
        address tokenTo_,
        address tokenConverter_,
        address operator_,
        uint256 marginBasisPoints_,
        uint256 priceToleranceInBasisPoints_
    ) public returns (address stonks) {
        stonks = address(
            new Stonks(tokenFrom_, tokenTo_, tokenConverter_, operator_, order, marginBasisPoints_, priceToleranceInBasisPoints_)
        );
        emit StonksDeployed(
            stonks,
            tokenFrom_,
            tokenTo_,
            tokenConverter_,
            operator_,
            order,
            marginBasisPoints_,
            priceToleranceInBasisPoints_
        );
    }

    function deployChainLinkUsdTokensConverter(
        address feedRegistry_,
        address[] memory allowedTokensToSell_,
        address[] memory allowedStableTokensToBuy_
    ) public returns (address tokenConverter) {
        tokenConverter =
            address(new ChainLinkUsdTokensConverter(feedRegistry_, allowedTokensToSell_, allowedStableTokensToBuy_));
        emit TokenConverterDeployed(tokenConverter, feedRegistry_, allowedTokensToSell_, allowedStableTokensToBuy_);
    }
}
