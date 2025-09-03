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
        address oracleRouter,
        address[] allowedTokensToSell,
        address[] allowedStableTokensToBuy
    );

    error InvalidFeedRegistryAddress(address feedRegistry);

    /**
     *
     * @param feedRegistry_ The address of the Chainlink Feed Registry (https://docs.chain.link/data-feeds/feed-registry)
     */
    constructor(address feedRegistry_) {
        if (feedRegistry_ == address(0)) revert InvalidFeedRegistryAddress(feedRegistry_);
        FEED_REGISTRY = feedRegistry_;
        emit FeedRegistrySet(feedRegistry_);
    }

    /**
     * @notice Deploys a new AmountConverter contract with specified parameters
     * @param oracleRouter_ The address of the OracleRouter contract
     * @param allowedTokensToSell_ Array of addresses of tokens allowed to be sold
     * @param allowedStableTokensToBuy_ Array of addresses of stable tokens allowed to be bought
     * @return tokenAmountConverter The address of the newly deployed AmountConverter contract
     */
    function deployAmountConverter(
        address oracleRouter_,
        address[] memory allowedTokensToSell_,
        address[] memory allowedStableTokensToBuy_
    ) public returns (address tokenAmountConverter) {
        tokenAmountConverter = address(
            new AmountConverter(FEED_REGISTRY, allowedTokensToSell_, allowedStableTokensToBuy_)
        );
        emit AmountConverterDeployed(
            tokenAmountConverter,
            oracleRouter_,
            allowedTokensToSell_,
            allowedStableTokensToBuy_
        );
    }
}
