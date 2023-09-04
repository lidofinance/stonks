// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import "./interfaces/IChainlinkPriceFeedV3.sol";
import "./interfaces/IPriceChecker.sol";

contract PriceChecker is IPriceChecker {
    IChainlinkPriceFeedV3 public priceFeed;

    constructor(address priceFeed_) {
        priceFeed = IChainlinkPriceFeedV3(priceFeed_);
    }

    function getExpectedOut(uint256 amount_, address sellToken_, address buyToken_) external view returns (uint256) {
        return getExpectedOutFromChainlink(amount_, sellToken_, buyToken_);
    }

    function getExpectedOutFromChainlink(uint256 amount_, address tokenFrom_, address tokenTo_)
        internal
        view
        returns (uint256)
    {
        uint256 decimals = priceFeed.decimals();

        (, int256 price,, uint256 updatedAt,) = priceFeed.latestRoundData();
        require(updatedAt != 0, "Unexpected price feed answer");

        return uint256(price) * (10 ** (18 - decimals));
    }
}
