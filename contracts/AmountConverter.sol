// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IAmountConverter} from "./interfaces/IAmountConverter.sol";
import {IFeedRegistry} from "./interfaces/IFeedRegistry.sol";

/**
 * @title AmountConverter
 * @dev This contract provides functionalities to retrieve expected token conversion rates
 * based on the Chainlink Price Feed. It allows users to get the expected output amount of one token
 * in terms of another token, considering a specific margin. The contract assumes a relationship between
 * two tokens.
 *
 * The primary function `getExpectedOut` is the main point of interaction. It fetches the price of the
 * provided token to `CONVERSION_TARGET` currency (so far USD is a primary conversion target) from the
 * Chainlink Price Feed and calculates the expected amount of the output token based on the input amount of the sellToken.
 */
contract AmountConverter is IAmountConverter {
    // Conversion targets: https://github.com/smartcontractkit/chainlink/blob/develop/contracts/src/v0.8/Denominations.sol
    address public immutable CONVERSION_TARGET;

    IFeedRegistry public immutable FEED_REGISTRY;

    mapping(address => bool) public allowedTokensToSell;
    mapping(address => bool) public allowedTokensToBuy;
    mapping(address => uint256) public priceFeedsHeartbeatTimeouts;

    error ZeroAddress();
    error ZeroAmount();
    error InvalidHeartbeatArrayLength();
    error NoPriceFeedFound(address tokenFrom, address tokenTo);
    error SellTokenNotAllowed(address tokenFrom);
    error BuyTokenNotAllowed(address tokenTo);
    error SameTokensConversion();
    error UnexpectedPriceFeedAnswer();
    error PriceFeedNotUpdated();

    /// @param feedRegistry_ Chainlink Price Feed Registry
    /// @param conversionTarget_ Target currency we expect to be equal to allowed tokens to buy
    /// @param allowedTokensToSell_ List of addresses which allowed to use as sell tokens
    /// @param allowedTokensToBuy_ List of addresses of tokens that we expect to be equal to conversionTarget
    /// @param priceFeedsHeartbeatTimeouts_ List of timeouts for price feeds (should be in sync by index with allowedTokensToSell_)
    constructor(
        address feedRegistry_,
        address conversionTarget_,
        address[] memory allowedTokensToSell_,
        address[] memory allowedTokensToBuy_,
        uint256[] memory priceFeedsHeartbeatTimeouts_
    ) {
        if (feedRegistry_ == address(0)) revert ZeroAddress();
        if (conversionTarget_ == address(0)) revert ZeroAddress();
        if (allowedTokensToSell_.length != priceFeedsHeartbeatTimeouts_.length) revert InvalidHeartbeatArrayLength();

        FEED_REGISTRY = IFeedRegistry(feedRegistry_);
        CONVERSION_TARGET = conversionTarget_;

        for (uint256 i = 0; i < allowedTokensToBuy_.length; ++i) {
            if (allowedTokensToBuy_[i] == address(0)) revert ZeroAddress();
            allowedTokensToBuy[allowedTokensToBuy_[i]] = true;
        }

        for (uint256 i = 0; i < allowedTokensToSell_.length; ++i) {
            if (allowedTokensToSell_[i] == address(0)) revert ZeroAddress();
            FEED_REGISTRY.getFeed(allowedTokensToSell_[i], CONVERSION_TARGET);
            allowedTokensToSell[allowedTokensToSell_[i]] = true;
            priceFeedsHeartbeatTimeouts[allowedTokensToSell_[i]] = priceFeedsHeartbeatTimeouts_[i];
        }
    }

    /**
     * @notice Calculates the expected amount of `tokenTo_` that one would receive for a given amount of `tokenFrom_`.
     * @dev This function computes the expected output amount of `tokenTo_` when selling `tokenFrom_`.
     *      It uses the Chainlink Price Feed to get the current price of `tokenFrom_` in terms of the `CONVERSION_TARGET`
     *      (usually USD). The function then adjusts this price based on the token decimals and returns the expected
     *      amount of `tokenTo_` one would receive for the specified `amountFrom_` of `tokenFrom_`.
     *      This function assumes that `tokenTo_` is equivalent in value to the `CONVERSION_TARGET`.
     *
     * @param tokenFrom_ The address of the token being sold.
     * @param tokenTo_ The address of the token being bought, expected to be equivalent to the `CONVERSION_TARGET`.
     * @param amountFrom_ The amount of `tokenFrom_` that is being sold.
     * @return expectedOutputAmount The expected amount of `tokenTo_` that will be received.
     */
    function getExpectedOut(address tokenFrom_, address tokenTo_, uint256 amountFrom_)
        external
        view
        returns (uint256 expectedOutputAmount)
    {
        if (tokenFrom_ == tokenTo_) revert SameTokensConversion();
        if (allowedTokensToSell[tokenFrom_] == false) revert SellTokenNotAllowed(tokenFrom_);
        if (allowedTokensToBuy[tokenTo_] == false) revert BuyTokenNotAllowed(tokenTo_);
        if (amountFrom_ == 0) revert ZeroAmount();

        (uint256 currentPrice, uint256 feedDecimals) = _fetchPrice(tokenFrom_, CONVERSION_TARGET);

        uint256 decimalsOfSellToken = IERC20Metadata(tokenFrom_).decimals();
        uint256 decimalsOfBuyToken = IERC20Metadata(tokenTo_).decimals();

        int256 effectiveDecimalDifference = int256(decimalsOfSellToken + feedDecimals) - int256(decimalsOfBuyToken);

        if (effectiveDecimalDifference >= 0) {
            expectedOutputAmount = (amountFrom_ * currentPrice) / 10 ** uint256(effectiveDecimalDifference);
        } else {
            expectedOutputAmount = (amountFrom_ * currentPrice) * 10 ** uint256(-effectiveDecimalDifference);
        }

        if (expectedOutputAmount == 0) revert UnexpectedPriceFeedAnswer();
    }

    ///
    // @dev Internal function to get price from Chainlink Price Feed Registry.
    ///
    function _fetchPrice(address base_, address quote_) internal view returns (uint256, uint256) {
        (, int256 price,, uint256 updatedAt,) = FEED_REGISTRY.latestRoundData(base_, quote_);
        if (price <= 0) revert UnexpectedPriceFeedAnswer();
        if (block.timestamp > updatedAt + priceFeedsHeartbeatTimeouts[base_]) revert PriceFeedNotUpdated();

        uint256 decimals = FEED_REGISTRY.decimals(base_, quote_);

        return (uint256(price), decimals);
    }
}
