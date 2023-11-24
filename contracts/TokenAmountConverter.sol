// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ITokenAmountConverter} from "./interfaces/ITokenAmountConverter.sol";

interface IFeedRegistry {
    function getFeed(address base, address quote) external view returns (address aggregator);

    function latestRoundData(address base, address quote)
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

    function decimals(address base, address quote) external view returns (uint256);
}

/**
 * @title TokenConverter
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
contract TokenAmountConverter is ITokenAmountConverter {
    // -------------
    // CONSTANTS
    // -------------

    // Fiat currencies follow https://en.wikipedia.org/wiki/ISO_4217
    address public constant USD = address(840);

    // -------------
    // STATE
    // -------------

    IFeedRegistry public immutable feedRegistry;

    mapping(address => bool) public allowedTokensToSell;
    mapping(address => bool) public allowedStableTokensToBuy;

    // -------------
    // CONSTRUCTOR
    // -------------

    /// @param _feedRegistry Chainlink Price Feed Registry
    /// @param _allowedTokensToSell List of addresses which allowed to use as sell tokens
    /// @param _allowedStableTokensToBuy List of addresses of stable tokens
    constructor(
        address _feedRegistry,
        address[] memory _allowedTokensToSell,
        address[] memory _allowedStableTokensToBuy
    ) {
        require(_feedRegistry != address(0), "TokenConverter: invalid feed registry address");
        feedRegistry = IFeedRegistry(_feedRegistry);

        for (uint256 i = 0; i < _allowedStableTokensToBuy.length; ++i) {
            require(_allowedStableTokensToBuy[i] != address(0), "TokenConverter: invalid address");

            allowedStableTokensToBuy[_allowedStableTokensToBuy[i]] = true;
        }

        for (uint256 i = 0; i < _allowedTokensToSell.length; ++i) {
            require(_allowedTokensToSell[i] != address(0), "TokenConverter: invalid address");

            require(
                feedRegistry.getFeed(_allowedTokensToSell[i], USD) != address(0), "TokenConverter: No price feed found"
            );

            allowedTokensToSell[_allowedTokensToSell[i]] = true;
        }
    }

    ///
    // @dev Returns the expected output amount after selling _tokenFrom to stable with margin
    ///
    function getExpectedOut(uint256 _amount, address _tokenFrom, address _tokenTo)
        external
        view
        returns (uint256 expectedOutputAmount)
    {
        require(_tokenFrom != _tokenTo, "TokenConverter: Input and output tokens cannot be the same");

        require(allowedTokensToSell[_tokenFrom] == true, "TokenConverter: Token is not allowed to sell");

        require(allowedStableTokensToBuy[_tokenTo] == true, "TokenConverter: Token is not allowed to buy");

        (uint256 currentPrice, uint256 feedDecimals) = _fetchPrice(_tokenFrom, USD);

        uint256 decimalsOfSellToken = IERC20Metadata(_tokenFrom).decimals();
        uint256 decimalsOfBuyToken = IERC20Metadata(_tokenTo).decimals();

        int256 grandDecimals = int256(decimalsOfSellToken + feedDecimals) - int256(decimalsOfBuyToken);

        expectedOutputAmount =
            ((_amount * currentPrice * (10 ** max(-grandDecimals, 0))) / (10 ** (max(grandDecimals, 0))));
    }

    ///
    // @dev Internal function to get price from Chainlink Price Feed Registry.
    ///
    function _fetchPrice(address base, address quote) internal view returns (uint256, uint256) {
        (, int256 price,,,) = feedRegistry.latestRoundData(base, quote);
        require(price > 0, "Unexpected price feed answer");

        uint256 decimals = feedRegistry.decimals(base, quote);

        return (uint256(price), decimals);
    }

    function max(int256 a, int256 b) internal pure returns (uint256) {
        return a >= b ? uint256(a) : uint256(b);
    }
}
