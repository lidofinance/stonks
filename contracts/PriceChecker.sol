// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {IPriceChecker} from "./interfaces/IPriceChecker.sol";

interface IFeedRegistry {
    function getFeed(address base, address quote)
        external
        view
        returns (address aggregator);

    function latestRoundData(address base, address quote)
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );

    function decimals(address base, address quote)
        external
        view
        returns (uint256);
}

/**
 * @title StablePriceChecker
 * @dev This contract provides functionalities to retrieve expected token conversion rates
 * based on the Chainlink Price Feed. It allows users to get the expected output amount of one token
 * in terms of another token, considering a specific margin. The contract assumes a relationship between
 * two tokens defined at deployment, specifically `firstToken` and `secondToken`.
 *
 * The primary function `getExpectedOut` is the main point of interaction. It fetches the price of the
 * provided tokens (inputToken and outputToken) from the Chainlink Price Feed, adjusts for the desired
 * margin, and then calculates the expected amount of the output token based on the input amount of the
 * sellToken.
 *
 * Note: This contract assumes that token prices can be inverted (e.g., if it knows the price of A in terms
 * of B, it can calculate the price of B in terms of A).
 */
contract StablePriceChecker is IPriceChecker {
    // -------------
    // CONSTANTS
    // -------------
    // Fiat currencies follow https://en.wikipedia.org/wiki/ISO_4217
    address public constant USD = address(840);
    uint256 private constant MAX_BASIS_POINTS = 10_000;

    // -------------
    // STATE
    // -------------

    uint256 public immutable marginBP;
    IFeedRegistry public immutable feedRegistry;

    mapping(address => bool) public allowedTokensToSell;
    mapping(address => bool) public allowedStableTokensToBuy;

    // -------------
    // CONSTRUCTOR
    // -------------

    /// @param _feedRegistry Chainlink Price Feed Registry
    /// @param _allowedTokensToSell List of addresses which allowed to use as sell tokens
    /// @param _allowedStableTokensToBuy List of addresses of stable tokens
    /// @param _marginBP margin
    constructor(
        address _feedRegistry,
        address[] memory _allowedTokensToSell,
        address[] memory _allowedStableTokensToBuy,
        uint256 _marginBP
    ) {
        require(
            _feedRegistry != address(0),
            "PriceChecker: invalid feed registry address"
        );
        feedRegistry = IFeedRegistry(_feedRegistry);

        for (uint256 i = 0; i < _allowedStableTokensToBuy.length; ++i) {
            require(
                _allowedStableTokensToBuy[i] != address(0),
                "PriceChecker: invalid address"
            );

            allowedStableTokensToBuy[_allowedStableTokensToBuy[i]] = true;
        }

        for (uint256 i = 0; i < _allowedTokensToSell.length; ++i) {
            require(
                _allowedTokensToSell[i] != address(0),
                "PriceChecker: invalid address"
            );

            require(
                feedRegistry.getFeed(_allowedTokensToSell[i], USD) !=
                    address(0),
                "PriceChecker: No price feed found"
            );

            allowedTokensToSell[_allowedTokensToSell[i]] = true;
        }

        marginBP = _marginBP;
    }

    /**
     * @dev Returns the expected output amount for the given input parameters.
     */
    function getExpectedOut(
        uint256 _amount,
        address _tokenFrom,
        address _tokenTo
    ) external view returns (uint256 expectedOutputAmount) {
        require(
            _tokenFrom != _tokenTo,
            "PriceChecker: Input and output tokens cannot be the same"
        );

        require(
            allowedTokensToSell[_tokenFrom] == true,
            "PriceChecker: Token is not allowed to sell"
        );

        require(
            allowedStableTokensToBuy[_tokenTo] == true,
            "PriceChecker: Token is not allowed to buy"
        );

        (uint256 currentPrice, uint256 feedDecimals) = _fetchPrice(
            _tokenFrom,
            USD
        );

        uint8 decimalsOfSellToken = IERC20Metadata(_tokenFrom).decimals();
        uint8 decimalsOfBuyToken = IERC20Metadata(_tokenTo).decimals();

        expectedOutputAmount = ((_amount *
            currentPrice *
            (MAX_BASIS_POINTS - marginBP)) /
            MAX_BASIS_POINTS /
            (10**(decimalsOfSellToken + decimalsOfBuyToken - feedDecimals)));
    }

    /**
     * @dev Internal function to get price from Chainlink Price Feed Registry.
     */
    function _fetchPrice(address base, address quote)
        internal
        view
        returns (uint256, uint256)
    {
        (, int256 price, , , ) = feedRegistry.latestRoundData(base, quote);
        require(price > 0, "Unexpected price feed answer");

        uint256 decimals = feedRegistry.decimals(base, quote);

        return (uint256(price), decimals);
    }
}
