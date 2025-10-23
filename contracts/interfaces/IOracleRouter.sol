// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

interface IOracleRouter {
    // Pricing reads
    function getUsdPrices(
        address baseTokenAddress,
        address quoteTokenAddress
    ) external view returns (uint256 baseUsdPrice, uint256 quoteUsdPrice);

    function getTokenDecimals(
        address baseTokenAddress,
        address quoteTokenAddress
    ) external view returns (uint8 baseTokenDecimals, uint8 quoteTokenDecimals);

    function getPricesAndDecimals(
        address baseTokenAddress,
        address quoteTokenAddress
    )
        external
        view
        returns (
            uint256 baseUsdPrice,
            uint256 quoteUsdPrice,
            uint8 baseTokenDecimals,
            uint8 quoteTokenDecimals
        );

    // Configuration (admin/manager)
    function setEthUsdBridge(uint32 maxStalenessSeconds) external;

    function syncEthUsdBridge() external;

    function setTokenUsdFeed(
        address tokenAddress,
        uint32 maxStalenessSeconds,
        uint8 providedTokenDecimals,
        bool isActive
    ) external;

    function setTokenEthFeed(
        address tokenAddress,
        uint32 maxStalenessSeconds,
        uint8 providedTokenDecimals,
        bool isActive
    ) external;

    function setTokenEthUsdStalenessOverride(address tokenAddress, uint32 overrideSeconds) external;

    function setTokenActive(address tokenAddress, bool isActive) external;

    function isBridgeInSync() external view returns (bool);

    function isFeedInSync(address tokenAddress) external view returns (bool);

    function syncTokenFeed(address tokenAddress) external;
}
