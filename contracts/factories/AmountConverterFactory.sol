// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {AmountConverter} from "../AmountConverter.sol";

/**
 * @title AmountConverterFactory
 * @notice Deploys new instances of the AmountConverter contract.
 */

contract AmountConverterFactory {
    address public immutable FEED_REGISTRY;

    event FeedRegistrySet(address feedRegistry);
    event AmountConverterDeployed(
        address indexed amountConverterAddress,
        address feedRegistryAddress,
        address conversionTarget,
        address[] allowedTokensToSell,
        address[] allowedStableTokensToBuy,
        uint256[] priceFeedsHeartbeatTimeouts
    );

    error InvalidFeedRegistryAddress();

    /**
     *
     * @param feedRegistry_ The address of the Chainlink Feed Registry (https://docs.chain.link/data-feeds/feed-registry)
     */
    constructor(address feedRegistry_) {
        if (feedRegistry_ == address(0)) revert InvalidFeedRegistryAddress();
        FEED_REGISTRY = feedRegistry_;
        emit FeedRegistrySet(feedRegistry_);
    }

    /**
     * @notice Deploys a new AmountConverter contract with specified parameters
     * @param conversionTarget_ The target currency for conversions
     * @param allowedTokensToSell_ Array of addresses of tokens allowed to be sold
     * @param allowedStableTokensToBuy_ Array of addresses of stable tokens allowed to be bought
     * @param priceFeedsHeartbeatTimeouts_ Array of timeouts for the price feeds
     * @return tokenAmountConverter The address of the newly deployed AmountConverter contract
     */
    function deployAmountConverter(
        address conversionTarget_,
        address[] memory allowedTokensToSell_,
        address[] memory allowedStableTokensToBuy_,
        uint256[] memory priceFeedsHeartbeatTimeouts_
    ) public returns (address tokenAmountConverter) {
        tokenAmountConverter = address(
            new AmountConverter(
                FEED_REGISTRY,
                conversionTarget_,
                allowedTokensToSell_,
                allowedStableTokensToBuy_,
                priceFeedsHeartbeatTimeouts_
            )
        );
        emit AmountConverterDeployed(
            tokenAmountConverter,
            FEED_REGISTRY,
            conversionTarget_,
            allowedTokensToSell_,
            allowedStableTokensToBuy_,
            priceFeedsHeartbeatTimeouts_
        );
    }
}
