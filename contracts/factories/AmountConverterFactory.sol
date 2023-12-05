// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {AmountConverter} from "../AmountConverter.sol";

contract AmountConverterFactory {
    address public immutable feedRegistry;

    error ZeroAddress();

    event AmountConverterDeployed(
        address indexed amountConverterAddress,
        address feedRegistryAddress,
        address conversionTarget,
        address[] allowedTokensToSell,
        address[] allowedStableTokensToBuy,
        uint256[] priceFeedsHeartbeatTimeouts
    );

    constructor(address feedRegistry_) {
        if (feedRegistry_ == address(0)) revert ZeroAddress();
        feedRegistry = feedRegistry_;
    }

    function deployAmountConverter(
        address conversionTarget_,
        address[] memory allowedTokensToSell_,
        address[] memory allowedStableTokensToBuy_,
        uint256[] memory priceFeedsHeartbeatTimeouts_
    ) public returns (address tokenAmountConverter) {
        tokenAmountConverter = address(
            new AmountConverter(
                feedRegistry,
                conversionTarget_,
                allowedTokensToSell_,
                allowedStableTokensToBuy_,
                priceFeedsHeartbeatTimeouts_
            )
        );
        emit AmountConverterDeployed(
            tokenAmountConverter,
            feedRegistry,
            conversionTarget_,
            allowedTokensToSell_,
            allowedStableTokensToBuy_,
            priceFeedsHeartbeatTimeouts_
        );
    }
}
