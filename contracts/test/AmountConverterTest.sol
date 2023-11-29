// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {AmountConverter} from "../AmountConverter.sol";
import "hardhat/console.sol";

contract AmountConverterTest {
    AmountConverter public amountConverter;

    uint256 public constant MAX_BASIS_POINTS = 20_000;
    uint256 public constant MIN_BASIS_POINTS = 0;
    uint256 public multiplierInBP = 10_000;

    constructor(
        address feedRegistry_,
        address conversionTarget_,
        address[] memory allowedTokensToSell_,
        address[] memory allowedTokensToBuy_
    ) {
        amountConverter = new AmountConverter(
            feedRegistry_,
            conversionTarget_,
            allowedTokensToSell_,
            allowedTokensToBuy_
        );
    }

    function multiplyAnswer(uint256 multiplierInBP_) public {
        if (multiplierInBP_ > MAX_BASIS_POINTS) revert("Error");
        if (multiplierInBP_ <= 0) revert("Error");

        multiplierInBP = multiplierInBP_;
    }

    function getExpectedOut(address tokenFrom, address tokenTo, uint256 amount) external view returns (uint256) {
        return amountConverter.getExpectedOut(tokenFrom, tokenTo, amount) * multiplierInBP / 10_000;
    }
}
