// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IStonks} from "../interfaces/IStonks.sol";
import {ITwocrypto} from "../interfaces/ITwocrypto.sol";
import {IOracleRouter} from "../interfaces/IOracleRouter.sol";

import {Ownable} from "../Ownable.sol";
import {AssetRecoverer} from "../AssetRecoverer.sol";
import {RevenueSource} from "../revenue/RevenueSource.sol";

/**
 * @title NESTController
 */
contract NESTController is Ownable, Pausable, AssetRecoverer {
    using SafeERC20 for IERC20;

    // ============================== Types ==============================

    struct InitParams {
        /// @notice The admin address for the NESTController, which will have permissions to manage the contract.
        address admin;
        /// @notice The agent address. Is the recipient of LP tokens.
        address agent;
        /// @notice The address of the stETH token contract.
        address stEth;
        /// @notice The address of the wstETH token contract.
        address wstEth;
        /// @notice The address of the LDO token contract.
        address ldo;
        /// @notice The address of the Oracle Router contract, which provides price feeds for various assets.
        address oracleRouter;
        /// @notice The address of the Stonks instance contract.
        address stonks;
        /// @notice The address of the Curve pool contract, which is used for liquidity provision and trading.
        address curvePool;
        /// @notice The ETH Price Eligibility Floor in USD, which is used to determine whether the current ETH price is eligible for swap execution.
        uint256 ethPriceFloorUsd;
        /// @notice The daily revenue threshold in USD, which is used to determine whether the current revenue is eligible for swap execution.
        uint256 dailyRevenueThresholdUsd;
        /// @notice share surplus basis points, used in the budget calculation.
        uint256 surplusShareBps;
        /// @notice The daily cap for swap execution in USD, which limits the value of daily swap.
        uint256 dailyCapUsd;
        /// @notice The minimum order size in USD, which is used to determine whether a swap order is large enough to be executed.
        uint256 minOrderSizeUsd;
        /// @notice The staleness window in seconds, which is used to determine whether price data from the Revenue Sources is too old to be considered valid for swap execution.
        uint256 stalenessWindowSeconds;
        /// @notice The slippage tolerance for swaps executed through the Curve pool, expressed in basis points (bps).
        uint256 poolSlippageToleranceBps;
        /// @notice The trigger interval in seconds, which is used to determine how often the contract can execute swaps based on the configured conditions.
        uint256 triggerIntervalSeconds;
        /// @notice The list of revenue source addresses that the NESTController will monitor for revenue data, which is used to determine whether swap execution conditions are met.
        address[] revenueSources;
    }

    // ============================ Immutables ===========================

    /// @notice The address of the stETH token contract. Uses IERC20 interface for interactions.
    IERC20 public immutable STETH;
    /// @notice The address of the LDO token contract. Uses IERC20 interface for interactions.
    IERC20 public immutable LDO;
    /// @notice The address of the wstETH token contract. Uses IERC20 interface for interactions.
    IERC20 public immutable WSTETH;
    /// @notice The address of the Oracle Router contract, which provides price feeds for various assets.
    IOracleRouter public immutable ORACLE_ROUTER;
    /// @notice The address of the Curve pool contract, which is used for liquidity provision and trading. Also serves as the LP token address for the pool.
    ITwocrypto public immutable CURVE_POOL_AND_TOKEN;

    /// @notice The staleness window in seconds, which is used to determine whether price data from the Revenue Sources is too old to be considered valid for swap execution.
    uint256 public immutable STALENESS_WINDOW_SECONDS;
    /// @notice The trigger interval in seconds, which is used to determine how often the contract can execute swaps based on the configured conditions.
    uint256 public immutable TRIGGER_INTERVAL_SECONDS;

    // ============================ Constants ============================

    /// @notice The maximum basis points value.
    uint256 public constant MAX_BASIS_POINTS = 10_000;
    /// @notice The number of seconds in one day.
    uint256 public constant ONE_DAY = 86_400;
    /// @notice The scale factor for price calculations.
    uint256 public constant PRICE_SCALE = 1e18;
    /// @notice The maximum number of revenue sources that can be registered.
    uint256 public constant MAX_REVENUE_SOURCES = 50;

    // ======================== Storage Variables ========================

    /// @notice The address of the Stonks instance contract, which provides the functionality for executing CoW Swap orders.
    IStonks public stonks;

    /// @notice The timestamp of the last execution trigger, which is used to enforce the trigger interval between successive executions.
    uint256 public lastTriggerTimestamp;
    /// @notice The amount of stETH reserved for wrapping into wstETH to be used in liquidity provision. This reservation is necessary to ensure that there is sufficient wstETH available when executing swaps and providing liquidity, while also allowing for the release of excess stETH reservation if it is not needed.
    uint256 public stEthReservedForWrapping;
    /// @notice The ETH Price Eligibility Floor in USD, which is used to determine whether the current ETH price is eligible for swap execution.
    uint256 public ethPriceFloorUsd;
    /// @notice The daily revenue threshold in USD, which is used to determine whether the current revenue is eligible for swap execution.
    uint256 public dailyRevenueThresholdUsd;
    /// @notice share surplus basis points, used in the budget calculation.
    uint256 public surplusShareBps;
    /// @notice The daily cap for swap execution in USD, which limits the value of daily swap.
    uint256 public dailyCapUsd;
    /// @notice The minimum order size in USD, which is used to determine whether a swap order is large enough to be executed.
    uint256 public minOrderSizeUsd;
    /// @notice The slippage tolerance for swaps executed through the Curve pool, expressed in basis points (bps).
    uint256 public poolSlippageToleranceBps;
    /// @notice The duration of an order in seconds, which is used to determine the validity period of a swap order.
    uint256 public orderDurationSeconds;

    RevenueSource[] public revenueSources;

    // ==================== Private Storage Variables ====================

    mapping(address source => bool registered) private _isRevenueSourceRegistered;

    // ============================== Events =============================

    event ExecutionTriggered(
        address indexed triggeredBy,
        address indexed order,
        uint256 budgetUsd,
        uint256 sellAmountStEth,
        uint256 reserveAmountStEth
    );
    event LiquidityAdded(
        address indexed caller,
        address indexed pool,
        uint256 ldoAmount,
        uint256 wstEthAmount,
        uint256 lpTokensMinted
    );
    event ExcessStEthReservationReleased(
        uint256 releasedAmountStEth,
        uint256 remainingStEthReservation
    );
    event RetryFromStonksExecuted(address indexed order, uint256 sellAmountStEth);
    event LiquidityPaused(address indexed by);
    event LiquidityUnpaused(address indexed by);
    event EthPriceFloorUsdSet(uint256 ethPriceFloorUsd);
    event DailyRevenueThresholdUsdSet(uint256 dailyRevenueThresholdUsd);
    event RevenueSurplusShareSet(uint256 surplusShareBps);
    event DailyCapUsdSet(uint256 dailyCapUsd);
    event MinOrderSizeUsdSet(uint256 minOrderSizeUsd);
    event PoolSlippageToleranceBpsSet(uint256 poolSlippageToleranceBps);
    event StonksSet(address indexed stonks);
    event RevenueSourceAdded(address indexed source);
    event RevenueSourceRemoved(address indexed source);

    // ============================== Errors =============================

    error EthPriceBelowFloor(uint256 currentPrice, uint256 floor);
    error TriggerIntervalNotElapsed(uint256 lastTriggerTimestamp, uint256 nextAllowedTimestamp);
    error RevenueSourceStale(address source, uint256 reportTimestamp, uint256 stalenessWindow);
    error InsufficientRevenueSurplus(uint256 totalRevenueUsd, uint256 threshold);
    error InsufficientStEthBalance(uint256 availableUsd, uint256 requiredUsd);
    error BudgetBelowMinOrderSize(uint256 budgetUsd, uint256 minOrderSizeUsd);
    error CooldownNotElapsed(uint256 lastTriggerTimestamp, uint256 cooldownEnd);
    error ZeroStEthInStonks();
    error ZeroLdoBalance();
    error ZeroStEthWrappingReservation();
    error ZeroExcessStEthReservation();
    error LiquidityCurrentlyPaused();
    error RevenueSourceAlreadyRegistered(address source);
    error RevenueSourceNotRegistered(address source);
    error RevenueSourceLimitReached(uint256 maxSources);
    error InvalidStEthAddress(address stEth);
    error InvalidWstEthAddress(address wstEth);
    error InvalidLdoAddress(address ldo);
    error InvalidOracleRouterAddress(address oracleRouter);
    error InvalidStonksAddress(address stonks);
    error InvalidCurvePoolAndTokenAddress(address curvePoolAndToken);
    error InvalidEthPriceFloor(uint256 ethPriceFloorUsd);
    error InvalidDailyRevenueThreshold(uint256 dailyRevenueThresholdUsd);
    error InvalidRevenueSurplusShare(uint256 surplusShareBps);
    error InvalidDailyCap(uint256 dailyCapUsd);
    error InvalidMinOrderSize(uint256 minOrderSizeUsd);
    error InvalidStalenessWindow(uint256 stalenessWindowSeconds);
    error InvalidPoolSlippageTolerance(uint256 poolSlippageToleranceBps);
    error InvalidTriggerInterval(uint256 triggerIntervalSeconds);
    error InvalidRevenueSourceAddress(address source);
    error InvalidOrderAddress(address order);
    error InvalidTokenAddress(address token);

    // =========================== Constructor ===========================

    constructor(
        InitParams memory initParams_
    ) AssetRecoverer(initParams_.admin, initParams_.agent) {
        _validateInputParameters(initParams_);

        STETH = IERC20(initParams_.stEth);
        WSTETH = IERC20(initParams_.wstEth);
        LDO = IERC20(initParams_.ldo);

        ORACLE_ROUTER = IOracleRouter(initParams_.oracleRouter);
        CURVE_POOL_AND_TOKEN = ITwocrypto(initParams_.curvePool);

        STALENESS_WINDOW_SECONDS = initParams_.stalenessWindowSeconds;
        TRIGGER_INTERVAL_SECONDS = initParams_.triggerIntervalSeconds;

        stonks = IStonks(initParams_.stonks);
        orderDurationSeconds = stonks.ORDER_DURATION_IN_SECONDS();

        ethPriceFloorUsd = initParams_.ethPriceFloorUsd;
        dailyRevenueThresholdUsd = initParams_.dailyRevenueThresholdUsd;
        surplusShareBps = initParams_.surplusShareBps;
        dailyCapUsd = initParams_.dailyCapUsd;
        minOrderSizeUsd = initParams_.minOrderSizeUsd;
        poolSlippageToleranceBps = initParams_.poolSlippageToleranceBps;

        uint256 revenueSourcesLength = initParams_.revenueSources.length;
        for (uint256 i; i < revenueSourcesLength; ) {
            _addRevenueSource(initParams_.revenueSources[i]);

            unchecked {
                ++i;
            }
        }

        emit StonksSet(initParams_.stonks);
        emit EthPriceFloorUsdSet(initParams_.ethPriceFloorUsd);
        emit DailyRevenueThresholdUsdSet(initParams_.dailyRevenueThresholdUsd);
        emit RevenueSurplusShareSet(initParams_.surplusShareBps);
        emit DailyCapUsdSet(initParams_.dailyCapUsd);
        emit MinOrderSizeUsdSet(initParams_.minOrderSizeUsd);
        emit PoolSlippageToleranceBpsSet(initParams_.poolSlippageToleranceBps);
    }

    // ======================== Private Functions ========================

    function _addRevenueSource(address source) internal {
        if (source == address(0)) {
            revert InvalidRevenueSourceAddress(source);
        }
        if (_isRevenueSourceRegistered[source]) {
            revert RevenueSourceAlreadyRegistered(source);
        }
        if (revenueSources.length >= MAX_REVENUE_SOURCES) {
            revert RevenueSourceLimitReached(MAX_REVENUE_SOURCES);
        }

        revenueSources.push(RevenueSource(source));
        _isRevenueSourceRegistered[source] = true;

        emit RevenueSourceAdded(source);
    }

    function _validateInputParameters(InitParams memory params) internal pure {
        if (params.stEth == address(0)) {
            revert InvalidStEthAddress(params.stEth);
        }
        if (params.wstEth == address(0)) {
            revert InvalidWstEthAddress(params.wstEth);
        }
        if (params.ldo == address(0)) {
            revert InvalidLdoAddress(params.ldo);
        }
        if (params.oracleRouter == address(0)) {
            revert InvalidOracleRouterAddress(params.oracleRouter);
        }
        if (params.stonks == address(0)) {
            revert InvalidStonksAddress(params.stonks);
        }
        if (params.curvePool == address(0)) {
            revert InvalidCurvePoolAndTokenAddress(params.curvePool);
        }
        if (params.ethPriceFloorUsd == 0) {
            revert InvalidEthPriceFloor(params.ethPriceFloorUsd);
        }
        if (params.dailyRevenueThresholdUsd == 0) {
            revert InvalidDailyRevenueThreshold(params.dailyRevenueThresholdUsd);
        }
        if (params.surplusShareBps > MAX_BASIS_POINTS) {
            revert InvalidRevenueSurplusShare(params.surplusShareBps);
        }
        if (params.dailyCapUsd == 0) {
            revert InvalidDailyCap(params.dailyCapUsd);
        }
        if (params.minOrderSizeUsd == 0) {
            revert InvalidMinOrderSize(params.minOrderSizeUsd);
        }
        if (params.stalenessWindowSeconds == 0) {
            revert InvalidStalenessWindow(params.stalenessWindowSeconds);
        }
        if (params.poolSlippageToleranceBps > MAX_BASIS_POINTS) {
            revert InvalidPoolSlippageTolerance(params.poolSlippageToleranceBps);
        }
        if (params.triggerIntervalSeconds < ONE_DAY) {
            revert InvalidTriggerInterval(params.triggerIntervalSeconds);
        }
    }
}
