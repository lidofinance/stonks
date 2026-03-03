// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
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
contract NESTController is Ownable, Pausable, AssetRecoverer, ReentrancyGuard {
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

    /**
     * @notice Deploys the controller, sets all immutable references and initial configurable
     *         parameters, and registers the initial revenue source addresses.
     * @param initParams_ Struct containing all initialization parameters.
     */
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

    // ========================= External Functions =========================

    /**
     * @notice Evaluates all eligibility conditions and, if they pass, creates a CoW Swap order
     *         to buy LDO with stETH and reserves an equal amount of stETH for wstETH wrapping during
     *         liquidity provisioning. Callable by anyone when conditions permit.
     * @dev Reverts if the trigger interval has not elapsed, the ETH price is below the configured
     *      floor, price feeds are unavailable, revenue surplus is insufficient, or the constrained
     *      budget falls below the minimum order size.
     * @return order Address of the newly created Order contract.
     */
    function triggerExecution() external nonReentrant whenNotPaused returns (address order) {
        (uint256 budget, uint256 stEthUsdPrice) = _evaluateGates();

        uint256 totalStEth = Math.mulDiv(budget, PRICE_SCALE, stEthUsdPrice);
        uint256 sellAmountStEth = totalStEth / 2;
        uint256 reserveAmountStEth = totalStEth - sellAmountStEth;

        STETH.safeTransfer(address(stonks), sellAmountStEth);

        uint256 minBuyAmount = stonks.estimateTradeOutput(sellAmountStEth);
        order = stonks.placeOrderWithAmount(sellAmountStEth, minBuyAmount);

        stEthReservedForWrapping += reserveAmountStEth;
        lastTriggerTimestamp = block.timestamp;

        emit ExecutionTriggered(msg.sender, order, budget, sellAmountStEth, reserveAmountStEth);
    }

    /**
     * @notice Sets the minimum ETH/USD price below which execution is blocked.
     * @param ethPriceFloorUsd_ New floor price in USD, scaled to 1e18. Must be greater than zero.
     */
    function setEthPriceFloorUSD(uint256 ethPriceFloorUsd_) external onlyAdmin {
        if (ethPriceFloorUsd_ == 0) {
            revert InvalidEthPriceFloor(ethPriceFloorUsd_);
        }

        ethPriceFloorUsd = ethPriceFloorUsd_;

        emit EthPriceFloorUsdSet(ethPriceFloorUsd_);
    }

    /**
     * @notice Sets the minimum daily protocol revenue required before any surplus is recognized.
     * @param dailyRevenueThresholdUsd_ New threshold in USD, scaled to 1e18. Must be greater than zero.
     */
    function setDailyRevenueThresholdUSD(uint256 dailyRevenueThresholdUsd_) external onlyAdmin {
        if (dailyRevenueThresholdUsd_ == 0) {
            revert InvalidDailyRevenueThreshold(dailyRevenueThresholdUsd_);
        }

        dailyRevenueThresholdUsd = dailyRevenueThresholdUsd_;

        emit DailyRevenueThresholdUsdSet(dailyRevenueThresholdUsd_);
    }

    /**
     * @notice Sets the fraction of the revenue surplus allocated to each execution budget.
     * @param surplusShareBps_ Share in basis points. Must be in the range (0, MAX_BASIS_POINTS].
     */
    function setRevenueSurplusShare(uint256 surplusShareBps_) external onlyAdmin {
        if (surplusShareBps_ == 0 || surplusShareBps_ > MAX_BASIS_POINTS) {
            revert InvalidRevenueSurplusShare(surplusShareBps_);
        }

        surplusShareBps = surplusShareBps_;

        emit RevenueSurplusShareSet(surplusShareBps_);
    }

    /**
     * @notice Sets the maximum USD budget that a single execution can deploy.
     * @param dailyCapUsd_ New cap in USD, scaled to 1e18. Must be greater than zero.
     */
    function setDailyCapUSD(uint256 dailyCapUsd_) external onlyAdmin {
        if (dailyCapUsd_ == 0) {
            revert InvalidDailyCap(dailyCapUsd_);
        }

        dailyCapUsd = dailyCapUsd_;

        emit DailyCapUsdSet(dailyCapUsd_);
    }

    /**
     * @notice Sets the minimum budget floor. Execution reverts if the constrained budget falls below this value.
     * @param minOrderSizeUsd_ Minimum order size in USD, scaled to 1e18. Must be greater than zero.
     */
    function setMinOrderSizeUSD(uint256 minOrderSizeUsd_) external onlyAdmin {
        if (minOrderSizeUsd_ == 0) {
            revert InvalidMinOrderSize(minOrderSizeUsd_);
        }

        minOrderSizeUsd = minOrderSizeUsd_;

        emit MinOrderSizeUsdSet(minOrderSizeUsd_);
    }

    /**
     * @notice Sets the maximum acceptable slippage for Curve liquidity deposits.
     * @param poolSlippageToleranceBps_ Slippage tolerance in basis points. Must not exceed 10000.
     */
    function setPoolSlippageToleranceBps(uint256 poolSlippageToleranceBps_) external onlyAdmin {
        if (poolSlippageToleranceBps_ == 0 || poolSlippageToleranceBps_ > MAX_BASIS_POINTS) {
            revert InvalidPoolSlippageTolerance(poolSlippageToleranceBps_);
        }

        poolSlippageToleranceBps = poolSlippageToleranceBps_;

        emit PoolSlippageToleranceBpsSet(poolSlippageToleranceBps_);
    }

    /**
     * @notice Points the controller at a new Stonks instance and re-caches its order duration.
     *         The controller must already be set as manager on the new Stonks contract before
     *         order placement will succeed.
     * @param stonks_ Address of the new Stonks contract. Must not be the zero address.
     */
    function setStonks(address stonks_) external onlyAdmin {
        if (stonks_ == address(0)) {
            revert InvalidStonksAddress(stonks_);
        }

        stonks = IStonks(stonks_);
        orderDurationSeconds = stonks.ORDER_DURATION_IN_SECONDS();

        emit StonksSet(stonks_);
    }

    /**
     * @notice Registers a new revenue source in the aggregation array.
     * @param source_ Address of the RevenueSource contract. Must not be zero or already registered.
     */
    function addRevenueSource(address source_) external onlyAdmin {
        _addRevenueSource(source_);
    }

    /**
     * @notice Removes a previously registered revenue source from the aggregation array.
     * @param source_ Address of the RevenueSource contract to remove. Must be currently registered.
     */
    function removeRevenueSource(address source_) external onlyAdmin {
        if (!_isRevenueSourceRegistered[source_]) {
            revert RevenueSourceNotRegistered(source_);
        }

        uint256 length = revenueSources.length;
        for (uint256 i; i < length; ) {
            if (address(revenueSources[i]) == source_) {
                // Skip the write when removing the tail element to avoid a redundant self-assignment storage write.
                if (i != length - 1) {
                    revenueSources[i] = revenueSources[length - 1];
                }

                revenueSources.pop();

                break;
            }

            unchecked {
                ++i;
            }
        }

        delete _isRevenueSourceRegistered[source_];
        emit RevenueSourceRemoved(source_);
    }

    /**
     * @notice Recovers ERC-20 tokens to the Aragon Agent treasury. When recovering stETH, the
     *         wrapping reservation is clamped to the contract's remaining balance after the transfer
     *         so that the reservation never exceeds available funds.
     * @param token_ Token contract address to recover.
     * @param amount_ Amount of tokens to transfer to the treasury.
     */
    function recoverERC20(address token_, uint256 amount_) public override onlyAdminOrManager {
        super.recoverERC20(token_, amount_);

        if (token_ == address(STETH)) {
            // Adjust stETH reservation if necessary after recovery to ensure it does not exceed the current balance.
            uint256 remaining = STETH.balanceOf(address(this));

            if (stEthReservedForWrapping > remaining) {
                stEthReservedForWrapping = remaining;
            }
        }
    }

    // ======================== Private Functions ========================

    function _checkCooldownElapsed() internal view {
        uint256 cooldownEnd = lastTriggerTimestamp + orderDurationSeconds;

        if (block.timestamp < cooldownEnd) {
            revert CooldownNotElapsed(lastTriggerTimestamp, cooldownEnd);
        }
    }

    function _aggregateRevenue() internal view returns (uint256 totalRevenueUsd) {
        uint256 length = revenueSources.length;

        for (uint256 i; i < length; ) {
            RevenueSource source = revenueSources[i];
            // Skip paused sources
            if (!source.paused()) {
                (uint256 revenueUsd, uint256 reportTimestamp) = source.getRevenue();

                // Check if the revenue report is stale based on the configured staleness window. If the report is too old, revert the transaction to prevent using outdated revenue data for swap execution decisions.
                if (block.timestamp - reportTimestamp > STALENESS_WINDOW_SECONDS) {
                    revert RevenueSourceStale(
                        address(source),
                        reportTimestamp,
                        STALENESS_WINDOW_SECONDS
                    );
                }

                totalRevenueUsd += revenueUsd;
            }

            unchecked {
                ++i;
            }
        }
    }

    function _computeAndCheckConstrainedBudget(
        uint256 totalRevenueUsd,
        uint256 stEthUsdPrice
    ) internal view returns (uint256 budget) {
        if (totalRevenueUsd <= dailyRevenueThresholdUsd) {
            revert InsufficientRevenueSurplus(totalRevenueUsd, dailyRevenueThresholdUsd);
        }

        // Surplus is the amount of revenue above the threshold, and a limit to prevent possible overspend
        uint256 surplus = totalRevenueUsd - dailyRevenueThresholdUsd;
        budget = (surplus * surplusShareBps) / MAX_BASIS_POINTS;

        if (budget > dailyCapUsd) {
            budget = dailyCapUsd;
        }

        // Calculate the available budget based on the stETH balance and the amount of stETH reserved for future wrapping in the liquidity provision step.
        uint256 stEthBalance = STETH.balanceOf(address(this));
        uint256 availableStEth = stEthBalance > stEthReservedForWrapping
            ? stEthBalance - stEthReservedForWrapping
            : 0;
        uint256 availableUsd = Math.mulDiv(availableStEth, stEthUsdPrice, PRICE_SCALE);

        if (budget > availableUsd) {
            if (availableUsd < minOrderSizeUsd) {
                revert InsufficientStEthBalance(availableUsd, minOrderSizeUsd);
            }
            budget = availableUsd;
        }

        if (budget < minOrderSizeUsd) {
            revert BudgetBelowMinOrderSize(budget, minOrderSizeUsd);
        }
    }

    function _evaluateGates() internal view returns (uint256 budget, uint256 stEthUsdPrice) {
        // Ensure that the required cooldown period has elapsed since the last execution trigger
        uint256 nextAllowed = lastTriggerTimestamp + TRIGGER_INTERVAL_SECONDS;
        if (block.timestamp < nextAllowed) {
            revert TriggerIntervalNotElapsed(lastTriggerTimestamp, nextAllowed);
        }

        // validates both stETH and LDO feeds are live before proceeding
        (stEthUsdPrice, ) = ORACLE_ROUTER.getUsdPrices(address(STETH), address(LDO));

        if (stEthUsdPrice < ethPriceFloorUsd) {
            revert EthPriceBelowFloor(stEthUsdPrice, ethPriceFloorUsd);
        }

        budget = _computeAndCheckConstrainedBudget(_aggregateRevenue(), stEthUsdPrice);
    }

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
        if (params.surplusShareBps == 0 || params.surplusShareBps > MAX_BASIS_POINTS) {
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
        if (
            params.poolSlippageToleranceBps == 0 ||
            params.poolSlippageToleranceBps > MAX_BASIS_POINTS
        ) {
            revert InvalidPoolSlippageTolerance(params.poolSlippageToleranceBps);
        }
        if (params.triggerIntervalSeconds < ONE_DAY) {
            revert InvalidTriggerInterval(params.triggerIntervalSeconds);
        }
    }
}
