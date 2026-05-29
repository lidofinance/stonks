// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {RevenueSource} from "./RevenueSource.sol";
import {ITokenRatePusher} from "../../interfaces/ITokenRatePusher.sol";
import {IOracleRouter} from "../../interfaces/IOracleRouter.sol";
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
 *         cumulative USD accumulator using `OracleRouter`. This decoupling keeps the rebase
 *         critical path free of Chainlink dependencies and turns oracle outages into deferred,
 *         retryable conversions rather than lost revenue.
 * @dev    Must be registered as an observer on `TokenRateNotifier`. `REPORTER_ROLE` is granted
 *         to the notifier at construction so `pushTokenRate` is restricted to the rebase
 *         callback path. ERC165 support for `ITokenRatePusher.interfaceId` is required for
 *         registration.
 */
contract StakingRevenueSource is RevenueSource, ITokenRatePusher {
    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Role authorizing `pushTokenRate`. Granted at construction to the
    ///         `TokenRateNotifier` only, blocking out-of-order calls between rebases.
    bytes32 public constant REPORTER_ROLE = keccak256("NEST.StakingRevenueSource.REPORTER_ROLE");

    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice `OracleRouter` used for stETH → USD conversion in
    ///         `convertPendingRevenueToUSD`. Not touched on the rebase callback path.
    IOracleRouter public immutable ORACLE_ROUTER;

    /// @notice Price unit used by `OracleRouter`.
    uint256 public immutable PRICE_SCALE;

    /// @notice stETH token. Queried for share-to-stETH conversion at the post-rebase rate.
    IStETH public immutable STETH;

    /// @notice Lido `StakingRouter`. Queried at call time for the modules/treasury fee split
    ///         used to slice `sharesMintedAsFees`.
    IStakingRouter public immutable STAKING_ROUTER;

    /*//////////////////////////////////////////////////////////////
                           STORAGE VARIABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice Treasury stETH accrued from rebases since the last successful conversion.
    ///         Grows on every non-trivial `pushTokenRate`; cleared by
    ///         `convertPendingRevenueToUSD`.
    uint256 private _pendingRevenueStEth;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event RevenueAccumulatedInStEth(uint256 stEthAmount, uint256 pendingRevenueStEth);
    event PendingRevenueConverted(uint256 stEthConverted, uint256 stEthUsdPrice, uint256 revenueUSD);

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error InvalidOracleRouterAddress(address oracleRouter);
    error InvalidStEthAddress(address stEth);
    error InvalidStakingRouterAddress(address stakingRouter);
    error InvalidTokenRateNotifierAddress(address tokenRateNotifier);
    error OracleReturnedZeroPrice();

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Wires external dependencies and grants `REPORTER_ROLE` to `tokenRateNotifier_`.
     * @param  admin_ Initial admin. Non-zero. Forwarded to `RevenueSource`.
     * @param  oracleRouter_ `OracleRouter` for stETH → USD conversion. Non-zero.
     * @param  stEth_ stETH token. Non-zero.
     * @param  stakingRouter_ Lido `StakingRouter` for fee distribution lookups. Non-zero.
     * @param  tokenRateNotifier_ Authorized caller of `pushTokenRate`. Non-zero. Granted
     *         `REPORTER_ROLE`.
     */
    constructor(
        address admin_,
        address oracleRouter_,
        address stEth_,
        address stakingRouter_,
        address tokenRateNotifier_
    ) RevenueSource(admin_) {
        if (oracleRouter_ == address(0)) {
            revert InvalidOracleRouterAddress(oracleRouter_);
        }
        if (stEth_ == address(0)) {
            revert InvalidStEthAddress(stEth_);
        }
        if (stakingRouter_ == address(0)) {
            revert InvalidStakingRouterAddress(stakingRouter_);
        }
        if (tokenRateNotifier_ == address(0)) {
            revert InvalidTokenRateNotifierAddress(tokenRateNotifier_);
        }

        ORACLE_ROUTER = IOracleRouter(oracleRouter_);
        PRICE_SCALE = IOracleRouter(oracleRouter_).PRICE_UNIT();
        STETH = IStETH(stEth_);
        STAKING_ROUTER = IStakingRouter(stakingRouter_);

        _grantRole(REPORTER_ROLE, tokenRateNotifier_);
    }

    /*//////////////////////////////////////////////////////////////
                           EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice `ITokenRatePusher` callback invoked by `TokenRateNotifier` after each rebase.
     *         Slices the total minted fee shares by the treasury's share of the fee split,
     *         converts to stETH at the post-rebase rate, and queues the amount for later USD
     *         conversion. Does not touch the `OracleRouter`.
     * @dev    The notifier wraps this call in try/catch, so reverts here are non-blocking and
     *         surface as `PushTokenRateFailed` on the notifier. The rebase critical path is
     *         intentionally oracle-free: USD conversion is deferred to
     *         `convertPendingRevenueToUSD`, so an oracle outage cannot cause a rebase-time
     *         revert and cannot lose revenue — the stETH owed to the DAO sits in the pending
     *         bucket until any caller settles it.
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
    ) external onlyRole(REPORTER_ROLE) {
        if (sharesMintedAsFees_ == 0) {
            return;
        }

        (uint256 modulesFee, uint256 treasuryFee, ) = STAKING_ROUTER
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
        uint256 treasuryStEth = STETH.getPooledEthByShares(treasuryShares);

        uint256 newPending = _pendingRevenueStEth + treasuryStEth;
        _pendingRevenueStEth = newPending;
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
     *         settlement cycle. A no-op (return) when the bucket is empty so cheap polling does
     *         not waste caller gas with reverts.
     */
    function convertPendingRevenueToUSD() external {
        uint256 pending = _pendingRevenueStEth;
        if (pending == 0) {
            return;
        }

        (uint256 stEthUsdPrice, ) = ORACLE_ROUTER.getUsdPrices(address(STETH), address(STETH));
        if (stEthUsdPrice == 0) {
            revert OracleReturnedZeroPrice();
        }

        uint256 revenueUSD = (pending * stEthUsdPrice) / PRICE_SCALE;

        _pendingRevenueStEth = 0;
        _addRevenueUSD(revenueUSD);
        emit PendingRevenueConverted(pending, stEthUsdPrice, revenueUSD);
    }

    /*//////////////////////////////////////////////////////////////
                        EXTERNAL VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Pending stETH awaiting USD conversion.
     */
    function getPendingRevenueStEth() external view returns (uint256) {
        return _pendingRevenueStEth;
    }

    /*//////////////////////////////////////////////////////////////
                            PUBLIC FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice ERC165 entry point. Queried by `TokenRateNotifier.addObserver` during registration.
     * @param  interfaceId_ Interface identifier to probe.
     * @return `true` for `ITokenRatePusher` and any interface accepted by the inheritance chain.
     */
    function supportsInterface(bytes4 interfaceId_) public view override returns (bool) {
        return
            interfaceId_ == type(ITokenRatePusher).interfaceId ||
            super.supportsInterface(interfaceId_);
    }
}
