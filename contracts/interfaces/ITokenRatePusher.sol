// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.23;

/// @author kovalgek
/// @notice An interface for entity that pushes token rate.
/// @dev No-arg flavor. Observers that need the full per-rebase payload (timestamps,
///      shares, ether, sharesMintedAsFees) should implement `ITokenRatePusherWithArgs` instead.
interface ITokenRatePusher {
    /// @notice Pushes token rate to L2 by depositing zero token amount.
    function pushTokenRate() external;
}
