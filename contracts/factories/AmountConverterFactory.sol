// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {AmountConverter} from "../AmountConverter.sol";

/**
 * @title AmountConverterFactory
 * @notice Deploys new instances of the AmountConverter contract with predefined configuration.
 */
contract AmountConverterFactory {
    // ==================== Immutables ====================

    /// @notice Address of the OracleRouter contract.
    address public immutable ORACLE_ROUTER;

    // ==================== Events ====================

    event AmountConverterDeployed(
        address indexed amountConverterAddress,
        address oracleRouter,
        address[] allowedTokensToSell,
        address[] allowedStableTokensToBuy
    );

    // ==================== Errors ====================

    error InvalidOracleRouterAddress(address oracleRouter);

    // ==================== Constructor ====================

    /**
     * @param oracleRouter_ The address of the OracleRouter contract
     */
    constructor(address oracleRouter_) {
        if (oracleRouter_ == address(0)) {
            revert InvalidOracleRouterAddress(oracleRouter_);
        }
        ORACLE_ROUTER = oracleRouter_;
    }

    // ==================== External Functions ====================

    /**
     * @notice Deploys a new AmountConverter contract with specified parameters
     * @param allowedTokensToSell_ Array of addresses of tokens allowed to be sold
     * @param allowedStableTokensToBuy_ Array of addresses of tokens allowed to be bought
     * @return tokenAmountConverter The address of the newly deployed AmountConverter contract
     */
    function deployAmountConverter(
        address[] memory allowedTokensToSell_,
        address[] memory allowedStableTokensToBuy_
    ) external returns (address tokenAmountConverter) {
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
