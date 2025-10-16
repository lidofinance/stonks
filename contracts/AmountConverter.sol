// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IAmountConverter} from "./interfaces/IAmountConverter.sol";
import {IOracleRouter} from "./interfaces/IOracleRouter.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
/**
 * @title AmountConverter
 * @dev Converts an amount of one token into another using OracleRouter’s USD-anchored prices.
 *      No direct TOKEN/TOKEN feeds are queried here; the router handles TOKEN/USD or TOKEN/ETH→ETH/USD.
 */
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

    /**
     * @param oracleRouter_ OracleRouter used for USD-anchored pricing and cached decimals.
     * @param allowedTokensToSell_ Addresses allowed as input tokens.
     * @param allowedTokensToBuy_  Addresses allowed as output tokens.
     */
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

    /**
     * @notice Calculates the expected amount of `tokenTo_` received for `amountFrom_` of `tokenFrom_`.
     * @dev Uses OracleRouter to fetch USD-anchored prices for both tokens in one call. The router may reuse
     *      a single ETH/USD read when both sides are *\ETH. After price ratio, aligns token decimals via
     *      cached decimals from the router.
     * @param tokenFrom_ The token being sold.
     * @param tokenTo_   The token being bought.
     * @param amountFrom_ Amount of `tokenFrom_` being sold.
     * @return expectedOutputAmount The expected amount of `tokenTo_` to receive.
     */
    function getExpectedOut(
        address tokenFrom_,
        address tokenTo_,
        uint256 amountFrom_
    ) external view returns (uint256 expectedOutputAmount) {
        if (tokenFrom_ == tokenTo_) revert SameTokensConversion();
        if (allowedTokensToSell[tokenFrom_] == false) revert SellTokenNotAllowed(tokenFrom_);
        if (allowedTokensToBuy[tokenTo_] == false) revert BuyTokenNotAllowed(tokenTo_);
        if (amountFrom_ == 0) revert InvalidAmount(amountFrom_);
        if (amountFrom_ > type(uint128).max) revert AmountTooLarge(amountFrom_);

        (
            uint256 priceFromUSD,
            uint256 priceToUSD,
            uint8 decimalsOfSellToken,
            uint8 decimalsOfBuyToken
        ) = ORACLE_ROUTER.getPricesAndDecimals(tokenFrom_, tokenTo_);

        bool scaleDown = decimalsOfSellToken >= decimalsOfBuyToken;
        uint8 diff = scaleDown
            ? (decimalsOfSellToken - decimalsOfBuyToken)
            : (decimalsOfBuyToken - decimalsOfSellToken);
        if (diff > 38) revert InvalidDecimalsDifference(diff);

        uint256 raw = Math.mulDiv(amountFrom_, priceFromUSD, priceToUSD);

        if (scaleDown) {
            // Use Math.mulDiv for safe division to prevent overflow
            expectedOutputAmount = Math.mulDiv(raw, 1, 10 ** diff);
        } else {
            // Use Math.mulDiv for safe multiplication to prevent overflow
            expectedOutputAmount = Math.mulDiv(raw, 10 ** diff, 1);
        }
    }
}
