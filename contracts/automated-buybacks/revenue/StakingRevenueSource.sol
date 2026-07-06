// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {RevenueSource} from "./RevenueSource.sol";
import {ITokenRatePusherWithArgs} from "../../interfaces/ITokenRatePusherWithArgs.sol";
import {IOracleRouter} from "../../interfaces/IOracleRouter.sol";
import {ILidoLocator} from "../../interfaces/ILidoLocator.sol";
import {IStETH} from "../../interfaces/IStETH.sol";
import {IStakingRouter} from "../../interfaces/IStakingRouter.sol";

/**
 * @title StakingRevenueSource
 * @author swissarmytowel <info@lido.fi>
 * @notice Captures DAO treasury staking revenue from each fee-minting Lido rebase in two stages.
 *         The rebase callback path (`pushTokenRate`) is oracle-free: it slices `sharesMintedAsFees`
 *         by the treasury portion of the current fee split, converts shares to stETH at the
 *         post-rebase rate, and accumulates the result in a pending stETH bucket. A separate
 *         permissionless `convertPendingRevenueToUSD` call settles the bucket into the
 *         cumulative USD accumulator using `OracleRouter`. Decoupling keeps the rebase critical
 *         path free of Chainlink dependencies and turns oracle outages into deferred, retryable
 *         conversions rather than lost revenue.
 * @dev    Rebases that mint no fees (`sharesMintedAsFees == 0`, or a zero fee split) are skipped.
 * @dev    Must be registered as an observer on the `TokenRateNotifier` referenced by
 *         `LidoLocator.postTokenRebaseReceiver`. ERC165 support for
 *         `ITokenRatePusherWithArgs.interfaceId` is required so `TokenRateNotifier.addObserver`
 *         auto-detects the args-bearing flavor.
 * @dev    Register on the `BuybackAllocator` and wire as a notifier observer in one atomic
 *         governance action, with the pending bucket settled first. The allocator baselines the
 *         cumulative at registration, so pending stETH settled later shows up as fresh surplus.
 */
contract StakingRevenueSource is RevenueSource, ITokenRatePusherWithArgs {
    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice `OracleRouter` used for stETH → USD conversion in
    ///         `convertPendingRevenueToUSD`. Not touched on the rebase callback path.
    IOracleRouter public immutable ORACLE_ROUTER;

    /// @notice Price unit reported by `OracleRouter`.
    uint256 public immutable PRICE_UNIT;

    /// @notice `LidoLocator` instance.
    ILidoLocator public immutable LIDO_LOCATOR;

    /*//////////////////////////////////////////////////////////////
                           STORAGE VARIABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice Treasury stETH accrued from rebases since the last successful conversion, awaiting
    ///         USD conversion. Grows on every non-trivial `pushTokenRate`; cleared by
    ///         `convertPendingRevenueToUSD`.
    uint256 public pendingRevenueStEth;

    /// @notice Highest rebase report timestamp accepted by `pushTokenRate`. Rebase report
    ///         timestamps are strictly increasing, so this acts as a dedupe / replay guard: a
    ///         callback whose timestamp is not greater than this value is ignored.
    uint256 public lastReportTimestamp;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event RevenueAccumulatedInStEth(uint256 stEthAmount, uint256 pendingRevenueStEth);
    event PendingRevenueConverted(
        uint256 stEthConverted,
        uint256 stEthUsdPrice,
        uint256 revenueUSD
    );

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
        PRICE_UNIT = IOracleRouter(oracleRouter_).PRICE_UNIT();
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
     *         3rd-party-oracle-free: USD conversion is deferred to `convertPendingRevenueToUSD`, so an
     *         oracle outage cannot cause a rebase-time revert and cannot lose revenue — the
     *         stETH owed to the DAO sits in the pending bucket until any caller settles it.
     *
     *         The signature mirrors the rebase payload forwarded from `Accounting.handleOracleReport`
     *         so the notifier can forward it to all observers uniformly. This source consumes
     *         `reportTimestamp_` (dedupe guard) and `sharesMintedAsFees_`; the remaining
     *         parameters are accepted but ignored.
     * @param  reportTimestamp_ Timestamp of the oracle report behind this rebase. Strictly
     *         increasing across rebases; a callback whose timestamp does not exceed the last
     *         accepted one is treated as a replay and skipped.
     * @param  sharesMintedAsFees_ Total fee shares minted by the protocol on this rebase, as
     *         passed through `TokenRateNotifier` from `Accounting.handleOracleReport`. Zero on
     *         rebases where no fees were minted (e.g. negative CL delta offset by EL rewards
     *         that lift the rate but produce no protocol fees).
     */
    function pushTokenRate(
        uint256 reportTimestamp_,
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

        // Dedupe / replay guard: rebase report timestamps strictly increase, so a callback that
        // does not advance the watermark is a repeat or stale delivery and is skipped.
        if (reportTimestamp_ <= lastReportTimestamp) {
            return;
        }

        lastReportTimestamp = reportTimestamp_;

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
        // `Accounting.handleOracleReport` after the rebase has been applied, so the rate already
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

        pendingRevenueStEth = 0;

        address stEth = LIDO_LOCATOR.lido();
        (uint256 stEthUsdPrice, ) = ORACLE_ROUTER.getUsdPrices(stEth, stEth);

        if (stEthUsdPrice == 0) {
            revert OracleReturnedZeroPrice();
        }

        uint256 revenueUSD = (pending * stEthUsdPrice) / PRICE_UNIT;

        _addRevenueUSD(revenueUSD);

        emit PendingRevenueConverted(pending, stEthUsdPrice, revenueUSD);
    }

    /**
     * @notice ERC165 entry point. Queried by `TokenRateNotifier.addObserver` during
     *         registration to detect the args-bearing observer flavor.
     * @param  interfaceId_ Interface identifier to probe.
     * @return `true` for `ITokenRatePusherWithArgs`, plus `IRevenueSource` and `IERC165` via the
     *         base `RevenueSource`.
     * @dev    `IRevenueSource` / `IERC165` advertisement is inherited from `RevenueSource`, so
     *         consumers like `BuybackAllocator` accept this source via their ERC165 check.
     */
    function supportsInterface(bytes4 interfaceId_) public view override returns (bool) {
        return
            interfaceId_ == type(ITokenRatePusherWithArgs).interfaceId ||
            super.supportsInterface(interfaceId_);
    }
}
