// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/**
 * @title IBuybackExecutor
 * @notice External surface of the BuybackExecutor consumed by the BuybackAllocator, keepers,
 *         and operators. Liquidity-side calls (`addLiquidity`, `removeLiquidityAndRecoverToTreasury`)
 *         are intentionally omitted.
 */
interface IBuybackExecutor {
    /// @notice `getPlacementStatus` return, containing placement preconditions and the next sell sizing.
    struct PlacementStatus {
        bool canPlace;
        uint256 sellAmount;
        uint256 estimatedBuyAmount;
        address activeOrder;
        uint256 activeOrderValidTo;
        bool isStonksCreationPaused;
        bool isStonksKilled;
    }

    function onStEthAllocated() external;

    function setStonksAndOperatingMode(address stonks_) external;

    function placeOrder() external returns (address newOrder);

    function pauseStonksCreation() external;

    function unpauseStonksCreation() external;

    function pauseStonksSignatures() external;

    function unpauseStonksSignatures() external;

    function getPlacementStatus() external view returns (PlacementStatus memory);
}
