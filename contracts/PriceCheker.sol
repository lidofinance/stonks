// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import "./interfaces/IChainlinkPriceFeedV3.sol";
import "./interfaces/IPriceChecker.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title PriceChecker
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
contract PriceChecker is IPriceChecker {
    IChainlinkPriceFeedV3 public chainlinkPriceFeed;

    uint16 private constant MAX_BASIS_POINTS = 10_000;
    uint16 public immutable marginBasisPoints;

    address public immutable tokenA;
    address public immutable tokenB;

    constructor(address priceFeed_, address tokenA_, address tokenB_, uint16 marginBasisPoints_) {
        require(tokenA_ != address(0), "PriceChecker: invalid tokenA_ address");
        require(tokenB_ != address(0), "PriceChecker: invalid tokenB_ address");
        require(tokenA_ != tokenB_, "PriceChecker: tokenA_ and tokenB_ cannot be the same");
        require(priceFeed_ != address(0), "PriceChecker: invalid price feed address");

        chainlinkPriceFeed = IChainlinkPriceFeedV3(priceFeed_);
        marginBasisPoints = marginBasisPoints_;
        tokenA = tokenA_;
        tokenB = tokenB_;
    }

    /**
     * @dev Returns the expected output amount for the given input parameters.
     */
    function getExpectedOut(uint256 inputAmount, address inputToken, address outputToken)
        external
        view
        returns (uint256)
    {
        return _getExpectedOutFromChainlink(inputAmount, inputToken, outputToken);
    }

    /**
     * @dev Internal function to calculate expected output amount using Chainlink Price Feed.
     */
    function _getExpectedOutFromChainlink(
        uint256 amountToSell,
        address sellToken,
        address buyToken
    ) internal view returns (uint256 expectedOutputAmount) {
        require(sellToken != buyToken, "PriceChecker: Input and output tokens cannot be the same");
        require(
            (sellToken == tokenA || sellToken == tokenB) && (buyToken == tokenA || buyToken == tokenB),
            "PriceChecker: Invalid tokens"
        );

        bool isInverted = (sellToken != tokenA);
        uint256 currentPrice = _fetchPrice(isInverted);

        uint8 decimalsOfSellToken = IERC20Metadata(sellToken).decimals();
        uint8 decimalsOfBuyToken = IERC20Metadata(buyToken).decimals();

        expectedOutputAmount = (
            (amountToSell * currentPrice * (MAX_BASIS_POINTS - marginBasisPoints)) / MAX_BASIS_POINTS
        ) / (10 ** (18 + decimalsOfSellToken - decimalsOfBuyToken));
    }

    /**
     * @dev Internal function to get price from Chainlink Price Feed, optionally inverted.
     */
    function _fetchPrice(bool inverted) internal view returns (uint256) {
        uint256 decimals = chainlinkPriceFeed.decimals();

        (, int256 price,,,) = chainlinkPriceFeed.latestRoundData();
        require(price > 0, "Unexpected price feed answer");

        if (inverted) {
            return (10 ** (decimals * 2)) / uint256(price) * (10 ** (18 - decimals));
        }

        return uint256(price) * (10 ** (18 - decimals));
    }
}
