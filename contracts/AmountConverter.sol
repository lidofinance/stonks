// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IAmountConverter} from "./interfaces/IAmountConverter.sol";
import {IOracleRouter} from "./interfaces/IOracleRouter.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract AmountConverter is IAmountConverter {
    IOracleRouter public immutable ORACLE_ROUTER;

    mapping(address tokenToSell => bool allowed) public allowedTokensToSell;
    mapping(address tokenToBuy => bool allowed) public allowedTokensToBuy;

    event AllowedTokenToSellAdded(address tokenAddress);
    event AllowedTokenToBuyAdded(address tokenAddress);

    error InvalidOracleRouterAddress(address oracleRouterAddress);
    error InvalidAllowedTokenToBuy(address allowedTokenToBuy);
    error InvalidAllowedTokenToSell(address allowedTokenToSell);
    error InvalidAmount(uint256 amount);
    error InvalidTokensToSellArrayLength();
    error InvalidTokensToBuyArrayLength();
    error SellTokenNotAllowed(address tokenFrom);
    error BuyTokenNotAllowed(address tokenTo);
    error SameTokensConversion();
    error InvalidDecimalsDifference(uint8 diff);
    error AmountTooLarge(uint256 amount);
    error PriceFromUsdZero();
    error PriceToUsdZero();

    constructor(
        address oracleRouter_,
        address[] memory allowedTokensToSell_,
        address[] memory allowedTokensToBuy_
    ) {
        if (oracleRouter_ == address(0)) revert InvalidOracleRouterAddress(oracleRouter_);
        if (allowedTokensToSell_.length == 0) revert InvalidTokensToSellArrayLength();
        if (allowedTokensToBuy_.length == 0) revert InvalidTokensToBuyArrayLength();

        ORACLE_ROUTER = IOracleRouter(oracleRouter_);

        for (uint256 i; i < allowedTokensToBuy_.length; ++i) {
            if (allowedTokensToBuy_[i] == address(0))
                revert InvalidAllowedTokenToBuy(allowedTokensToBuy_[i]);
            allowedTokensToBuy[allowedTokensToBuy_[i]] = true;
            emit AllowedTokenToBuyAdded(allowedTokensToBuy_[i]);
        }

        for (uint256 i; i < allowedTokensToSell_.length; ++i) {
            if (allowedTokensToSell_[i] == address(0))
                revert InvalidAllowedTokenToSell(allowedTokensToSell_[i]);
            allowedTokensToSell[allowedTokensToSell_[i]] = true;
            emit AllowedTokenToSellAdded(allowedTokensToSell_[i]);
        }
    }

    function getExpectedOut(
        address tokenFrom_,
        address tokenTo_,
        uint256 amountFrom_
    ) external view returns (uint256 expectedOutputAmount) {
        if (tokenFrom_ == tokenTo_) revert SameTokensConversion();
        if (!allowedTokensToSell[tokenFrom_]) revert SellTokenNotAllowed(tokenFrom_);
        if (!allowedTokensToBuy[tokenTo_]) revert BuyTokenNotAllowed(tokenTo_);
        if (amountFrom_ == 0) revert InvalidAmount(amountFrom_);
        if (amountFrom_ > type(uint128).max) revert AmountTooLarge(amountFrom_);

        (
            uint256 priceFromUsd,
            uint256 priceToUsd,
            uint8 decimalsOfSellToken,
            uint8 decimalsOfBuyToken
        ) = ORACLE_ROUTER.getPricesAndDecimals(tokenFrom_, tokenTo_);

        if (priceFromUsd == 0) revert PriceFromUsdZero();
        if (priceToUsd == 0) revert PriceToUsdZero();

        bool sellHasMoreOrEqualDecimals = decimalsOfSellToken >= decimalsOfBuyToken;
        uint8 decimalsDiff = sellHasMoreOrEqualDecimals
            ? (decimalsOfSellToken - decimalsOfBuyToken)
            : (decimalsOfBuyToken - decimalsOfSellToken);
        if (decimalsDiff > 38) revert InvalidDecimalsDifference(decimalsDiff);

        if (sellHasMoreOrEqualDecimals) {
            uint256 grossOutput = Math.mulDiv(amountFrom_, priceFromUsd, priceToUsd, Math.Rounding.Down);
            expectedOutputAmount = (decimalsDiff == 0)
                ? grossOutput
                : grossOutput / (10 ** decimalsDiff);
        } else {
            // Scale the input first to avoid overflow on multiplication by 10**diff.
            uint256 pow10 = 10 ** decimalsDiff;
            uint256 maxAmountFromBeforeScale = type(uint256).max / pow10;
            if (amountFrom_ > maxAmountFromBeforeScale) revert AmountTooLarge(amountFrom_);

            uint256 scaledAmountFrom = amountFrom_ * pow10;
            expectedOutputAmount = Math.mulDiv(scaledAmountFrom, priceFromUsd, priceToUsd, Math.Rounding.Down);
        }
    }
}
