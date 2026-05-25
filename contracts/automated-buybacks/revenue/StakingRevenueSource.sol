// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
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
 * @notice Revenue source that back-derives DAO treasury staking revenue from the stETH share
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
    bytes32 public constant REPORTER_ROLE = keccak256("NEST.StakingRevenueSource.REPORTER_ROLE");

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

    /// @notice Rate snapshot scaled to `TOKEN_RATE_SCALE`. Zero until `seedBaseline` is called.
    ///         After seeding, advances on every report; negative rebases lower the baseline so
    ///         subsequent recovery is recognized against the new low rather than absorbed into a
    ///         frozen high-water-mark.
    uint256 private _lastStEthPerToken;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event BaselineSeeded(uint256 rate);
    event BaselineReset(uint256 oldRate, uint256 newRate);
    event OracleLookupFailed(bytes lowLevelRevertData);

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error InvalidOracleRouterAddress(address oracleRouter);
    error InvalidStEthAddress(address stEth);
    error InvalidWstEthAddress(address wstEth);
    error InvalidStakingRouterAddress(address stakingRouter);
    error InvalidTokenRateNotifierAddress(address tokenRateNotifier);
    error BaselineAlreadySeeded();
    error BaselineNotSeeded();
    error OracleLookupOutOfGas();

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Wires external dependencies and grants `REPORTER_ROLE` to `tokenRateNotifier_`.
     * @dev    `pushTokenRate` reverts with `BaselineNotSeeded` until `seedBaseline` is called.
     * @param  admin_ Initial admin. Non-zero. Forwarded to `RevenueSource`.
     * @param  oracleRouter_ `OracleRouter` for stETH → USD conversion. Non-zero.
     * @param  stEth_ stETH token. Non-zero.
     * @param  wstEth_ wstETH token. Non-zero.
     * @param  stakingRouter_ Lido `StakingRouter` for fee distribution lookups. Non-zero.
     * @param  tokenRateNotifier_ Authorized caller of `pushTokenRate`. Non-zero. Granted
     *         `REPORTER_ROLE`.
     */
    constructor(
        address admin_,
        address oracleRouter_,
        address stEth_,
        address wstEth_,
        address stakingRouter_,
        address tokenRateNotifier_
    ) RevenueSource(admin_) {
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

        _grantRole(REPORTER_ROLE, tokenRateNotifier_);
    }

    /*//////////////////////////////////////////////////////////////
                           EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Seeds the rate baseline from the live wstETH rate, enabling `pushTokenRate`.
     * @dev    Single-use; reverts with `BaselineAlreadySeeded` once set. Intended to run in
     *         the same governance transaction that registers this contract as a
     *         `TokenRateNotifier` observer, so the first reported delta is measured from the
     *         post-enactment rate rather than a stale deployment-time rate.
     */
    function seedBaseline() external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_lastStEthPerToken != 0) {
            revert BaselineAlreadySeeded();
        }

        uint256 rate = WSTETH.getStETHByWstETH(TOKEN_RATE_SCALE);
        _lastStEthPerToken = rate;

        emit BaselineSeeded(rate);
    }

    /**
     * @notice `ITokenRatePusher` callback invoked by `TokenRateNotifier` after each rebase.
     *         Derives the DAO's share of gross staking rewards from the rate delta, converts to
     *         USD, and forwards to `_updateRevenue`.
     * @dev    The notifier wraps this call in try/catch, so reverts here are non-blocking and
     *         surface as `PushTokenRateFailed` on the notifier. Zero- and negative-delta reports
     *         advance the baseline but contribute no revenue, so the accumulator is untouched.
     *         The baseline advances on every report, so each positive rebase is priced against
     *         the most recent rate, internal-share count, and fee split; negative rebases lower
     *         the baseline and forgo revenue recognition for the underwater window rather than
     *         carrying a frozen deficit. Reverts with `BaselineNotSeeded` until `seedBaseline`
     *         has run. The `OracleRouter` lookup is wrapped: a recoverable revert (e.g. stale
     *         feed) emits `OracleLookupFailed` and skips this rebase; an empty revert
     *         (out-of-gas heuristic) propagates as `OracleLookupOutOfGas` so the notifier
     *         surfaces a definitive failure.
     */
    function pushTokenRate() external onlyRole(REPORTER_ROLE) {
        uint256 lastRate = _lastStEthPerToken;
        if (lastRate == 0) {
            revert BaselineNotSeeded();
        }

        uint256 rate = WSTETH.getStETHByWstETH(TOKEN_RATE_SCALE);
        _lastStEthPerToken = rate;

        if (rate <= lastRate) {
            return;
        }

        uint256 rateDelta = rate - lastRate;

        (uint256 modulesFee, uint256 treasuryFee, uint256 basePrecision) = STAKING_ROUTER
            .getStakingFeeAggregateDistribution();
        uint256 internalShares = STETH.getTotalShares() - STETH.getExternalShares();

        // Combined fee that goes to modules and the treasury on each rebase.
        uint256 totalFee = modulesFee + treasuryFee;

        // Stakers' slice of each rebase, in `basePrecision` units. Applies to every stETH
        // share, internal and external alike.
        uint256 netStakerShare = basePrecision - totalFee;

        // stETH earned by internal stakers this rebase, still scaled by `TOKEN_RATE_SCALE`.
        // Vault (external) shares are excluded by `internalShares`.
        uint256 postFeeRewardScaled = rateDelta * internalShares;

        // Treasury cut. The unfolded math is:
        //     gross  = postFeeRewardScaled * basePrecision / netStakerShare
        //     cut    = gross * treasuryFee / basePrecision
        // The `basePrecision` factors cancel. All multiplications run before the single
        // division to keep precision. Reverts on division by zero if `totalFee >= basePrecision`.
        uint256 revenueStEth = (postFeeRewardScaled * treasuryFee) /
            (TOKEN_RATE_SCALE * netStakerShare);

        uint256 stEthUsdPrice;
        try ORACLE_ROUTER.getUsdPrices(address(STETH), address(STETH)) returns (
            uint256 priceUSD,
            uint256 /* quoteUsdPrice */
        ) {
            stEthUsdPrice = priceUSD;
        } catch (bytes memory lowLevelRevertData) {
            // Empty revert data is the canonical out-of-gas signature: every revert path in
            // `OracleRouter` carries a named custom error. Propagate as an explicit revert so
            // the notifier's `PushTokenRateFailed` event signals a hard failure rather than
            // silently treating this rebase as a zero-revenue refresh.
            if (lowLevelRevertData.length == 0) {
                revert OracleLookupOutOfGas();
            }
            // Recoverable oracle failure (stale feed, misconfigured token, sequencer issue).
            // Skip this rebase; the baseline already advanced, so subsequent reports remain
            // anchored to the current rate and the source recovers automatically once the
            // upstream issue clears.
            emit OracleLookupFailed(lowLevelRevertData);
            return;
        }

        uint256 revenueUSD = (revenueStEth * stEthUsdPrice) / PRICE_SCALE;

        _addRevenueUSD(revenueUSD);
    }

    /**
     * @notice Re-seeds the rate baseline to the live wstETH rate.
     * @dev    Safety hatch for re-synchronizing after periods where `pushTokenRate` was not
     *         called (extended pauses, observer reattachment, notifier reconfiguration). Skips
     *         revenue recognition for the rate movement between the last reported rate and the
     *         live rate at the time of this call.
     */
    function resetBaseline() external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 oldRate = _lastStEthPerToken;
        if (oldRate == 0) {
            revert BaselineNotSeeded();
        }

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
