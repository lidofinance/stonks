// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/**
 * @title ITokenRatePusher
 * @notice Callback interface implemented by observers registered on `TokenRateNotifier`.
 *         Invoked by the notifier after each Lido protocol rebase, carrying the exact number
 *         of fee shares minted during that rebase so observers can compute revenue without
 *         re-deriving the rate delta.
 */
interface ITokenRatePusher {
    function pushTokenRate(uint256 sharesMintedAsFees) external;
}
