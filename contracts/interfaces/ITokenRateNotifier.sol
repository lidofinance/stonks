// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.23;

/// @notice Public surface of Lido core's `TokenRateNotifier`, mirrored here so tests bind to a
///         typed contract.
/// @dev    Only the externally observable members are declared. `StakingRevenueSource` registers
///         here as a `WithArgs` observer and is invoked through `handlePostTokenRebase`.
interface ITokenRateNotifier {
    /// @notice Observer notification flavor. `NoArgs` -> `ITokenRatePusher.pushTokenRate()`,
    ///         `WithArgs` -> `ITokenRatePusherWithArgs.pushTokenRate(...)`.
    enum ObserverKind {
        NoArgs,
        WithArgs
    }

    event PushTokenRateFailed(address indexed observer, bytes lowLevelRevertData);
    event ObserverAdded(address indexed observer);
    event ObserverRemoved(address indexed observer);

    error ErrorTokenRateNotifierRevertedWithNoData();
    error ErrorZeroAddressObserver();
    error ErrorBadObserverInterface();
    error ErrorMaxObserversCountExceeded();
    error ErrorNoObserverToRemove();
    error ErrorZeroAddressOwner();
    error ErrorZeroAddressTokenRateProvider();
    error ErrorNotAuthorizedRebaseCaller();
    error ErrorAddExistedObserver();

    /// @notice Owner (the DAO Agent) that can add/remove observers.
    function owner() external view returns (address);

    /// @notice Accounting contract authorized to call `handlePostTokenRebase`.
    function TOKEN_RATE_PROVIDER() external view returns (address);

    /// @notice Upper bound on the number of registered observers.
    function MAX_OBSERVERS_COUNT() external view returns (uint256);

    /// @notice Registered observers. An address appears at most once; order is not stable.
    function observers(uint256 index) external view returns (address observer, ObserverKind kind);

    /// @notice Number of registered observers.
    function observersLength() external view returns (uint256);

    /// @notice Registers an observer under `kind_`, validating its ERC165 support for the matching
    ///         pusher interface. Owner-only.
    function addObserver(address observer_, ObserverKind kind_) external;

    /// @notice Removes a previously registered observer by address. Owner-only.
    function removeObserver(address observer_) external;

    /// @notice Rebase callback. Fans the payload out to every observer; observer reverts are
    ///         isolated and surfaced as `PushTokenRateFailed`. `TOKEN_RATE_PROVIDER`-only.
    function handlePostTokenRebase(
        uint256 _reportTimestamp,
        uint256 _timeElapsed,
        uint256 _preTotalShares,
        uint256 _preTotalEther,
        uint256 _postTotalShares,
        uint256 _postTotalEther,
        uint256 _sharesMintedAsFees
    ) external;
}
