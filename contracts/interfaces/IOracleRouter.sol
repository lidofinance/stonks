// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

interface IOracleRouter {
    // Pricing reads
    function getUsdPrices(
        address baseTokenAddress_,
        address quoteTokenAddress_
    ) external view returns (uint256 baseUsdPrice, uint256 quoteUsdPrice);

    function getPricesAndDecimals(
        address baseTokenAddress_,
        address quoteTokenAddress_
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
    function setEthUsdBridge(uint32 maxStalenessSeconds_) external;

    function syncEthUsdBridge() external;

    function setTokenUsdFeed(
        address tokenAddress_,
        uint32 maxStalenessSeconds_,
        uint8 providedTokenDecimals_,
        bool isActive_
    ) external;

    function setTokenEthFeed(
        address tokenAddress_,
        uint32 maxStalenessSeconds_,
        uint8 providedTokenDecimals_,
        bool isActive_
    ) external;

    function setTokenEthUsdStalenessOverride(address tokenAddress_, uint32 overrideSeconds_) external;

    function setTokenActive(address tokenAddress_, bool isActive_) external;

    function isBridgeInSync() external view returns (bool);

    function isFeedInSync(address tokenAddress_) external view returns (bool);

    function syncTokenFeed(address tokenAddress_) external;
}
