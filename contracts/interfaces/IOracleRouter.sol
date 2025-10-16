// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

interface IOracleRouter {
    function getUsdPrices(
        address baseToken_,
        address quoteToken_
    ) external view returns (uint256 baseUsdPrice_, uint256 quoteUsdPrice_);

    function getTokenDecimals(
        address baseToken_,
        address quoteToken_
    ) external view returns (uint8 baseTokenDecimals_, uint8 quoteTokenDecimals_);

    function getPricesAndDecimals(
        address baseToken_,
        address quoteToken_
    ) external view returns (
        uint256 baseUsdPrice_,
        uint256 quoteUsdPrice_,
        uint8 baseTokenDecimals_,
        uint8 quoteTokenDecimals_
    );
}
