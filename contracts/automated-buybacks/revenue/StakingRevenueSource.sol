// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {RevenueSource} from "./RevenueSource.sol";
import {ITokenRatePusher} from "../../interfaces/ITokenRatePusher.sol";
import {IOracleRouter} from "../../interfaces/IOracleRouter.sol";
import {IStETH} from "../../interfaces/IStETH.sol";
import {IWstETH} from "../../interfaces/IWstETH.sol";
import {IStakingRouter} from "../../interfaces/IStakingRouter.sol";

/**
 * @title StakingRevenueSource
 * @notice Revenue source that back-derives DAO treasury staking revenue from the stETH/wstETH rate
 *         delta reported by `TokenRateNotifier` after each Lido rebase. External (vault) shares are
 *         excluded — vault revenue is tracked by a dedicated source. The derived stETH amount is
 *         converted to USD via `OracleRouter` and forwarded to the base class for daily-rate
 *         normalization.
 * @dev    Must be registered as an observer on `TokenRateNotifier`; `REPORTER_ROLE` is granted to
 *         the notifier at construction so `pushTokenRate` is restricted to the canonical rebase
 *         callback path. ERC165 support for `ITokenRatePusher.interfaceId` is required for
 *         registration.
 */
contract StakingRevenueSource is RevenueSource, ITokenRatePusher {
    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Role that authorizes `pushTokenRate`. Granted solely to the `TokenRateNotifier`
    ///         address at construction to block out-of-order calls between rebases.
    bytes32 public constant REPORTER_ROLE = keccak256("REPORTER_ROLE");

    /// @notice Scale factor for stETH/wstETH rate arithmetic, matching Lido's
    ///         `TokenRateAndUpdateTimestampProvider` convention.
    uint256 internal constant TOKEN_RATE_SCALE = 1e27;

    /// @notice Scale factor for USD amount precision alignment with `OracleRouter` output.
    uint256 internal constant PRICE_SCALE = 1e18;

    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice `OracleRouter` used for stETH → USD conversion on positive rate deltas.
    IOracleRouter public immutable ORACLE_ROUTER;

    /// @notice stETH token — queried for internal/external share counts and as both base and quote
    ///         of the USD price lookup.
    IStETH public immutable STETH;

    /// @notice wstETH token — queried for the current `stETH-per-wstETH` rate at `TOKEN_RATE_SCALE`.
    IWstETH public immutable WSTETH;

    /// @notice Lido `StakingRouter` — queried at call time for the treasury fee share of gross
    ///         staking rewards.
    IStakingRouter public immutable STAKING_ROUTER;

    /*//////////////////////////////////////////////////////////////
                           STORAGE VARIABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice Rate snapshot from the previous `pushTokenRate` call, scaled to `TOKEN_RATE_SCALE`.
    ///         Advances only on positive deltas; frozen on zero/negative deltas so the pre-event
    ///         rate remains the high-water-mark baseline across slashing and recovery.
    uint256 private _lastStEthPerToken;

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error InvalidOracleRouterAddress(address oracleRouter);
    error InvalidStEthAddress(address stEth);
    error InvalidWstEthAddress(address wstEth);
    error InvalidStakingRouterAddress(address stakingRouter);
    error InvalidTokenRateNotifierAddress(address tokenRateNotifier);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Wires the external dependencies, seeds the rate baseline from live wstETH, and grants
     *         `REPORTER_ROLE` to `tokenRateNotifier_` so the notifier can drive the source.
     * @dev    Seeding against the live rate guarantees that the first `pushTokenRate` computes a
     *         genuine delta rather than the full cumulative staking rate since wstETH deployment.
     */
    constructor(
        address admin_,
        uint256 stalenessWindowSeconds_,
        address oracleRouter_,
        address stEth_,
        address wstEth_,
        address stakingRouter_,
        address tokenRateNotifier_
    ) RevenueSource(admin_, stalenessWindowSeconds_) {
        if (oracleRouter_ == address(0)) {
            revert InvalidOracleRouterAddress(oracleRouter_);
        }
        if (stEth_ == address(0)) {
            revert InvalidStEthAddress(stEth_);
        }
        if (wstEth_ == address(0)) {
            revert InvalidWstEthAddress(wstEth_);
        }
        if (stakingRouter_ == address(0)) {
            revert InvalidStakingRouterAddress(stakingRouter_);
        }
        if (tokenRateNotifier_ == address(0)) {
            revert InvalidTokenRateNotifierAddress(tokenRateNotifier_);
        }

        ORACLE_ROUTER = IOracleRouter(oracleRouter_);
        STETH = IStETH(stEth_);
        WSTETH = IWstETH(wstEth_);
        STAKING_ROUTER = IStakingRouter(stakingRouter_);

        _lastStEthPerToken = IWstETH(wstEth_).getStETHByWstETH(TOKEN_RATE_SCALE);

        _grantRole(REPORTER_ROLE, tokenRateNotifier_);
    }

    /*//////////////////////////////////////////////////////////////
                           EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice `ITokenRatePusher` callback invoked by `TokenRateNotifier` after each rebase. Derives
     *         the DAO's share of gross staking rewards from the rate delta, converts to USD, and
     *         forwards to `_updateRevenue` for daily-rate normalization.
     * @dev    The notifier wraps this call in try/catch, so reverts here are non-blocking and
     *         surface as `PushTokenRateFailed` on the notifier. Zero- and negative-delta reports
     *         still fire `_updateRevenue(0, block.timestamp)` to reset the staleness timer and
     *         propagate the cost burden to the controller. Negative deltas intentionally preserve
     *         the pre-event baseline so the deficit accumulates across the full recovery period.
     */
    function pushTokenRate() external onlyRole(REPORTER_ROLE) whenNotPaused {
        uint256 rate = WSTETH.getStETHByWstETH(TOKEN_RATE_SCALE);
        uint256 lastRate = _lastStEthPerToken;

        if (rate <= lastRate) {
            _updateRevenue(0, block.timestamp);
            return;
        }

        uint256 rateDelta = rate - lastRate;

        (uint256 modulesFee, uint256 treasuryFee, uint256 basePrecision) = STAKING_ROUTER
            .getStakingFeeAggregateDistribution();
        uint256 internalShares = STETH.getTotalShares() - STETH.getExternalShares();

        // Back-derives the treasury's share of gross staking rewards from the rate delta, which
        // already has fees extracted via share dilution. `internalShares` is post-rebase — fee
        // shares are already minted by the time this fires, producing a negligible overestimation.
        // Reverts with a division-by-zero panic if `totalFee >= basePrecision`, which is the
        // intended fail-safe for a malformed `StakingRouter` configuration.
        uint256 revenueStEth = (rateDelta * internalShares * treasuryFee) /
            (TOKEN_RATE_SCALE * (basePrecision - (modulesFee + treasuryFee)));

        (uint256 stEthUsdPrice, ) = ORACLE_ROUTER.getUsdPrices(address(STETH), address(STETH));
        uint256 revenueUSD = (revenueStEth * stEthUsdPrice) / PRICE_SCALE;

        _lastStEthPerToken = rate;

        _updateRevenue(revenueUSD, block.timestamp);
    }

    /*//////////////////////////////////////////////////////////////
                            PUBLIC FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice ERC165 entry point. `TokenRateNotifier.addObserver` queries this during registration.
    function supportsInterface(
        bytes4 interfaceId_
    ) public view override returns (bool) {
        return
            interfaceId_ == type(ITokenRatePusher).interfaceId ||
            super.supportsInterface(interfaceId_);
    }
}
