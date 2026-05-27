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
 * @notice Captures DAO treasury staking revenue from each Lido rebase. Reads
 *         `sharesMintedAsFees` directly from the `TokenRateNotifier` callback, splits it into
 *         the treasury portion using the current `StakingRouter` fee distribution, converts to
 *         USD via `OracleRouter`, and accumulates the result in the base class.
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

    /// @notice USD amount precision alignment with `OracleRouter` output.
    uint256 internal constant PRICE_SCALE = 1e18;

    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice `OracleRouter` used for stETH → USD conversion.
    IOracleRouter public immutable ORACLE_ROUTER;

    /// @notice stETH token. Queried for share-to-stETH conversion at the post-rebase rate.
    IStETH public immutable STETH;

    /// @notice Lido `StakingRouter`. Queried at call time for the modules/treasury fee split
    ///         used to slice `sharesMintedAsFees`.
    IStakingRouter public immutable STAKING_ROUTER;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event OracleLookupFailed(bytes lowLevelRevertData);

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error InvalidOracleRouterAddress(address oracleRouter);
    error InvalidStEthAddress(address stEth);
    error InvalidStakingRouterAddress(address stakingRouter);
    error InvalidTokenRateNotifierAddress(address tokenRateNotifier);
    error OracleLookupOutOfGas();

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
     *         converts to USD, and appends to the cumulative accumulator.
     * @dev    The notifier wraps this call in try/catch, so reverts here are non-blocking and
     *         surface as `PushTokenRateFailed` on the notifier. The `OracleRouter` lookup is
     *         wrapped: a recoverable revert (e.g. stale feed) emits `OracleLookupFailed` and
     *         skips this rebase; an empty revert (out-of-gas heuristic) propagates as
     *         `OracleLookupOutOfGas` so the notifier surfaces a definitive failure rather than
     *         silently skipping.
     * @param  sharesMintedAsFees_ Total fee shares minted by the protocol on this rebase, as
     *         passed through `TokenRateNotifier` from `Lido.handlePostTokenRebase`. Zero on
     *         rebases where no fees were minted (e.g. negative CL delta offset by EL rewards
     *         that lift the rate but produce no protocol fees).
     */
    function pushTokenRate(uint256 sharesMintedAsFees_) external onlyRole(REPORTER_ROLE) {
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

        uint256 stEthUsdPrice;
        try ORACLE_ROUTER.getUsdPrices(address(STETH), address(STETH)) returns (
            uint256 priceUSD,
            uint256 /* quoteUsdPrice */
        ) {
            stEthUsdPrice = priceUSD;
        } catch (bytes memory lowLevelRevertData) {
            // Empty revert data is the canonical out-of-gas signature: every revert path in
            // `OracleRouter` carries a named custom error. Propagate as an explicit revert so
            // the notifier's `PushTokenRateFailed` event signals a hard failure rather than a
            // silently dropped rebase.
            if (lowLevelRevertData.length == 0) {
                revert OracleLookupOutOfGas();
            }
            // Recoverable oracle failure (stale feed, misconfigured token, sequencer issue).
            // Skip this rebase; the protocol resumes accounting on the next push once the
            // upstream issue clears.
            emit OracleLookupFailed(lowLevelRevertData);
            return;
        }

        uint256 revenueUSD = (treasuryStEth * stEthUsdPrice) / PRICE_SCALE;

        _addRevenueUSD(revenueUSD);
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
