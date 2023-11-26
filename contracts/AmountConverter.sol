// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IAmountConverter} from "./interfaces/IAmountConverter.sol";

interface IFeedRegistry {
    function getFeed(address base, address quote) external view returns (address aggregator);

    function latestRoundData(address base, address quote)
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

    function decimals(address base, address quote) external view returns (uint256);
}

/**
 * @title AmountConverter
 * @dev This contract provides functionalities to retrieve expected token conversion rates
 * based on the Chainlink Price Feed. It allows users to get the expected output amount of one token
 * in terms of another token, considering a specific margin. The contract assumes a relationship between
 * two tokens.
 *
 * The primary function `getExpectedOut` is the main point of interaction. It fetches the price of the
 * provided token to USD from the Chainlink Price Feed, adjusts for the desired
 * margin, and then calculates the expected amount of the output token based on the input amount of the
 * sellToken.
 */
contract AmountConverter is IAmountConverter {
    // Fiat currencies follow https://en.wikipedia.org/wiki/ISO_4217
    address public immutable conversionTarget;

    IFeedRegistry public immutable feedRegistry;

    mapping(address => bool) public allowedTokensToSell;
    mapping(address => bool) public allowedStableTokensToBuy;

    error InvalidAddress();
    error InvalidAmount();
    error NoPriceFeedFound();
    error TokenNotAllowed();
    error InvalidTokenPair();
    error UnexpectedPriceFeedAnswer();

    /// @param feedRegistry_ Chainlink Price Feed Registry
    /// @param conversionTarget_ Target currency we expect to be equal allowed tokens to buy
    /// @param allowedTokensToSell_ List of addresses which allowed to use as sell tokens
    /// @param allowedTokensToBuy_ List of addresses of stable tokens
    constructor(
        address feedRegistry_,
        address conversionTarget_,
        address[] memory allowedTokensToSell_,
        address[] memory allowedTokensToBuy_
    ) {
        if (feedRegistry_ == address(0)) revert InvalidAddress();
        if (conversionTarget_ == address(0)) revert InvalidAddress();

        feedRegistry = IFeedRegistry(feedRegistry_);
        conversionTarget = conversionTarget_;

        for (uint256 i = 0; i < allowedTokensToBuy_.length; ++i) {
            if (allowedTokensToBuy_[i] == address(0)) revert InvalidAddress();
            allowedStableTokensToBuy[allowedTokensToBuy_[i]] = true;
        }

        for (uint256 i = 0; i < allowedTokensToSell_.length; ++i) {
            if (allowedTokensToSell_[i] == address(0)) revert InvalidAddress();
            if (feedRegistry.getFeed(allowedTokensToSell_[i], conversionTarget) == address(0)) {
                revert NoPriceFeedFound();
            }
            allowedTokensToSell[allowedTokensToSell_[i]] = true;
        }
    }

    ///
    // @dev Returns the expected output amount after selling _tokenFrom to stable with margin
    ///
    function getExpectedOut(uint256 amount_, address sellToken_, address buyToken_)
        external
        view
        returns (uint256 expectedOutputAmount)
    {
        if (sellToken_ == buyToken_) revert InvalidTokenPair();
        if (allowedTokensToSell[sellToken_] == false) revert TokenNotAllowed();
        if (allowedStableTokensToBuy[buyToken_] == false) revert TokenNotAllowed();
        if (amount_ == 0) revert InvalidAmount();

        (uint256 currentPrice, uint256 feedDecimals) = _fetchPrice(sellToken_, conversionTarget);

        uint256 decimalsOfSellToken = IERC20Metadata(sellToken_).decimals();
        uint256 decimalsOfBuyToken = IERC20Metadata(buyToken_).decimals();

        int256 effectiveDecimalDifference = int256(decimalsOfSellToken + feedDecimals) - int256(decimalsOfBuyToken);

        if (effectiveDecimalDifference >= 0) {
            expectedOutputAmount = (amount_ * currentPrice) / 10 ** uint256(effectiveDecimalDifference);
        } else {
            expectedOutputAmount = (amount_ * currentPrice) * 10 ** uint256(-effectiveDecimalDifference);
        }
    }

    ///
    // @dev Internal function to get price from Chainlink Price Feed Registry.
    ///
    function _fetchPrice(address base, address quote) internal view returns (uint256, uint256) {
        (, int256 price,,,) = feedRegistry.latestRoundData(base, quote);
        if (price <= 0) revert UnexpectedPriceFeedAnswer();

        uint256 decimals = feedRegistry.decimals(base, quote);

        return (uint256(price), decimals);
    }
}
