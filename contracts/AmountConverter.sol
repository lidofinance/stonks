// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IAmountConverter} from "./interfaces/IAmountConverter.sol";
import {IOracleRouter} from "./interfaces/IOracleRouter.sol";

/**
 * @title AmountConverter
 * @dev This contract provides functionality for converting the amount
 *      of Token A into the amount of Token B based on oracle router prices.
 */
contract AmountConverter is IAmountConverter {
    // ==================== Immutables ====================

    /// @notice Oracle router contract used for fetching token prices.
    IOracleRouter public immutable ORACLE_ROUTER;
    /// @notice If true, uses ETH-denominated prices directly (gas optimized for ETH-quoted pairs).
    ///         If false, uses USD prices (supports mixed denominations).
    bool public immutable USE_ETH_ANCHOR;

    // ==================== Storage Variables ====================

    /// @notice Mapping indicating which tokens are allowed to be sold.
    mapping(address tokenToSell => bool allowed) public allowedTokensToSell;
    /// @notice Mapping indicating which tokens are allowed to be bought.
    mapping(address tokenToBuy => bool allowed) public allowedTokensToBuy;

    // ==================== Events ====================

    event AllowedTokenToSellAdded(address tokenAddress);
    event AllowedTokenToBuyAdded(address tokenAddress);

    // ==================== Errors ====================

    error InvalidOracleRouterAddress(address oracleRouter);
    error InvalidAllowedTokenToBuy(address allowedTokenToBuy);
    error InvalidAllowedTokenToSell(address allowedTokenToSell);
    error InvalidAmount(uint256 amount);
    error InvalidTokensToSellArrayLength();
    error InvalidTokensToBuyArrayLength();
    error SellTokenNotAllowed(address tokenFrom);
    error BuyTokenNotAllowed(address tokenTo);
    error TokensCannotBeSame();
    error InvalidDecimalsDifference(uint8 diff);
    error AmountFromTooLarge(uint256 amount);
    error PriceFromUsdZero();
    error PriceToUsdZero();

    // ==================== Constructor ====================

    /**
     * @param oracleRouter_ Oracle router for price fetching
     * @param allowedTokensToSell_ List of addresses which are allowed to use as sell tokens
     * @param allowedTokensToBuy_ List of addresses of tokens that are allowed to be bought
     * @param useEthAnchor_ If true, uses ETH-anchored pricing (both tokens must be ETH-quoted).
     *                      If false, uses USD pricing (supports any denomination mix).
     */
    constructor(
        address oracleRouter_,
        address[] memory allowedTokensToSell_,
        address[] memory allowedTokensToBuy_,
        bool useEthAnchor_
    ) {
        if (oracleRouter_ == address(0)) {
            revert InvalidOracleRouterAddress(oracleRouter_);
        }
        if (allowedTokensToSell_.length == 0) {
            revert InvalidTokensToSellArrayLength();
        }
        if (allowedTokensToBuy_.length == 0) {
            revert InvalidTokensToBuyArrayLength();
        }

        ORACLE_ROUTER = IOracleRouter(oracleRouter_);
        USE_ETH_ANCHOR = useEthAnchor_;

        for (uint256 i; i < allowedTokensToBuy_.length; ) {
            if (allowedTokensToBuy_[i] == address(0)) {
                revert InvalidAllowedTokenToBuy(allowedTokensToBuy_[i]);
            }

            allowedTokensToBuy[allowedTokensToBuy_[i]] = true;
            emit AllowedTokenToBuyAdded(allowedTokensToBuy_[i]);

            unchecked {
                ++i;
            }
        }

        for (uint256 i; i < allowedTokensToSell_.length; ) {
            if (allowedTokensToSell_[i] == address(0)) {
                revert InvalidAllowedTokenToSell(allowedTokensToSell_[i]);
            }

            allowedTokensToSell[allowedTokensToSell_[i]] = true;
            emit AllowedTokenToSellAdded(allowedTokensToSell_[i]);

            unchecked {
                ++i;
            }
        }
    }

    // ==================== External View Functions ====================

    /**
     * @notice Calculates the expected amount of `tokenTo_` that one would receive for a given amount of `tokenFrom_`.
     * @dev Uses the oracle router to get the current price relation between tokens and handles decimal scaling.
     *
     * @param tokenFrom_ The address of the token being sold.
     * @param tokenTo_ The address of the token being bought.
     * @param amountFrom_ The amount of `tokenFrom_` that is being sold.
     * @return expectedOutputAmount The expected amount of `tokenTo_` that will be received.
     */
    function getExpectedOut(
        address tokenFrom_,
        address tokenTo_,
        uint256 amountFrom_
    ) external view returns (uint256 expectedOutputAmount) {
        if (tokenFrom_ == tokenTo_) {
            revert TokensCannotBeSame();
        }
        if (!allowedTokensToSell[tokenFrom_]) {
            revert SellTokenNotAllowed(tokenFrom_);
        }
        if (!allowedTokensToBuy[tokenTo_]) {
            revert BuyTokenNotAllowed(tokenTo_);
        }
        if (amountFrom_ == 0) {
            revert InvalidAmount(amountFrom_);
        }
        if (amountFrom_ > type(uint128).max) {
            revert AmountFromTooLarge(amountFrom_);
        }

        uint256 priceFrom;
        uint256 priceTo;
        uint8 decimalsOfSellToken;
        uint8 decimalsOfBuyToken;

        if (USE_ETH_ANCHOR) {
            // ETH-anchored mode: read TOKEN/ETH prices directly (gas optimized)
            (priceFrom, priceTo, decimalsOfSellToken, decimalsOfBuyToken) = ORACLE_ROUTER
                .getEthPricesAndDecimals(tokenFrom_, tokenTo_);
        } else {
            // USD mode: read TOKEN/USD prices (supports mixed denominations)
            (priceFrom, priceTo, decimalsOfSellToken, decimalsOfBuyToken) = ORACLE_ROUTER
                .getUsdPricesAndDecimals(tokenFrom_, tokenTo_);
        }

        if (priceFrom == 0) {
            revert PriceFromUsdZero();
        }
        if (priceTo == 0) {
            revert PriceToUsdZero();
        }

        bool sellHasMoreOrEqualDecimals = decimalsOfSellToken >= decimalsOfBuyToken;
        uint8 decimalsDiff = sellHasMoreOrEqualDecimals
            ? (decimalsOfSellToken - decimalsOfBuyToken)
            : (decimalsOfBuyToken - decimalsOfSellToken);

        if (decimalsDiff > 38) {
            revert InvalidDecimalsDifference(decimalsDiff);
        }

        if (sellHasMoreOrEqualDecimals) {
            uint256 grossOutput = Math.mulDiv(amountFrom_, priceFrom, priceTo, Math.Rounding.Down);
            expectedOutputAmount = (decimalsDiff == 0)
                ? grossOutput
                : grossOutput / (10 ** decimalsDiff);
        } else {
            // Scale the input first to avoid overflow on multiplication by 10**diff.
            uint256 pow10 = 10 ** decimalsDiff;
            uint256 maxAmountFromBeforeScale = type(uint256).max / pow10;

            if (amountFrom_ > maxAmountFromBeforeScale) {
                revert AmountFromTooLarge(amountFrom_);
            }

            uint256 scaledAmountFrom = amountFrom_ * pow10;
            expectedOutputAmount = Math.mulDiv(
                scaledAmountFrom,
                priceFrom,
                priceTo,
                Math.Rounding.Down
            );
        }
    }
}
