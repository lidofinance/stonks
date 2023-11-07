// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Stonks} from "./Stonks.sol";
import {Order} from "./Order.sol";
import {PriceChecker} from "./PriceChecker.sol";

contract StonksFactory {
    address public immutable order;

    event OrderDeployed(address orderAddress);
    event PriceCheckerDeployed(
        address priceCheckerAddress,
        address priceFeedAddress,
        address firstTokenAddress,
        address secondTokenAddress,
        uint16 marginBasisPoints
    );
    event StonksDeployed(
        address stonksAddress, address tokenFrom, address tokenTo, address priceChecker, address operator, address order
    );

    constructor() {
        order = address(new Order());
        emit OrderDeployed(order);
    }

    function deployStonks(address tokenFrom_, address tokenTo_, address priceChecker_, address operator_)
        public
        returns (address stonks)
    {
        stonks = address(new Stonks(tokenFrom_, tokenTo_, priceChecker_, operator_, order));
        emit StonksDeployed(stonks, tokenFrom_, tokenTo_, priceChecker_, operator_, order);
    }

    function deployPriceChecker(
        address priceFeedAddress_,
        address firstTokenAddress_,
        address secondTokenAddress_,
        uint16 marginBasisPoints
    ) public returns (address priceChecker) {
        priceChecker =
            address(new PriceChecker(priceFeedAddress_, firstTokenAddress_, secondTokenAddress_, marginBasisPoints));
        emit PriceCheckerDeployed(
            priceChecker, priceFeedAddress_, firstTokenAddress_, secondTokenAddress_, marginBasisPoints
        );
    }

    function deployFullSetup(
        address tokenFrom_,
        address tokenTo_,
        address priceFeedAddress_,
        address firstTokenAddress_,
        address secondTokenAddress_,
        uint16 marginBasisPoints_
    ) external returns (address) {
        address priceChecker =
            deployPriceChecker(priceFeedAddress_, firstTokenAddress_, secondTokenAddress_, marginBasisPoints_);
        return deployStonks(tokenFrom_, tokenTo_, priceChecker, address(0));
    }
}
