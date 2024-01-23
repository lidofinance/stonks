// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IAmountConverter} from "./interfaces/IAmountConverter.sol";
import {IFeedRegistry} from "./interfaces/IFeedRegistry.sol";

/**
 * @title AmountConverter
 * @dev This contract provides functionality for converting the amount
 *      of Token A into the amount of Token B based on the Chainlink price feed.
 */
contract AmountConverter is IAmountConverter {
    // Conversion targets: https://github.com/smartcontractkit/chainlink/blob/develop/contracts/src/v0.8/Denominations.sol
    address public immutable CONVERSION_TARGET;

    IFeedRegistry public immutable FEED_REGISTRY;

    mapping(address tokenToSell => bool allowed) public allowedTokensToSell;
    mapping(address tokenToBuy => bool allowed) public allowedTokensToBuy;
    mapping(address priceFeedAddress => uint256 priceFeedTimeout) public priceFeedsHeartbeatTimeouts;

    error InvalidFeedRegistryAddress(address feedRegistryAddress);
    error InvalidConversionTargetAddress(address conversionTargetAddress);
    error InvalidAllowedTokenToBuy(address allowedTokenToBuy);
    error InvalidAllowedTokenToSell(address allowedTokenToSell);
    error InvalidAmount(uint256 amount);
    error InvalidHeartbeatArrayLength();
    error InvalidTokensToSellArrayLength();
    error InvalidTokensToBuyArrayLength();
    error NoPriceFeedFound(address tokenFrom, address tokenTo);
    error SellTokenNotAllowed(address tokenFrom);
    error BuyTokenNotAllowed(address tokenTo);
    error SameTokensConversion();
    error UnexpectedPriceFeedAnswer();
    error InvalidExpectedOutAmount(uint256 amount);
    error PriceFeedNotUpdated(uint256 updatedAt);

    event AllowedTokenToSellAdded(address tokenAddress);
    event AllowedTokenToBuyAdded(address tokenAddress);
    event PriceFeedHeartbeatTimeoutSet(address tokenAddress, uint256 timeout);

    /**
     * @param feedRegistry_ Chainlink Price Feed Registry
     * @param conversionTarget_ Target currency we expect to be equal to allowed tokens to buy
     * @param allowedTokensToSell_ List of addresses which allowed to use as sell tokens
     * @param allowedTokensToBuy_ List of addresses of tokens that we expect to be equal to conversionTarget
     * @param priceFeedsHeartbeatTimeouts_ List of timeouts for price feeds (should be in sync by index with allowedTokensToSell_)
     */
    constructor(
        address feedRegistry_,
        address conversionTarget_,
        address[] memory allowedTokensToSell_,
        address[] memory allowedTokensToBuy_,
        uint256[] memory priceFeedsHeartbeatTimeouts_
    ) {
        if (feedRegistry_ == address(0)) revert InvalidFeedRegistryAddress(feedRegistry_);
        if (conversionTarget_ == address(0)) revert InvalidConversionTargetAddress(conversionTarget_);
        if (allowedTokensToSell_.length == 0) revert InvalidTokensToSellArrayLength();
        if (allowedTokensToBuy_.length == 0) revert InvalidTokensToBuyArrayLength();
        if (allowedTokensToSell_.length != priceFeedsHeartbeatTimeouts_.length) revert InvalidHeartbeatArrayLength();

        FEED_REGISTRY = IFeedRegistry(feedRegistry_);
        CONVERSION_TARGET = conversionTarget_;

        for (uint256 i = 0; i < allowedTokensToBuy_.length; ++i) {
            if (allowedTokensToBuy_[i] == address(0)) revert InvalidAllowedTokenToBuy(allowedTokensToBuy_[i]);
            allowedTokensToBuy[allowedTokensToBuy_[i]] = true;
            emit AllowedTokenToBuyAdded(allowedTokensToBuy_[i]);
        }

        for (uint256 i = 0; i < allowedTokensToSell_.length; ++i) {
            if (allowedTokensToSell_[i] == address(0)) revert InvalidAllowedTokenToSell(allowedTokensToSell_[i]);
            FEED_REGISTRY.getFeed(allowedTokensToSell_[i], conversionTarget_);
            allowedTokensToSell[allowedTokensToSell_[i]] = true;
            priceFeedsHeartbeatTimeouts[allowedTokensToSell_[i]] = priceFeedsHeartbeatTimeouts_[i];

            emit AllowedTokenToSellAdded(allowedTokensToSell_[i]);
            emit PriceFeedHeartbeatTimeoutSet(allowedTokensToSell_[i], priceFeedsHeartbeatTimeouts_[i]);
        }
    }

    /**
     * @notice Calculates the expected amount of `tokenTo_` that one would receive for a given amount of `tokenFrom_`.
     * @dev Uses the Chainlink Price Feed to get the current price relation of `tokenFrom_` to `CONVERSION_TARGET`
     *      whose price is expected to be equal or close to equal to the `tokenFrom_`.
     *
     * @param tokenFrom_ The address of the token being sold.
     * @param tokenTo_ The address of the token being bought.
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
        if (amountFrom_ == 0) revert InvalidAmount(amountFrom_);

        (uint256 currentPrice, uint256 feedDecimals) = _fetchPriceAndDecimals(tokenFrom_, CONVERSION_TARGET);

        uint256 decimalsOfSellToken = IERC20Metadata(tokenFrom_).decimals();
        uint256 decimalsOfBuyToken = IERC20Metadata(tokenTo_).decimals();

        int256 effectiveDecimalDifference = int256(decimalsOfSellToken + feedDecimals) - int256(decimalsOfBuyToken);

        if (effectiveDecimalDifference >= 0) {
            expectedOutputAmount = (amountFrom_ * currentPrice) / 10 ** uint256(effectiveDecimalDifference);
        } else {
            expectedOutputAmount = (amountFrom_ * currentPrice) * 10 ** uint256(-effectiveDecimalDifference);
        }

        if (expectedOutputAmount == 0) revert InvalidExpectedOutAmount(expectedOutputAmount);
    }

    /**
     * @dev Internal function to get price relation of `tokenFrom_` to `tokenTo_` from Chainlink Price Feed Registry.
     */
    function _fetchPriceAndDecimals(address base_, address quote_)
        internal
        view
        returns (uint256 price, uint256 decimals)
    {
        (, int256 intPrice,, uint256 updatedAt,) = FEED_REGISTRY.latestRoundData(base_, quote_);
        if (intPrice <= 0) revert UnexpectedPriceFeedAnswer();
        if (block.timestamp > updatedAt + priceFeedsHeartbeatTimeouts[base_]) revert PriceFeedNotUpdated(updatedAt);

        price = uint256(intPrice);
        decimals = FEED_REGISTRY.decimals(base_, quote_);
    }
}
