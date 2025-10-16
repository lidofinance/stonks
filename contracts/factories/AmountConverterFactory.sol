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
    address public immutable ORACLE_ROUTER;

    event FeedRegistrySet(address feedRegistry);
    event AmountConverterDeployed(
        address indexed amountConverterAddress,
        address oracleRouter,
        address[] allowedTokensToSell,
        address[] allowedStableTokensToBuy
    );

    error InvalidFeedRegistryAddress(address feedRegistry);
    error InvalidOracleRouterAddress(address oracleRouter);

    /**
     *
     * @param feedRegistry_ The address of the Chainlink Feed Registry (https://docs.chain.link/data-feeds/feed-registry)
     * @param oracleRouter_ The address of the OracleRouter contract
     */
    constructor(address feedRegistry_, address oracleRouter_) {
        if (feedRegistry_ == address(0)) revert InvalidFeedRegistryAddress(feedRegistry_);
        if (oracleRouter_ == address(0)) revert InvalidOracleRouterAddress(oracleRouter_);
        FEED_REGISTRY = feedRegistry_;
        ORACLE_ROUTER = oracleRouter_;
        emit FeedRegistrySet(feedRegistry_);
    }

    /**
     * @notice Deploys a new AmountConverter contract with specified parameters
     * @param allowedTokensToSell_ Array of addresses of tokens allowed to be sold
     * @param allowedStableTokensToBuy_ Array of addresses of stable tokens allowed to be bought
     * @return tokenAmountConverter The address of the newly deployed AmountConverter contract
     */
    function deployAmountConverter(
        address[] memory allowedTokensToSell_,
        address[] memory allowedStableTokensToBuy_
    ) public returns (address tokenAmountConverter) {
        tokenAmountConverter = address(
            new AmountConverter(ORACLE_ROUTER, allowedTokensToSell_, allowedStableTokensToBuy_)
        );
        emit AmountConverterDeployed(
            tokenAmountConverter,
            ORACLE_ROUTER,
            allowedTokensToSell_,
            allowedStableTokensToBuy_
        );
    }
}
