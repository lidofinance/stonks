// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Stonks} from "./Stonks.sol";
import {Order} from "./Order.sol";
import {ChainLinkUsdTokensConverter} from "./ChainLinkUsdTokensConverter.sol";

contract StonksFactory {
    address public immutable order;

    event OrderDeployed(address orderAddress);
    event PriceCheckerDeployed(
        address indexed priceCheckerAddress,
        address feedRegistryAddress,
        address[] allowedTokensToSell,
        address[] allowedStableTokensToBuy
    );
    event StonksDeployed(
        address indexed stonksAddress, address tokenFrom, address tokenTo, address priceChecker, address operator, address order, uint256 marginBasisPoints
    );

    constructor() {
        order = address(new Order());
        emit OrderDeployed(order);
    }

    function deployStonks(address tokenFrom_, address tokenTo_, address priceChecker_, address operator_, uint256 marginBasisPoints_)
        public
        returns (address stonks)
    {
        stonks = address(new Stonks(tokenFrom_, tokenTo_, priceChecker_, operator_, order, marginBasisPoints_));
        emit StonksDeployed(stonks, tokenFrom_, tokenTo_, priceChecker_, operator_, order, marginBasisPoints_);
    }

    function deployChainLinkUsdTokensConverter(
        address feedRegistry_,
        address[] memory allowedTokensToSell_,
        address[] memory allowedStableTokensToBuy_
    ) public returns (address priceChecker) {
        priceChecker =
            address(new ChainLinkUsdTokensConverter(feedRegistry_, allowedTokensToSell_, allowedStableTokensToBuy_));
        emit PriceCheckerDeployed(
            priceChecker, feedRegistry_, allowedTokensToSell_, allowedStableTokensToBuy_
        );
    }

    function deployFullSetup(
        address tokenFrom_,
        address tokenTo_,
        address feedRegistry_,
        address[] memory allowedTokensToSell_,
        address[] memory allowedStableTokensToBuy_,
        uint16 marginBasisPoints_
    ) external returns (address) {
        address priceChecker =
            deployChainLinkUsdTokensConverter(feedRegistry_, allowedTokensToSell_, allowedStableTokensToBuy_);
        return deployStonks(tokenFrom_, tokenTo_, priceChecker, address(0), marginBasisPoints_);
    }
}
