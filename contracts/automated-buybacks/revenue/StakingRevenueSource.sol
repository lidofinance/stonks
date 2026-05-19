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
 * @author swissarmytowel <info@lido.fi>
 * @notice Revenue source that back-derives DAO treasury staking revenue from the stETH/wstETH
 *         rate delta reported by `TokenRateNotifier` after each Lido rebase. Vault shares are
 *         excluded. The derived stETH is converted to USD via `OracleRouter` and forwarded to
 *         the base class for daily-rate normalization.
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
    bytes32 public constant REPORTER_ROLE = keccak256("REPORTER_ROLE");

    /// @notice Scale factor for stETH/wstETH rate arithmetic, matching Lido's
    ///         `TokenRateAndUpdateTimestampProvider` convention.
    uint256 internal constant TOKEN_RATE_SCALE = 1e27;

    /// @notice USD amount precision alignment with `OracleRouter` output.
    uint256 internal constant PRICE_SCALE = 1e18;

    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice `OracleRouter` used for stETH → USD conversion on positive rate deltas.
    IOracleRouter public immutable ORACLE_ROUTER;

    /// @notice stETH token. Queried for internal/external share counts and as both base and quote
    ///         of the USD price lookup.
    IStETH public immutable STETH;

    /// @notice wstETH token. Queried for the current `stETH-per-wstETH` rate at `TOKEN_RATE_SCALE`.
    IWstETH public immutable WSTETH;

    /// @notice Lido `StakingRouter`. Queried at call time for the treasury fee share of gross
    ///         staking rewards.
    IStakingRouter public immutable STAKING_ROUTER;

    /*//////////////////////////////////////////////////////////////
                           STORAGE VARIABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice Rate snapshot from the previous `pushTokenRate` call, scaled to `TOKEN_RATE_SCALE`.
    ///         Advances only on positive deltas. Frozen on zero or negative deltas so the pre-event
    ///         rate remains the high-water-mark baseline across slashing and recovery.
    uint256 private _lastStEthPerToken;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event BaselineReset(uint256 oldRate, uint256 newRate);

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
     * @notice Wires external dependencies, seeds the rate baseline from the live wstETH rate, and
     *         grants `REPORTER_ROLE` to `tokenRateNotifier_`.
     * @dev    Seeding against the live rate ensures the first `pushTokenRate` measures a genuine
     *         delta rather than the cumulative staking rate since wstETH deployment.
     * @param  admin_ Initial admin. Non-zero. Forwarded to `RevenueSource`.
     * @param  stalenessWindowSeconds_ Strictly positive. Forwarded to `RevenueSource`.
     * @param  oracleRouter_ `OracleRouter` for stETH → USD conversion. Non-zero.
     * @param  stEth_ stETH token. Non-zero.
     * @param  wstEth_ wstETH token. Non-zero.
     * @param  stakingRouter_ Lido `StakingRouter` for fee distribution lookups. Non-zero.
     * @param  tokenRateNotifier_ Authorized caller of `pushTokenRate`. Non-zero. Granted
     *         `REPORTER_ROLE`.
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
     * @notice `ITokenRatePusher` callback invoked by `TokenRateNotifier` after each rebase.
     *         Derives the DAO's share of gross staking rewards from the rate delta, converts to
     *         USD, and forwards to `_updateRevenue`.
     * @dev    The notifier wraps this call in try/catch, so reverts here are non-blocking and
     *         surface as `PushTokenRateFailed` on the notifier. Zero- and negative-delta reports
     *         fire `_updateRevenue(0, block.timestamp)` to refresh the staleness timer. Negative
     *         deltas preserve the pre-event baseline so the deficit accumulates across the full
     *         recovery period. A non-slashing rate drop is cleared with `resetBaseline`.
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

        // Back-derives the treasury share of gross rewards from a post-fee rate delta. A
        // malformed `StakingRouter` where `totalFee >= basePrecision` divbyzero-panics here.
        uint256 revenueStEth = (rateDelta * internalShares * treasuryFee) /
            (TOKEN_RATE_SCALE * (basePrecision - (modulesFee + treasuryFee)));

        (uint256 stEthUsdPrice, ) = ORACLE_ROUTER.getUsdPrices(address(STETH), address(STETH));
        uint256 revenueUSD = (revenueStEth * stEthUsdPrice) / PRICE_SCALE;

        _lastStEthPerToken = rate;

        _updateRevenue(revenueUSD, block.timestamp);
    }

    /**
     * @notice Re-seeds the rate baseline to the live wstETH rate.
     * @dev    Use after a confirmed non-slashing rate drop. Forfeits the underwater window's
     *         rewards. After genuine slashing the frozen baseline must be kept instead.
     */
    function resetBaseline() external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 oldRate = _lastStEthPerToken;
        uint256 newRate = WSTETH.getStETHByWstETH(TOKEN_RATE_SCALE);

        _lastStEthPerToken = newRate;

        emit BaselineReset(oldRate, newRate);
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
