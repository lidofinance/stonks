// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {RevenueSource} from "./RevenueSource.sol";
import {ITokenRatePusherWithArgs} from "../../interfaces/ITokenRatePusherWithArgs.sol";
import {IOracleRouter} from "../../interfaces/IOracleRouter.sol";
import {ILidoLocator} from "../../interfaces/ILidoLocator.sol";
import {IStETH} from "../../interfaces/IStETH.sol";
import {IStakingRouter} from "../../interfaces/IStakingRouter.sol";

/**
 * @title StakingRevenueSource
 * @author swissarmytowel <info@lido.fi>
 * @notice Captures DAO treasury staking revenue from each Lido rebase in two stages. The rebase
 *         callback path (`pushTokenRate`) is oracle-free: it slices `sharesMintedAsFees` by the
 *         treasury portion of the current fee split, converts shares to stETH at the
 *         post-rebase rate, and accumulates the result in a pending stETH bucket. A separate
 *         permissionless `convertPendingRevenueToUSD` call settles the bucket into the
 *         cumulative USD accumulator using `OracleRouter`. Decoupling keeps the rebase critical
 *         path free of Chainlink dependencies and turns oracle outages into deferred, retryable
 *         conversions rather than lost revenue.
 * @dev    Must be registered as an observer on the `TokenRateNotifier` referenced by
 *         `LidoLocator.postTokenRebaseReceiver`.
 *         ERC165 support for `ITokenRatePusherWithArgs.interfaceId` is required so
 *         `TokenRateNotifier.addObserver` auto-detects the args-bearing flavor.
 */
