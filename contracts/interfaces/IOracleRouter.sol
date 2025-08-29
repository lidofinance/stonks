// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

interface IOracleRouter {
    function getUsdPrice(address token_) external view returns (uint256);

    function tokenDecimalsOf(address token_) external view returns (uint8);

    function getUsdPrices(
        address baseToken_,
        address quoteToken_
    ) external view returns (uint256 baseUsdPrice_, uint256 quoteUsdPrice_);

    function getTokenDecimals(
        address baseToken_,
        address quoteToken_
    ) external view returns (uint8 baseTokenDecimals_, uint8 quoteTokenDecimals_);
}
