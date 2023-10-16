// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Stonks} from "./Stonks.sol";
import {PriceChecker} from "./PriceChecker.sol";

contract StonksFactory {
    event PriceCheckerDeployed(address priceCheckerAddress);
    event StonksDeployed(address stonksAddress);

    function deployStonks(address tokenFrom_, address tokenTo_, address priceChecker_) public returns (address) {
        return address(new Stonks(tokenFrom_, tokenTo_, priceChecker_));
    }

    function deployPriceChecker(
        address priceFeedAddress_,
        address firstTokenAddress_,
        address secondTokenAddress_,
        uint16 marginBasisPoints
    ) public returns (address priceChecker) {
        priceChecker =
            address(new PriceChecker(priceFeedAddress_, firstTokenAddress_, secondTokenAddress_, marginBasisPoints));
        emit PriceCheckerDeployed(priceChecker);
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
        return deployStonks(tokenFrom_, tokenTo_, priceChecker);
    }
}
