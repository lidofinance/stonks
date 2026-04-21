// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import {AssetRecovererACL} from "./AssetRecovererACL.sol";
import {IStETH} from "../interfaces/IStETH.sol";
import {IWstETH} from "../interfaces/IWstETH.sol";
import {IOracleRouter} from "../interfaces/IOracleRouter.sol";
import {IStonks} from "../interfaces/IStonks.sol";
import {IOrder} from "../interfaces/IOrder.sol";
import {IRevenueSource} from "../interfaces/IRevenueSource.sol";
import {ILiquidityProvisioner} from "../interfaces/ILiquidityProvisioner.sol";
import {INESTController} from "../interfaces/INESTController.sol";

/// @dev Minimal interface for calling `recoverERC20` on Stonks. The full `IStonks` interface omits
///      this method because its `public virtual` visibility in `AssetRecoverer` conflicts with an
///      `external` interface declaration.
interface IStonksRecoverable {
    function recoverERC20(address token_, uint256 amount_) external;
}

/**
 * @title NESTController
 * @notice Central coordinator for the NEST automated buyback system. Evaluates on-chain eligibility
 *         gates, creates CoW Swap orders via Stonks v2, and in LP mode wraps stETH to wstETH for the
 *         LiquidityProvisioner. All execution functions are permissionless and gated solely by
 *         on-chain state. Configuration is controlled by `DEFAULT_ADMIN_ROLE` holders. Emergency
 *         pause controls are accessible by `EMERGENCY_ROLE` holders.
 * @dev    Inherits `AssetRecovererACL` for role-based access and asset recovery, and `ReentrancyGuard`
 *         for execution-path safety. As the Stonks Ownable `manager`, the controller mediates all
 *         trading activity on the Stonks instance and exposes pass-through functions so `MANAGER_ROLE`
 *         and `EMERGENCY_ROLE` holders can invoke Stonks and Order operations without direct access.
 */
