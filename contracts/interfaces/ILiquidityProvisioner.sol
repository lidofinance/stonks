// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/**
 * @title ILiquidityProvisioner
 * @notice External surface of the LiquidityProvisioner consumed by the NESTController, keepers,
 *         and operators. Liquidity-side calls (`addLiquidity`, `removeLiquidityAndRecoverToTreasury`)
 *         are intentionally omitted.
 */
interface ILiquidityProvisioner {
    /// @notice Snapshot mirroring the `placeOrder` preconditions.
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

    function setOperatingMode(bool lpModeEnabled_, address stonks_) external;

    function placeOrder() external returns (address newOrder);

    function pauseStonksCreation() external;

    function unpauseStonksCreation() external;

    function pauseStonksSignatures() external;

    function unpauseStonksSignatures() external;

    function getPlacementStatus() external view returns (PlacementStatus memory);
}
