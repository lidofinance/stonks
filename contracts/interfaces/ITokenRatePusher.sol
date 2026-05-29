// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/**
 * @title ITokenRatePusher
 * @notice Callback interface implemented by observers registered on `TokenRateNotifier`.
 *         Invoked by the notifier after each Lido protocol rebase, carrying the full set of
 *         rebase parameters from `Lido.handlePostTokenRebase`. Observers consume only the
 *         fields relevant to their accounting; unused parameters are still part of the
 *         interface so future observers can be added without bumping the signature again.
 */
interface ITokenRatePusher {
    function pushTokenRate(
        uint256 reportTimestamp,
        uint256 timeElapsed,
        uint256 preTotalShares,
        uint256 preTotalEther,
        uint256 postTotalShares,
        uint256 postTotalEther,
        uint256 sharesMintedAsFees
    ) external;
}