contract StakingRevenueSource is RevenueSource, ITokenRatePusherWithArgs, IERC165 {
    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice `OracleRouter` used for stETH → USD conversion in
    ///         `convertPendingRevenueToUSD`. Not touched on the rebase callback path.
    IOracleRouter public immutable ORACLE_ROUTER;

    /// @notice Price unit reported by `OracleRouter`.
    uint256 public immutable PRICE_SCALE;

    /// @notice `LidoLocator` instance.
    ILidoLocator public immutable LIDO_LOCATOR;

    /*//////////////////////////////////////////////////////////////
                           STORAGE VARIABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice Treasury stETH accrued from rebases since the last successful conversion, awaiting
    ///         USD conversion. Grows on every non-trivial `pushTokenRate`; cleared by
    ///         `convertPendingRevenueToUSD`.
    uint256 public pendingRevenueStEth;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event RevenueAccumulatedInStEth(uint256 stEthAmount, uint256 pendingRevenueStEth);
    event PendingRevenueConverted(uint256 stEthConverted, uint256 stEthUsdPrice, uint256 revenueUSD);

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error InvalidOracleRouterAddress(address oracleRouter);
    error InvalidLidoLocatorAddress(address lidoLocator);
    error UnauthorizedCaller(address caller);
    error OracleReturnedZeroPrice();

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Wires external dependencies. Only `OracleRouter` and `LidoLocator` references are
     *         stored on this contract; all Lido infrastructure addresses (`lido`,
     *         `stakingRouter`, `postTokenRebaseReceiver`) are resolved live from the locator on
     *         each call so locator upgrades are transparently auto-followed.
     * @param  oracleRouter_ `OracleRouter` for stETH → USD conversion. Non-zero.
     * @param  lidoLocator_  `LidoLocator` for resolving Lido infrastructure. Non-zero.
     */
    constructor(address oracleRouter_, address lidoLocator_) {
        if (oracleRouter_ == address(0)) {
            revert InvalidOracleRouterAddress(oracleRouter_);
        }
        if (lidoLocator_ == address(0)) {
            revert InvalidLidoLocatorAddress(lidoLocator_);
        }

        ORACLE_ROUTER = IOracleRouter(oracleRouter_);
        PRICE_SCALE = IOracleRouter(oracleRouter_).PRICE_UNIT();
        LIDO_LOCATOR = ILidoLocator(lidoLocator_);
    }

    /*//////////////////////////////////////////////////////////////
                           EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice `ITokenRatePusherWithArgs` callback invoked by `TokenRateNotifier` after each
     *         rebase. Slices the total minted fee shares by the treasury's share of the fee
     *         split, converts to stETH at the post-rebase rate, and queues the amount for
     *         later USD conversion. Does not touch the `OracleRouter`.
     * @dev    Authorization is checked live against `LIDO_LOCATOR.postTokenRebaseReceiver()` so
     *         a locator upgrade that retargets the receiver is auto-followed. The notifier
     *         wraps this call in try/catch, so reverts here are non-blocking and surface as
     *         `PushTokenRateFailed` on the notifier. The rebase critical path is intentionally
     *         oracle-free: USD conversion is deferred to `convertPendingRevenueToUSD`, so an
     *         oracle outage cannot cause a rebase-time revert and cannot lose revenue — the
     *         stETH owed to the DAO sits in the pending bucket until any caller settles it.
     *
     *         The signature mirrors `Lido.handlePostTokenRebase` so the notifier can forward
     *         the full rebase payload to all observers uniformly. This source only consumes
     *         `sharesMintedAsFees_`; the remaining parameters are accepted but ignored.
     * @param  sharesMintedAsFees_ Total fee shares minted by the protocol on this rebase, as
     *         passed through `TokenRateNotifier` from `Lido.handlePostTokenRebase`. Zero on
     *         rebases where no fees were minted (e.g. negative CL delta offset by EL rewards
     *         that lift the rate but produce no protocol fees).
     */
    function pushTokenRate(
        uint256 /* reportTimestamp_ */,
        uint256 /* timeElapsed_ */,
        uint256 /* preTotalShares_ */,
        uint256 /* preTotalEther_ */,
        uint256 /* postTotalShares_ */,
        uint256 /* postTotalEther_ */,
        uint256 sharesMintedAsFees_
    ) external {
        if (msg.sender != LIDO_LOCATOR.postTokenRebaseReceiver()) {
            revert UnauthorizedCaller(msg.sender);
        }

        if (sharesMintedAsFees_ == 0) {
            return;
        }

        (uint256 modulesFee, uint256 treasuryFee, ) = IStakingRouter(LIDO_LOCATOR.stakingRouter())
            .getStakingFeeAggregateDistribution();

        // Treasury's slice of the total fee mint. `modulesFee + treasuryFee` is the full fee
        // pool; if it is zero, no allocation can be made and the call exits without recording
        // revenue. This branch is defensive — the protocol does not mint fees at all in that
        // configuration, so `sharesMintedAsFees_` would already be zero in practice.
        uint256 totalFee = modulesFee + treasuryFee;
        if (totalFee == 0) {
            return;
        }
        uint256 treasuryShares = (sharesMintedAsFees_ * treasuryFee) / totalFee;

        // Shares → stETH at the post-rebase rate. `pushTokenRate` fires inside
        // `handlePostTokenRebase` after the rebase has been applied, so the rate already
        // reflects the new period.
        uint256 treasuryStEth = IStETH(LIDO_LOCATOR.lido()).getPooledEthByShares(treasuryShares);

        uint256 newPending = pendingRevenueStEth + treasuryStEth;
        pendingRevenueStEth = newPending;
        emit RevenueAccumulatedInStEth(treasuryStEth, newPending);
    }

    /**
     * @notice Converts the pending stETH revenue bucket to USD and appends to the cumulative
     *         accumulator. Permissionless: any caller can settle the bucket once the oracle is
     *         healthy.
     * @dev    Reverts naturally if the `OracleRouter` reverts (caller retries when feeds
     *         recover) or if the router returns a zero price (treated as a degraded read; the
     *         bucket is preserved for retry). On success the pending bucket is cleared
     *         atomically with the cumulative write, so the conversion is single-shot per
     *         settlement cycle. A no-op (return) when the bucket is empty so cheap polling
     *         does not waste caller gas with reverts.
     */
    function convertPendingRevenueToUSD() external {
        uint256 pending = pendingRevenueStEth;
        if (pending == 0) {
            return;
        }

        address stEth = LIDO_LOCATOR.lido();
        (uint256 stEthUsdPrice, ) = ORACLE_ROUTER.getUsdPrices(stEth, stEth);
        if (stEthUsdPrice == 0) {
            revert OracleReturnedZeroPrice();
        }

        uint256 revenueUSD = (pending * stEthUsdPrice) / PRICE_SCALE;

        pendingRevenueStEth = 0;
        _addRevenueUSD(revenueUSD);
        emit PendingRevenueConverted(pending, stEthUsdPrice, revenueUSD);
    }

    /**
     * @notice ERC165 entry point. Queried by `TokenRateNotifier.addObserver` during
     *         registration to detect the args-bearing observer flavor.
     * @param  interfaceId_ Interface identifier to probe.
     * @return `true` for `ITokenRatePusherWithArgs` and `IERC165`.
     */
    function supportsInterface(bytes4 interfaceId_) external pure returns (bool) {
        return
            interfaceId_ == type(ITokenRatePusherWithArgs).interfaceId ||
            interfaceId_ == type(IERC165).interfaceId;
    }
}
