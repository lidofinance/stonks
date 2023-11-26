// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {AmountConverter} from "../AmountConverter.sol";

contract AmountConverterFactory {
    address public immutable feedRegistry;

    error InvalidFeedRegistryAddress();

    event AmountConverterDeployed(
        address indexed amountConverterAddress,
        address feedRegistryAddress,
        address conversionTarget,
        address[] allowedTokensToSell,
        address[] allowedStableTokensToBuy
    );

    constructor(address feedRegistry_) {
        if (feedRegistry_ == address(0)) revert InvalidFeedRegistryAddress();
        feedRegistry = feedRegistry_;
    }

    function deployAmountConverter(
        address conversionTarget_,
        address[] memory allowedTokensToSell_,
        address[] memory allowedStableTokensToBuy_
    ) public returns (address tokenAmountConverter) {
        tokenAmountConverter = address(
            new AmountConverter(feedRegistry, conversionTarget_, allowedTokensToSell_, allowedStableTokensToBuy_)
        );
        emit AmountConverterDeployed(
            tokenAmountConverter, feedRegistry, conversionTarget_, allowedTokensToSell_, allowedStableTokensToBuy_
        );
    }
}