contract NESTController is AssetRecovererACL, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /// @notice Constructor input parameters for the NESTController.
    struct InitParams {
        address admin;
        address agent;
        address stEth;
        address wstEth;
        address ldo;
        address oracleRouter;
        address stonks;
        address liquidityProvisioner;
        uint256 ethPriceFloorUSD;
        uint256 dailyRevenueThresholdUSD;
        uint256 surplusShareBps;
        uint256 dailyCapUSD;
        uint256 annualCapUSD;
        uint256 minOrderSizeUSD;
        uint256 orderPriceProtectionBps;
        address[] revenueSources;
    }

    /// @notice Revenue source data snapshot returned by `getRevenueSourcesWithStatus`.
    struct RevenueSourceStatus {
        address source;
        uint256 lastRevenueUSD;
        uint256 reportTimestamp;
        bool isPaused;
        bool isStale;
    }

    /// @notice Reason codes emitted with `ExecutionSkipped` when eligibility gates fail.
    enum SkipReason {
        NoSurplus,
        NegativeUnrealizedBuybacks,
        QuotabilityFailed,
        EthPriceBelowFloor,
        AnnualCapExhausted,
        InsufficientStEthBalance,
        BudgetBelowMinOrderSize
    }

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice 100% in basis points.
    uint256 public constant MAX_BASIS_POINTS = 10000;

    /// @notice Seconds in one day.
    uint256 internal constant ONE_DAY = 86400;

    /// @notice Fixed interval between successive `triggerExecution` calls.
    uint256 public constant TRIGGER_INTERVAL_SECONDS = ONE_DAY;

    /// @notice Period length for the annual spending cap.
    uint256 internal constant ONE_YEAR = 365 days;

    /// @notice USD amount precision alignment with `OracleRouter` price output.
    uint256 internal constant PRICE_SCALE = 1e18;

    /// @notice Subtracted from sell amounts passed to `placeOrderWithAmount` to compensate for
    ///         stETH's 1-2 wei rounding loss on share-based transfers.
    uint256 internal constant STETH_TRANSFER_BUFFER = 2;

    /// @notice Upper bound on the revenue sources array length.
    uint256 public constant MAX_REVENUE_SOURCES = 50;

    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice stETH token used for balance checks, transfers, and USD conversion.
    IStETH public immutable STETH;

    /// @notice wstETH token used for wrapping stETH in LP mode.
    IWstETH public immutable WSTETH;

    /// @notice LDO token address used for quotability checks via the oracle router.
    IERC20 public immutable LDO;

    /// @notice Oracle router for stETH/LDO price resolution and USD conversion.
    IOracleRouter public immutable ORACLE_ROUTER;

    /*//////////////////////////////////////////////////////////////
                        CONFIGURABLE STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Stonks v2 contract managing stETH -> LDO order creation.
    /// @dev    Packed with `_executionPaused` into one storage slot.
    address public stonks;

    /// @notice When `true`, `triggerExecution` and `retryFromStonks` revert.
    bool private _executionPaused;

    /// @notice LiquidityProvisioner address, or zero for treasury-only mode.
    address public liquidityProvisioner;

    /// @notice Minimum ETH/USD price required for swap execution. Zero disables the gate.
    uint256 public ethPriceFloorUSD;

    /// @notice Minimum daily revenue in USD before a surplus is recognized.
    uint256 public dailyRevenueThresholdUSD;

    /// @notice Fraction of the revenue surplus allocated to the swap budget, in basis points.
    uint256 public surplusShareBps;

    /// @notice Maximum USD budget deployable per trigger.
    uint256 public dailyCapUSD;

    /// @notice Maximum cumulative USD budget within a single annual period.
    uint256 public annualCapUSD;

    /// @notice Minimum USD value of a swap order.
    uint256 public minOrderSizeUSD;

    /// @notice Price protection discount applied to `estimateTradeOutput` results, in basis points.
    uint256 public orderPriceProtectionBps;

    /// @notice Ordered array of revenue source contract addresses.
    address[] internal _revenueSources;

    /*//////////////////////////////////////////////////////////////
                           CACHED STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Order duration in seconds, cached from `IStonks(stonks).ORDER_DURATION_IN_SECONDS()`.
    uint256 public orderDurationSeconds;

    /*//////////////////////////////////////////////////////////////
                         OPERATIONAL STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice Timestamp of the last accounting update in `triggerExecution`.
    uint256 public lastAccountingTimestamp;

    /// @notice Timestamp of the last order creation by `triggerExecution`.
    uint256 public lastTriggerOrderTimestamp;

    /// @notice Timestamp of the most recent order placement from either execution path.
    uint256 public lastOrderTimestamp;

    /// @notice Address of the most recent Order contract.
    address public lastOrderAddress;

    /// @notice Cumulative signed sum of daily allocations. Increases on surplus days, decreases on
    ///         loss days.
    int256 public allocatedForBuybacksUSD;

    /// @notice Cumulative sum of buyback USD amounts committed at trigger-time oracle prices.
    uint256 public cumulativeBuybacksUSD;

    /// @notice Daily allocation committed during the most recent accounting update.
    int256 public lastDailyAllocationUSD;

    /// @notice Cumulative USD budget committed in the current annual period.
    uint256 public annualSpendAccumulatorUSD;

    /// @notice Timestamp marking the start of the current annual period.
    uint256 public annualPeriodStart;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event ExecutionTriggered(
        address indexed triggeredBy,
        address indexed order,
        uint256 budgetUSD,
        uint256 sellAmountStEth,
        uint256 wrappedWstEthAmount,
        int256 allocatedForBuybacksUSD,
        int256 unrealizedBuybacksUSD
    );
    event AccountingUpdated(
        int256 dailySurplusUSD,
        int256 allocatedForBuybacksUSD,
        int256 unrealizedBuybacksUSD
    );
    event ExecutionSkipped(address indexed caller, uint8 reason);
    event RetryFromStonksExecuted(address indexed order, uint256 sellAmountStEth);
    event ExecutionPaused(address indexed by);
    event ExecutionUnpaused(address indexed by);
    event EthPriceFloorUSDSet(uint256 ethPriceFloorUSD);
    event DailyRevenueThresholdUSDSet(uint256 dailyRevenueThresholdUSD);
    event RevenueSurplusShareBpsSet(uint256 surplusShareBps);
    event DailyCapUSDSet(uint256 dailyCapUSD);
    event AnnualCapUSDSet(uint256 annualCapUSD);
    event AnnualPeriodReset(uint256 newPeriodStart, uint256 previousAccumulatorUSD);
    event MinOrderSizeUSDSet(uint256 minOrderSizeUSD);
    event OrderPriceProtectionBpsSet(uint256 orderPriceProtectionBps);
    event StonksSet(address indexed stonks);
    event LiquidityProvisionerSet(address indexed liquidityProvisioner);
    event BuybackAccountingReset(
        int256 previousAllocatedForBuybacksUSD,
        uint256 previousCumulativeBuybacksUSD
    );
    event WstEthRecoveredAsStEth(
        uint256 wstEthAmount,
        uint256 stEthAmount,
        address indexed recipient
    );
    event RevenueSourceAdded(address indexed source);
    event RevenueSourceRemoved(address indexed source);
    event SpendAdjustedForReturn(
        uint256 stEthAmount,
        uint256 returnedUsdValue,
        uint256 newAccumulatorValue,
        uint256 newCumulativeBuybacksUSD
    );

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error EthPriceBelowFloor(uint256 currentPrice, uint256 floor);
    error OrderAlreadyCreatedInCycle(
        uint256 lastTriggerOrderTimestamp,
        uint256 nextAllowedTimestamp
    );
    error RevenueSourceStale(address source, uint256 reportTimestamp);
    error NoActiveRevenueSources();
    error CooldownNotElapsed(uint256 lastOrderTimestamp, uint256 cooldownEnd);
    error ZeroStEthInStonks();
    error ExecutionCurrentlyPaused();
    error NoRevenueSourcesRegistered();
    error RevenueSourceHasNoData(address source);
    error RevenueSourceAlreadyRegistered(address source);
    error RevenueSourceNotRegistered(address source);
    error RevenueSourceLimitReached(uint256 maxSources);
    error InvalidStEthAddress(address stEth);
    error InvalidWstEthAddress(address wstEth);
    error InvalidLdoAddress(address ldo);
    error InvalidOracleRouterAddress(address oracleRouter);
    error InvalidStonksAddress(address stonks);
    error InvalidDailyRevenueThreshold(uint256 dailyRevenueThresholdUSD);
    error InvalidRevenueSurplusShare(uint256 surplusShareBps);
    error InvalidDailyCap(uint256 dailyCapUSD);
    error InvalidAnnualCap(uint256 annualCapUSD);
    error InvalidMinOrderSize(uint256 minOrderSizeUSD);
    error InvalidOrderPriceProtection(uint256 orderPriceProtectionBps);
    error InvalidRevenueSourceAddress(address source);
    error InvalidOrderAddress(address order);
    error InvalidTokenAddress(address token);
    error StonksReceiverMismatch(address receiver, address expectedReceiver);
    error CallerNotLiquidityProvisioner(address caller);
    error ZeroReturnedAmount();

    /*//////////////////////////////////////////////////////////////
                              MODIFIERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Reverts if execution is paused.
    modifier whenExecutionNotPaused() {
        if (_executionPaused) {
            revert ExecutionCurrentlyPaused();
        }
        _;
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Initializes immutable references, configurable parameters, and registers the initial
     *         set of revenue sources. Validates all inputs per the spec constraints.
     * @dev    `AssetRecovererACL` grants `DEFAULT_ADMIN_ROLE`, `MANAGER_ROLE`, and `EMERGENCY_ROLE`
     *         to `initParams_.admin`. `ReentrancyGuard` self-initializes.
     */
    constructor(
        InitParams memory initParams_
    ) AssetRecovererACL(initParams_.admin, initParams_.agent) {
        if (initParams_.stEth == address(0)) {
            revert InvalidStEthAddress(initParams_.stEth);
        }
        if (initParams_.wstEth == address(0)) {
            revert InvalidWstEthAddress(initParams_.wstEth);
        }
        if (initParams_.ldo == address(0)) {
            revert InvalidLdoAddress(initParams_.ldo);
        }
        if (initParams_.oracleRouter == address(0)) {
            revert InvalidOracleRouterAddress(initParams_.oracleRouter);
        }
        if (initParams_.stonks == address(0)) {
            revert InvalidStonksAddress(initParams_.stonks);
        }

        address expectedReceiver = initParams_.liquidityProvisioner != address(0)
            ? initParams_.liquidityProvisioner
            : initParams_.agent;
        address actualReceiver = IStonks(initParams_.stonks).RECEIVER();
        if (actualReceiver != expectedReceiver) {
            revert StonksReceiverMismatch(actualReceiver, expectedReceiver);
        }

        if (initParams_.dailyRevenueThresholdUSD == 0) {
            revert InvalidDailyRevenueThreshold(initParams_.dailyRevenueThresholdUSD);
        }
        if (initParams_.surplusShareBps == 0 || initParams_.surplusShareBps > MAX_BASIS_POINTS) {
            revert InvalidRevenueSurplusShare(initParams_.surplusShareBps);
        }
        if (initParams_.annualCapUSD == 0 || initParams_.annualCapUSD <= initParams_.dailyCapUSD) {
            revert InvalidAnnualCap(initParams_.annualCapUSD);
        }
        if (
            initParams_.dailyCapUSD == 0 ||
            initParams_.dailyCapUSD < initParams_.minOrderSizeUSD ||
            initParams_.dailyCapUSD >= initParams_.annualCapUSD
        ) {
            revert InvalidDailyCap(initParams_.dailyCapUSD);
        }
        if (
            initParams_.minOrderSizeUSD == 0 ||
            initParams_.minOrderSizeUSD > initParams_.dailyCapUSD
        ) {
            revert InvalidMinOrderSize(initParams_.minOrderSizeUSD);
        }
        if (
            initParams_.orderPriceProtectionBps == 0 ||
            initParams_.orderPriceProtectionBps >= MAX_BASIS_POINTS
        ) {
            revert InvalidOrderPriceProtection(initParams_.orderPriceProtectionBps);
        }

        uint256 sourceCount = initParams_.revenueSources.length;
        if (sourceCount > MAX_REVENUE_SOURCES) {
            revert RevenueSourceLimitReached(MAX_REVENUE_SOURCES);
        }
        for (uint256 i; i < sourceCount; ) {
            if (initParams_.revenueSources[i] == address(0)) {
                revert InvalidRevenueSourceAddress(initParams_.revenueSources[i]);
            }
            for (uint256 j; j < i; ) {
                if (initParams_.revenueSources[j] == initParams_.revenueSources[i]) {
                    revert RevenueSourceAlreadyRegistered(initParams_.revenueSources[i]);
                }
                unchecked {
                    ++j;
                }
            }
            unchecked {
                ++i;
            }
        }

        STETH = IStETH(initParams_.stEth);
        WSTETH = IWstETH(initParams_.wstEth);
        LDO = IERC20(initParams_.ldo);
        ORACLE_ROUTER = IOracleRouter(initParams_.oracleRouter);

        stonks = initParams_.stonks;
        liquidityProvisioner = initParams_.liquidityProvisioner;
        ethPriceFloorUSD = initParams_.ethPriceFloorUSD;
        dailyRevenueThresholdUSD = initParams_.dailyRevenueThresholdUSD;
        surplusShareBps = initParams_.surplusShareBps;
        dailyCapUSD = initParams_.dailyCapUSD;
        annualCapUSD = initParams_.annualCapUSD;
        minOrderSizeUSD = initParams_.minOrderSizeUSD;
        orderPriceProtectionBps = initParams_.orderPriceProtectionBps;
        _revenueSources = initParams_.revenueSources;

        orderDurationSeconds = IStonks(initParams_.stonks).ORDER_DURATION_IN_SECONDS();
        annualPeriodStart = block.timestamp;
    }

    /*//////////////////////////////////////////////////////////////
                           EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Updates the ETH/USD price threshold for the ETH price gate.
     * @dev    Accepts zero, which disables the ETH price gate entirely.
     * @param  ethPriceFloorUSD_ New ETH/USD price floor.
     */
    function setEthPriceFloorUSD(uint256 ethPriceFloorUSD_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        ethPriceFloorUSD = ethPriceFloorUSD_;

        emit EthPriceFloorUSDSet(ethPriceFloorUSD_);
    }

    /**
     * @notice Updates the daily revenue threshold below which no buybacks occur.
     * @param  dailyRevenueThresholdUSD_ New daily revenue threshold in USD. Must be greater than zero.
     */
    function setDailyRevenueThresholdUSD(
        uint256 dailyRevenueThresholdUSD_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (dailyRevenueThresholdUSD_ == 0) {
            revert InvalidDailyRevenueThreshold(dailyRevenueThresholdUSD_);
        }

        dailyRevenueThresholdUSD = dailyRevenueThresholdUSD_;

        emit DailyRevenueThresholdUSDSet(dailyRevenueThresholdUSD_);
    }

    /**
     * @notice Updates the percentage of the revenue surplus allocated to buybacks.
     * @param  surplusShareBps_ New surplus share in basis points. Must be in `(0, MAX_BASIS_POINTS]`.
     */
    function setRevenueSurplusShareBps(
        uint256 surplusShareBps_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (surplusShareBps_ == 0 || surplusShareBps_ > MAX_BASIS_POINTS) {
            revert InvalidRevenueSurplusShare(surplusShareBps_);
        }

        surplusShareBps = surplusShareBps_;

        emit RevenueSurplusShareBpsSet(surplusShareBps_);
    }

    /**
     * @notice Updates the maximum USD amount deployable per trigger.
     * @param  dailyCapUSD_ New daily cap in USD. Must satisfy `minOrderSizeUSD <= dailyCapUSD_ < annualCapUSD`.
     */
    function setDailyCapUSD(uint256 dailyCapUSD_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (dailyCapUSD_ == 0 || dailyCapUSD_ < minOrderSizeUSD || dailyCapUSD_ >= annualCapUSD) {
            revert InvalidDailyCap(dailyCapUSD_);
        }

        dailyCapUSD = dailyCapUSD_;

        emit DailyCapUSDSet(dailyCapUSD_);
    }

    /**
     * @notice Updates the maximum cumulative USD budget within a single annual period.
     * @dev    Does not reset the accumulator or period start. If the cap is lowered below the current
     *         accumulator value, the annual cap gate clamps the budget to zero until the period resets.
     * @param  annualCapUSD_ New annual cap in USD. Must be strictly greater than `dailyCapUSD`.
     */
    function setAnnualCapUSD(uint256 annualCapUSD_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (annualCapUSD_ == 0 || annualCapUSD_ <= dailyCapUSD) {
            revert InvalidAnnualCap(annualCapUSD_);
        }

        annualCapUSD = annualCapUSD_;

        emit AnnualCapUSDSet(annualCapUSD_);
    }

    /**
     * @notice Updates the minimum viable budget threshold for order placement.
     * @param  minOrderSizeUSD_ New minimum order size in USD. Must satisfy `0 < minOrderSizeUSD_ <= dailyCapUSD`.
     */
    function setMinOrderSizeUSD(uint256 minOrderSizeUSD_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (minOrderSizeUSD_ == 0 || minOrderSizeUSD_ > dailyCapUSD) {
            revert InvalidMinOrderSize(minOrderSizeUSD_);
        }

        minOrderSizeUSD = minOrderSizeUSD_;

        emit MinOrderSizeUSDSet(minOrderSizeUSD_);
    }

    /**
     * @notice Updates the price protection discount applied to `estimateTradeOutput` results.
     * @param  orderPriceProtectionBps_ New price protection in basis points. Must be in `(0, MAX_BASIS_POINTS)`.
     */
    function setOrderPriceProtectionBps(
        uint256 orderPriceProtectionBps_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (orderPriceProtectionBps_ == 0 || orderPriceProtectionBps_ >= MAX_BASIS_POINTS) {
            revert InvalidOrderPriceProtection(orderPriceProtectionBps_);
        }

        orderPriceProtectionBps = orderPriceProtectionBps_;

        emit OrderPriceProtectionBpsSet(orderPriceProtectionBps_);
    }

    /**
     * @notice Registers a new revenue source in the controller's array.
     * @dev    The source must have at least one valid report to prevent a newly added source from
     *         blocking execution due to staleness.
     * @param  source_ Address of the revenue source contract to register.
     */
    function addRevenueSource(address source_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (source_ == address(0)) {
            revert InvalidRevenueSourceAddress(source_);
        }

        uint256 length = _revenueSources.length;
        for (uint256 i; i < length; ) {
            if (_revenueSources[i] == source_) {
                revert RevenueSourceAlreadyRegistered(source_);
            }
            unchecked {
                ++i;
            }
        }

        if (length >= MAX_REVENUE_SOURCES) {
            revert RevenueSourceLimitReached(MAX_REVENUE_SOURCES);
        }

        (, uint256 reportTimestamp, ) = IRevenueSource(source_).getRevenue();
        if (reportTimestamp == 0) {
            revert RevenueSourceHasNoData(source_);
        }

        _revenueSources.push(source_);

        emit RevenueSourceAdded(source_);
    }

    /**
     * @notice Removes a revenue source from the controller's array.
     * @param  source_ Address of the revenue source contract to remove.
     */
    function removeRevenueSource(address source_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 length = _revenueSources.length;

        for (uint256 i; i < length; ) {
            if (_revenueSources[i] == source_) {
                _revenueSources[i] = _revenueSources[length - 1];
                _revenueSources.pop();

                emit RevenueSourceRemoved(source_);

                return;
            }
            unchecked {
                ++i;
            }
        }

        revert RevenueSourceNotRegistered(source_);
    }

    /**
     * @notice Updates the LiquidityProvisioner address. Accepts the zero address to switch to
     *         treasury-only mode.
     * @dev    In a full migration, call this before `setStonks` to satisfy the `RECEIVER` check on
     *         the new Stonks instance.
     * @param  liquidityProvisioner_ New provisioner address, or zero for treasury-only mode.
     */
    function setLiquidityProvisioner(
        address liquidityProvisioner_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 cooldownEnd = lastOrderTimestamp + orderDurationSeconds;
        if (block.timestamp < cooldownEnd) {
            revert CooldownNotElapsed(lastOrderTimestamp, cooldownEnd);
        }

        liquidityProvisioner = liquidityProvisioner_;

        emit LiquidityProvisionerSet(liquidityProvisioner_);
    }

    /**
     * @notice Updates the Stonks v2 contract address with migration safety guardrails.
     * @dev    Auto-recovers stETH from the last Order and the old Stonks to the Aragon Agent,
     *         re-caches `orderDurationSeconds` from the new Stonks, and triggers LP cleanup.
     *         Governance must verify all prior Orders have been recovered before calling — only
     *         `lastOrderAddress` is auto-recovered.
     * @param  stonks_ Address of the new Stonks contract. Must not be zero.
     */
    function setStonks(address stonks_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (stonks_ == address(0)) {
            revert InvalidStonksAddress(stonks_);
        }

        uint256 cooldownEnd = lastOrderTimestamp + orderDurationSeconds;
        if (block.timestamp < cooldownEnd) {
            revert CooldownNotElapsed(lastOrderTimestamp, cooldownEnd);
        }

        address cachedProvisioner = liquidityProvisioner;
        address expectedReceiver = cachedProvisioner != address(0) ? cachedProvisioner : AGENT;
        address actualReceiver = IStonks(stonks_).RECEIVER();
        if (actualReceiver != expectedReceiver) {
            revert StonksReceiverMismatch(actualReceiver, expectedReceiver);
        }

        // Auto-recover stETH from the last Order back to old Stonks
        address oldStonks = stonks;
        address cachedLastOrderAddress = lastOrderAddress;
        if (cachedLastOrderAddress != address(0)) {
            uint256 orderBalance = IERC20(address(STETH)).balanceOf(cachedLastOrderAddress);
            if (orderBalance > 0) {
                IOrder(cachedLastOrderAddress).recoverTokenFrom();
            }
        }

        // Auto-recover stETH from old Stonks to AGENT
        uint256 stonksBalance = IERC20(address(STETH)).balanceOf(oldStonks);
        if (stonksBalance > 0) {
            IStonksRecoverable(oldStonks).recoverERC20(address(STETH), stonksBalance);
        }

        stonks = stonks_;
        lastOrderAddress = address(0);
        orderDurationSeconds = IStonks(stonks_).ORDER_DURATION_IN_SECONDS();

        emit StonksSet(stonks_);

        // Trigger LP cleanup; silently catch reverts to avoid blocking the migration
        if (cachedProvisioner != address(0)) {
            try ILiquidityProvisioner(cachedProvisioner).unwrapExcessWstEth() {} catch {}
        }
    }

    /**
     * @notice Resets the cumulative buyback accounting state to zero.
     * @dev    Intended for exceptional scenarios such as prolonged slashing recovery where the
     *         accumulated deficit would prevent buybacks indefinitely. Does not reset annual
     *         spending caps or trigger cadence.
     */
    function resetBuybackAccounting() external onlyRole(DEFAULT_ADMIN_ROLE) {
        int256 previousAllocated = allocatedForBuybacksUSD;
        uint256 previousCumulative = cumulativeBuybacksUSD;

        allocatedForBuybacksUSD = 0;
        cumulativeBuybacksUSD = 0;
        lastDailyAllocationUSD = 0;

        emit BuybackAccountingReset(previousAllocated, previousCumulative);
    }

    /**
     * @notice Pauses order creation via `triggerExecution` and `retryFromStonks`.
     * @dev    Idempotent — calling when already paused has no effect.
     */
    function pauseExecution() external onlyRole(EMERGENCY_ROLE) {
        _executionPaused = true;

        emit ExecutionPaused(msg.sender);
    }

    /**
     * @notice Resumes order creation via `triggerExecution` and `retryFromStonks`.
     * @dev    Idempotent — calling when already unpaused has no effect.
     */
    function unpauseExecution() external onlyRole(EMERGENCY_ROLE) {
        _executionPaused = false;

        emit ExecutionUnpaused(msg.sender);
    }

    /**
     * @notice Pauses new order creation on the Stonks contract.
     */
    function pauseStonksOrderCreation() external onlyRole(EMERGENCY_ROLE) {
        IStonks(stonks).pauseCreation();
    }

    /**
     * @notice Resumes new order creation on the Stonks contract.
     */
    function unpauseStonksOrderCreation() external onlyRole(EMERGENCY_ROLE) {
        IStonks(stonks).unpauseCreation();
    }

    /**
     * @notice Pauses signature validation on the Stonks contract, freezing settlement of all
     *         existing orders without expiring them.
     */
    function pauseStonksOrderSignatures() external onlyRole(EMERGENCY_ROLE) {
        IStonks(stonks).pauseSignatures();
    }

    /**
     * @notice Resumes signature validation on the Stonks contract.
     */
    function unpauseStonksOrderSignatures() external onlyRole(EMERGENCY_ROLE) {
        IStonks(stonks).unpauseSignatures();
    }

    /**
     * @notice Recovers ERC-20 tokens from the Stonks contract to the Aragon Agent.
     * @param  token_ Address of the ERC-20 token to recover.
     * @param  amount_ Amount of tokens to recover.
     */
    function recoverFromStonks(address token_, uint256 amount_) external onlyRole(MANAGER_ROLE) {
        if (token_ == address(0)) {
            revert InvalidTokenAddress(token_);
        }

        IStonksRecoverable(stonks).recoverERC20(token_, amount_);
    }

    /**
     * @notice Cancels a specific Order and returns its funds to the parent Stonks contract.
     *         Also revokes the CoW Protocol vault relayer approval on the Order.
     * @param  order_ Address of the Order contract to cancel.
     */
    function emergencyCancelOrder(address order_) external onlyRole(EMERGENCY_ROLE) {
        if (order_ == address(0)) {
            revert InvalidOrderAddress(order_);
        }

        IOrder(order_).emergencyCancelAndReturn();
    }

    /**
     * @notice Revokes the CoW Protocol vault relayer approval on a specific Order, preventing
     *         further settlement attempts without returning funds.
     * @param  order_ Address of the Order contract.
     */
    function emergencyRevokeOrderRelayer(address order_) external onlyRole(EMERGENCY_ROLE) {
        if (order_ == address(0)) {
            revert InvalidOrderAddress(order_);
        }

        IOrder(order_).emergencyRevokeRelayer();
    }

    /**
     * @notice Recovers ERC-20 tokens from a specific Order contract to the Aragon Agent.
     * @param  order_ Address of the Order contract.
     * @param  token_ Address of the ERC-20 token to recover.
     * @param  amount_ Amount of tokens to recover.
     */
    function recoverERC20FromOrder(
        address order_,
        address token_,
        uint256 amount_
    ) external onlyRole(EMERGENCY_ROLE) {
        if (order_ == address(0)) {
            revert InvalidOrderAddress(order_);
        }
        if (token_ == address(0)) {
            revert InvalidTokenAddress(token_);
        }

        IOrder(order_).recoverERC20(token_, amount_);
    }

    /**
     * @notice Recovers ERC-20 tokens to the Aragon Agent. When recovering wstETH, auto-unwraps
     *         to stETH so the treasury always receives stETH.
     * @param  token_ Address of the ERC-20 token to recover.
     * @param  amount_ Amount of tokens to recover.
     */
    function recoverERC20(
        address token_,
        uint256 amount_
    ) external override onlyRole(MANAGER_ROLE) {
        if (token_ == address(WSTETH)) {
            uint256 stEthAmount = WSTETH.unwrap(amount_);

            emit WstEthRecoveredAsStEth(amount_, stEthAmount, AGENT);

            IERC20(address(STETH)).safeTransfer(AGENT, stEthAmount);
        } else {
            emit ERC20Recovered(token_, AGENT, amount_);

            IERC20(token_).safeTransfer(AGENT, amount_);
        }
    }
}
