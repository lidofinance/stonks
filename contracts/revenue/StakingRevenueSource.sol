// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";

import {RevenueSource} from "./RevenueSource.sol";

import {IOracleRouter} from "../interfaces/IOracleRouter.sol";
import {IAccountingOracle} from "../interfaces/IAccountingOracle.sol";
import {ITokenRatePusher} from "../interfaces/ITokenRatePusher.sol";
import {IERC20WstETH} from "../interfaces/IERC20WstETH.sol";

/**
 * @title StakingRevenueSource
 * @author swissarmytowel
 * @notice Captures staking revenue from Lido protocol rebases. Integrates with the
 *         TokenRateNotifier registry as an ITokenRatePusher observer. After each rebase,
 *         computes daily revenue from the stETH/wstETH rate delta, converts to USD via
 *         the OracleRouter, and stores the result via the inherited _updateRevenue.
 * @dev Must be registered as an observer on TokenRateNotifier as part of NEST deployment.
 *      Registration requires ERC165 support for ITokenRatePusher.
 */
contract StakingRevenueSource is RevenueSource, ITokenRatePusher, ERC165 {
    // ==================== Immutables ====================

    /// @notice The oracle router used to fetch stETH/USD price data.
    IOracleRouter public immutable ORACLE_ROUTER;

    /// @notice The wstETH token, used for rate queries and total supply.
    IERC20WstETH public immutable WSTETH;

    /// @notice The Lido accounting oracle, used to derive the report timestamp.
    IAccountingOracle public immutable ACCOUNTING_ORACLE;

    /// @notice The stETH token address, used as the base token in oracle price queries.
    address public immutable STETH;

    /// @notice Consensus Layer genesis timestamp, cached at deployment.
    uint256 public immutable GENESIS_TIME;

    /// @notice Seconds per Consensus Layer slot, cached at deployment.
    uint256 public immutable SECONDS_PER_SLOT;

    // ==================== Constants ====================

    /// @notice Precomputed scale for rate arithmetic.
    uint256 public constant TOKEN_RATE_SCALE = 1e27;

    /// @notice Scale factor for USD amount precision alignment with OracleRouter price output.
    uint256 public constant PRICE_SCALE = 1e18;

    // ==================== Storage Variables ====================

    /// @notice Rate snapshot from the previous pushTokenRate call, scaled to TOKEN_RATE_SCALE.
    uint256 private _lastStEthPerToken;

    // ==================== Errors ====================

    error ZeroRateDelta();
    error InvalidOracleRouterAddress(address oracleRouter);
    error InvalidStEthAddress(address stEth);
    error InvalidWstEthAddress(address wstEth);
    error InvalidAccountingOracleAddress(address accountingOracle);

    // ==================== Constructor ====================

    constructor(address oracleRouter_, address stEth_, address wstEth_, address accountingOracle_) {
        if (oracleRouter_ == address(0)) {
            revert InvalidOracleRouterAddress(oracleRouter_);
        }
        if (stEth_ == address(0)) {
            revert InvalidStEthAddress(stEth_);
        }
        if (wstEth_ == address(0)) {
            revert InvalidWstEthAddress(wstEth_);
        }
        if (accountingOracle_ == address(0)) {
            revert InvalidAccountingOracleAddress(accountingOracle_);
        }

        ORACLE_ROUTER = IOracleRouter(oracleRouter_);
        STETH = stEth_;
        WSTETH = IERC20WstETH(wstEth_);
        ACCOUNTING_ORACLE = IAccountingOracle(accountingOracle_);

        GENESIS_TIME = IAccountingOracle(accountingOracle_).GENESIS_TIME();
        SECONDS_PER_SLOT = IAccountingOracle(accountingOracle_).SECONDS_PER_SLOT();

        // Seed the baseline so the first pushTokenRate computes a genuine delta.
        _lastStEthPerToken = IERC20WstETH(wstEth_).getStETHByWstETH(TOKEN_RATE_SCALE);
    }

    // ==================== External Functions ====================

    /**
     * @notice Callback implementing ITokenRatePusher. Called by TokenRateNotifier after each
     *         protocol rebase. Computes staking revenue from the rate delta, converts to USD,
     *         and stores the result via _updateRevenue.
     * @dev Reverts when paused — TokenRateNotifier catches the revert via try/catch and emits
     *      PushTokenRateFailed, then continues to the next observer.
     *      Reverts with ZeroRateDelta if the stETH/wstETH rate did not change since the last call.
     */
    function pushTokenRate() external whenNotPaused {
        uint256 rate = WSTETH.getStETHByWstETH(TOKEN_RATE_SCALE);

        int256 rateDelta = int256(rate) - int256(_lastStEthPerToken);

        if (rateDelta <= 0) {
            revert ZeroRateDelta();
        }

        uint256 revenueStEth = (uint256(rateDelta) * WSTETH.totalSupply()) / TOKEN_RATE_SCALE;

        // OracleRouter only has interface for two-token price queries, so we query stETH price with itself as the quote token to get the stETH/USD price.
        // Use only the first return value to save memory, the second return parameter is identical in value in this case.
        (uint256 stEthUsdPrice, ) = ORACLE_ROUTER.getUsdPrices(STETH, STETH);
        uint256 revenueUsd = (revenueStEth * stEthUsdPrice) / PRICE_SCALE;

        // @dev github.com/ethereum/consensus-specs/blob/dev/specs/bellatrix/beacon-chain.md#compute_timestamp_at_slot
        uint256 updateTimestamp = GENESIS_TIME +
            SECONDS_PER_SLOT *
            ACCOUNTING_ORACLE.getLastProcessingRefSlot();

        _lastStEthPerToken = rate;
        _updateRevenue(revenueUsd, updateTimestamp);
    }

    // ==================== ERC165 ====================

    /**
     * @notice ERC165 introspection. Required for registration with TokenRateNotifier,
     *         which calls supportsInterface(type(ITokenRatePusher).interfaceId) during addObserver.
     */
    function supportsInterface(bytes4 interfaceId_) public view override returns (bool) {
        return
            interfaceId_ == type(ITokenRatePusher).interfaceId ||
            super.supportsInterface(interfaceId_);
    }
}
