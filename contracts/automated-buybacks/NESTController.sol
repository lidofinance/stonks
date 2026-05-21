// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {AssetRecovererACL} from "./AssetRecovererACL.sol";
import {Math} from "../lib/Math.sol";
import {IStETH} from "../interfaces/IStETH.sol";
import {IWstETH} from "../interfaces/IWstETH.sol";
import {IOracleRouter} from "../interfaces/IOracleRouter.sol";
import {IStonks} from "../interfaces/IStonks.sol";
import {IOrder} from "../interfaces/IOrder.sol";
import {IRevenueSource} from "../interfaces/IRevenueSource.sol";
import {ILiquidityProvisioner} from "../interfaces/ILiquidityProvisioner.sol";
import {INESTController} from "../interfaces/INESTController.sol";

/**
 * @dev Minimal interface for calling `recoverERC20` on Stonks. `IStonks` cannot expose it
 *      because `AssetRecoverer.recoverERC20` is `public virtual` rather than `external`.
 */
interface IStonksRecoverable {
    function recoverERC20(address token_, uint256 amount_) external;
}

/**
 * @title NESTController
 * @author swissarmytowel <info@lido.fi>
 * @notice Central coordinator for the NEST automated buyback system. Evaluates eligibility gates,
 *         creates CoW Swap orders via Stonks v2, and in LP mode wraps stETH to wstETH for the
 *         LiquidityProvisioner. Execution paths are permissionless. Configuration is gated by
 *         `DEFAULT_ADMIN_ROLE`, emergency controls by `EMERGENCY_ROLE`.
 * @dev    As the Stonks Ownable `manager`, the controller mediates every trading action on the
 *         Stonks instance. Pass-through functions let `MANAGER_ROLE` and `EMERGENCY_ROLE` holders
 *         invoke Stonks and Order operations without direct access.
 */
contract NESTController is AssetRecovererACL, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /// @notice Constructor input parameters for the NESTController.
    struct InitParams {
        address admin;
        address treasury;
        address stEth;
        address wstEth;
        address ldo;
        address oracleRouter;
        address stonks;
        address liquidityProvisioner;
        uint128 ethPriceFloorUSD;
        uint128 dailyRevenueThresholdUSD;
        uint16 surplusShareBps;
        uint128 dailyCapUSD;
        uint128 annualCapUSD;
        uint128 minOrderSizeUSD;
        address[] revenueSources;
    }

    /// @notice Reason codes emitted with `ExecutionSkipped` when eligibility gates fail.
    enum SkipReason {
        NoSurplus,
        NegativeUnrealizedBuybacks,
        QuotabilityFailed,
        EthPriceBelowFloor,
        AnnualCapExhausted,
        InsufficientStEthBalance,
        BudgetBelowMinOrderSize,
        StonksUnavailable,
        ReceiverMismatch
    }

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice 100% in basis points.
    uint256 public constant MAX_BASIS_POINTS = 10000;

    /// @notice Fixed interval between successive `triggerExecution` calls.
    uint256 public constant TRIGGER_INTERVAL_SECONDS = 1 days;

    /// @notice Period length for the annual spending cap.
    uint256 internal constant ONE_YEAR = 365 days;

    /// @notice USD amount precision alignment with `OracleRouter` price output.
    uint256 internal constant PRICE_SCALE = 1e18;

    /// @notice Subtracted from sell amounts passed to `placeOrderWithAmount` to absorb stETH's
    ///         share-based transfer rounding. Sized with headroom above the current 1-2 wei loss.
    uint256 internal constant STETH_TRANSFER_BUFFER = 10;

    /// @notice Minimum stETH balance Stonks and Order accept for order placement and recovery.
    uint256 internal constant MIN_POSSIBLE_BALANCE = 10;

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
    /// @dev    Packed with `orderDurationSeconds` into one storage slot.
    address public liquidityProvisioner;

    /// @notice Order duration in seconds, cached from `IStonks(stonks).ORDER_DURATION_IN_SECONDS()`.
    uint64 public orderDurationSeconds;

    /// @notice Maximum USD budget deployable per trigger.
    uint128 public dailyCapUSD;

    /// @notice Maximum cumulative USD budget within a single annual period.
    uint128 public annualCapUSD;

    /// @notice Minimum USD value of a swap order.
    uint128 public minOrderSizeUSD;

    /// @notice Minimum daily revenue in USD before a surplus is recognized.
    uint128 public dailyRevenueThresholdUSD;

    /// @notice Minimum ETH/USD price required for swap execution. Zero disables the gate.
    uint128 public ethPriceFloorUSD;

    /// @notice Fraction of the revenue surplus allocated to the swap budget, in basis points.
    uint16 public surplusShareBps;

    /// @notice Registered revenue source contracts.
    EnumerableSet.AddressSet internal _revenueSources;

    /*//////////////////////////////////////////////////////////////
                         OPERATIONAL STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice Timestamp of the last accounting update in `triggerExecution`.
    uint64 public lastAccountingTimestamp;

    /// @notice Timestamp of the last order creation by `triggerExecution`.
    uint64 public lastTriggerOrderTimestamp;

    /// @notice Timestamp marking the start of the current annual period. Zero until governance
    ///         calls `initializeAnnualPeriod`; while zero, `triggerExecution` and `retryFromStonks`
    ///         revert with `AnnualPeriodNotInitialized`.
    uint64 public annualPeriodStart;

    /// @notice Timestamp of the most recent order placement from either execution path.
    uint96 public lastOrderTimestamp;

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

    /// @notice stETH wrapped to wstETH for the LP pipeline and not yet returned. Quantity ledger
    ///         that matches `accountForReturnedExcess` calls to real trigger commitments.
    uint128 public outstandingWrappedStEth;

    /// @notice Trigger-time USD committed for the wstETH tracked by `outstandingWrappedStEth`.
    uint128 public outstandingWrappedCommittedUsd;

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
    event EthPriceFloorUSDSet(uint128 ethPriceFloorUSD);
    event DailyRevenueThresholdUSDSet(uint128 dailyRevenueThresholdUSD);
    event RevenueSurplusShareBpsSet(uint16 surplusShareBps);
    event DailyCapUSDSet(uint128 dailyCapUSD);
    event AnnualCapUSDSet(uint128 annualCapUSD);
    event AnnualPeriodInitialized(uint256 timestamp);
    event AnnualPeriodReset(uint256 newPeriodStart, uint256 previousAccumulatorUSD);
    event MinOrderSizeUSDSet(uint128 minOrderSizeUSD);
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
    event RevenueSourceReverted(address indexed source);
    event SpendAdjustedForReturn(
        uint256 stEthAmount,
        uint256 creditedUsdValue,
        uint256 newAccumulatorValue,
        uint256 newCumulativeBuybacksUSD
    );
    event ReturnedSpendCredited(
        uint256 usdAmount,
        bool affectsAnnualPeriod,
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
    error NoOrderToRetry();
    error QuotabilityFailed();
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
    error InvalidDailyRevenueThreshold(uint128 dailyRevenueThresholdUSD);
    error InvalidRevenueSurplusShare(uint16 surplusShareBps);
    error InvalidDailyCap(uint128 dailyCapUSD);
    error InvalidAnnualCap(uint128 annualCapUSD);
    error InvalidMinOrderSize(uint128 minOrderSizeUSD);
    error InvalidRevenueSourceAddress(address source);
    error InvalidOrderAddress(address order);
    error InvalidTokenAddress(address token);
    error StonksReceiverMismatch(address receiver, address expectedReceiver);
    error CallerNotLiquidityProvisioner(address caller);
    error ZeroReturnedAmount();
    error ZeroCreditAmount();
    error AnnualPeriodNotInitialized();
    error AnnualPeriodAlreadyInitialized();

    /*//////////////////////////////////////////////////////////////
                              MODIFIERS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Reverts if execution is paused.
     */
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
     * @notice Initializes immutables, configurable parameters, and registers the initial revenue
     *         sources. Validates every input before any storage write.
     * @dev    `AssetRecovererACL` grants `DEFAULT_ADMIN_ROLE`, `MANAGER_ROLE`, and `EMERGENCY_ROLE`
     *         to `initParams_.admin`.
     * @param  initParams_ Packed constructor inputs. See `InitParams`.
     */
    constructor(
        InitParams memory initParams_
    ) AssetRecovererACL(initParams_.admin, initParams_.treasury) {
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

        _assertStonksReceiver(initParams_.stonks, initParams_.liquidityProvisioner);

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

        uint256 sourceCount = initParams_.revenueSources.length;
        if (sourceCount > MAX_REVENUE_SOURCES) {
            revert RevenueSourceLimitReached(MAX_REVENUE_SOURCES);
        }

        for (uint256 i; i < sourceCount; ) {
            address source = initParams_.revenueSources[i];
            if (source == address(0)) {
                revert InvalidRevenueSourceAddress(source);
            }

            (, uint256 reportTimestamp, bool isStale) = IRevenueSource(source).getRevenue();
            if (reportTimestamp == 0) {
                revert RevenueSourceHasNoData(source);
            }
            if (isStale) {
                revert RevenueSourceStale(source, reportTimestamp);
            }

            if (!_revenueSources.add(source)) {
                revert RevenueSourceAlreadyRegistered(source);
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

        orderDurationSeconds = uint64(IStonks(initParams_.stonks).ORDER_DURATION_IN_SECONDS());

        // Infinite stETH allowance to the trusted wstETH wrapper, set once.
        IERC20(initParams_.stEth).approve(address(WSTETH), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                           EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Starts the annual budget period, enabling `triggerExecution` and `retryFromStonks`.
     * @dev    Single-use; reverts with `AnnualPeriodAlreadyInitialized` once set. Intended to run in
     *         the same governance transaction that wires the controller into the protocol, so
     *         the annual budget window aligns with vote enactment rather than deployment.
     */
    function initializeAnnualPeriod() external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (annualPeriodStart != 0) {
            revert AnnualPeriodAlreadyInitialized();
        }

        annualPeriodStart = uint64(block.timestamp);

        emit AnnualPeriodInitialized(block.timestamp);
    }

    /**
     * @notice Runs daily accounting and, if eligibility gates pass, creates a CoW Swap order via
     *         Stonks. In LP mode, also wraps the matching stETH half to wstETH and transfers it
     *         to the LiquidityProvisioner. In treasury-only mode, sells the full budget via
     *         Stonks.
     * @dev    Permissionless. At most one accounting update per day and one order per accounting
     *         cycle. Failed gates emit `ExecutionSkipped` and return `address(0)`, leaving the
     *         daily cadence intact. Reverts with `AnnualPeriodNotInitialized` until governance has
     *         called `initializeAnnualPeriod`.
     * @return order Address of the newly placed Order, or `address(0)` on skip.
     */
    function triggerExecution()
        external
        nonReentrant
        whenExecutionNotPaused
        returns (address order)
    {
        if (annualPeriodStart == 0) {
            revert AnnualPeriodNotInitialized();
        }
        if (_revenueSources.length() == 0) {
            revert NoRevenueSourcesRegistered();
        }

        (int256 preAccountingUnrealizedUSD, int256 dailyAllocationUSD) = _runAccountingIfDue();

        uint256 cachedLastTriggerTs = lastTriggerOrderTimestamp;
        uint256 cachedLastAccountingTs = lastAccountingTimestamp;
        if (cachedLastTriggerTs >= cachedLastAccountingTs) {
            revert OrderAlreadyCreatedInCycle(
                cachedLastTriggerTs,
                cachedLastAccountingTs + TRIGGER_INTERVAL_SECONDS
            );
        }

        (
            bool isEligible,
            SkipReason reason,
            uint256 budgetUSD,
            uint256 stEthUsdPrice
        ) = _evaluateEligibilityGates(preAccountingUnrealizedUSD, dailyAllocationUSD);

        if (!isEligible) {
            emit ExecutionSkipped(msg.sender, uint8(reason));
            return address(0);
        }

        uint256 totalStEth = (budgetUSD * PRICE_SCALE) / stEthUsdPrice;
        address cachedProvisioner = liquidityProvisioner;
        bool isLpMode = cachedProvisioner != address(0);
        uint256 sellAmountStEth = isLpMode ? totalStEth / 2 : totalStEth;

        order = _placeOrderViaStonks(sellAmountStEth);

        uint256 wrappedWstEthAmount;
        if (isLpMode) {
            wrappedWstEthAmount = WSTETH.wrap(sellAmountStEth);
            IERC20(address(WSTETH)).safeTransfer(cachedProvisioner, wrappedWstEthAmount);
            outstandingWrappedStEth = uint128(outstandingWrappedStEth + sellAmountStEth);
            outstandingWrappedCommittedUsd = uint128(
                outstandingWrappedCommittedUsd + (sellAmountStEth * stEthUsdPrice) / PRICE_SCALE
            );
        }

        lastTriggerOrderTimestamp = uint64(block.timestamp);
        lastOrderTimestamp = uint96(block.timestamp);
        lastOrderAddress = order;
        annualSpendAccumulatorUSD += budgetUSD;
        uint256 newCumulative = cumulativeBuybacksUSD + budgetUSD;
        cumulativeBuybacksUSD = newCumulative;

        int256 cachedAllocated = allocatedForBuybacksUSD;
        emit ExecutionTriggered(
            msg.sender,
            order,
            budgetUSD,
            sellAmountStEth,
            wrappedWstEthAmount,
            cachedAllocated,
            cachedAllocated - int256(newCumulative)
        );
    }

    /**
     * @notice Re-places an order using stETH stuck in an expired Order.
     * @dev    Skips the budget and revenue gates because the stETH was already committed.
     *         The cooldown, quotability, and ETH-price gates still apply. The sell amount
     *         equals the stETH that arrived on Stonks during recovery. stETH already on
     *         Stonks does not count. Does not advance `lastTriggerOrderTimestamp`. Reverts
     *         on gate failures.
     * @return order Address of the newly placed Order.
     */
    function retryFromStonks()
        external
        nonReentrant
        whenExecutionNotPaused
        returns (address order)
    {
        if (annualPeriodStart == 0) {
            revert AnnualPeriodNotInitialized();
        }

        _assertOrderCooldownElapsed();

        address cachedLastOrder = lastOrderAddress;
        if (cachedLastOrder == address(0)) {
            revert NoOrderToRetry();
        }

        // Cheap pre-filter to avoid the oracle round trip when the Order is empty.
        if (STETH.balanceOf(cachedLastOrder) < MIN_POSSIBLE_BALANCE) {
            revert NoOrderToRetry();
        }

        (uint256 stEthUsdPrice, uint256 ldoPrice) = ORACLE_ROUTER.getUsdPrices(
            address(STETH),
            address(LDO)
        );
        uint256 cachedEthFloor = ethPriceFloorUSD;
        if (stEthUsdPrice == 0) {
            revert QuotabilityFailed();
        }
        if (ldoPrice == 0) {
            revert QuotabilityFailed();
        }
        if (stEthUsdPrice < cachedEthFloor) {
            revert EthPriceBelowFloor(stEthUsdPrice, cachedEthFloor);
        }

        address cachedStonks = stonks;
        uint256 stonksBalanceBefore = STETH.balanceOf(cachedStonks);

        IOrder(cachedLastOrder).recoverTokenFrom();

        // Measure what actually landed on Stonks rather than trusting the pre-recovery read.
        // Insulates against stETH rounding, hook-based deductions, or partial transfers.
        uint256 recovered = STETH.balanceOf(cachedStonks) - stonksBalanceBefore;
        if (recovered < MIN_POSSIBLE_BALANCE) {
            revert NoOrderToRetry();
        }

        uint256 minBuyAmount = IStonks(cachedStonks).estimateTradeOutput(recovered);

        order = IStonks(cachedStonks).placeOrderWithAmount(
            recovered - STETH_TRANSFER_BUFFER,
            minBuyAmount
        );
        lastOrderTimestamp = uint96(block.timestamp);
        lastOrderAddress = order;

        emit RetryFromStonksExecuted(order, recovered);
    }

    /**
     * @notice Refunds the spend counters when the LiquidityProvisioner returns excess stETH
     *         from the LP pipeline.
     * @dev    Restricted to the current `liquidityProvisioner`. The return is matched against
     *         the `outstandingWrappedStEth` ledger and refunded at the blended trigger-time
     *         rate. Anything beyond the outstanding ledger gets no refund, so a donated stETH
     *         transfer cannot move the caps.
     * @param  stEthAmount_ stETH transferred back to the controller. Must be non-zero.
     */
    function accountForReturnedExcess(uint256 stEthAmount_) external {
        if (msg.sender != liquidityProvisioner) {
            revert CallerNotLiquidityProvisioner(msg.sender);
        }
        if (stEthAmount_ == 0) {
            revert ZeroReturnedAmount();
        }

        uint256 cachedOutstandingStEth = outstandingWrappedStEth;

        // Cap at the outstanding ledger. A direct stETH donation to this contract must not
        // be able to refund more than was originally committed.
        uint256 matched = stEthAmount_ < cachedOutstandingStEth
            ? stEthAmount_
            : cachedOutstandingStEth;
        if (matched == 0) {
            // Nothing on the ledger to net against. Record the receipt and exit.
            emit SpendAdjustedForReturn(
                stEthAmount_,
                0,
                annualSpendAccumulatorUSD,
                cumulativeBuybacksUSD
            );
            return;
        }

        uint256 cachedOutstandingUsd = outstandingWrappedCommittedUsd;

        // Refund at the blended trigger-time rate (`outstandingUsd / outstandingStEth`). The
        // live oracle rate is intentionally avoided so price moves between trigger and return
        // cannot shift the budget caps.
        uint256 refundUsd = (matched * cachedOutstandingUsd) / cachedOutstandingStEth;

        // Both ledgers shrink by the same fraction `matched / outstandingStEth`, so the
        // blended rate is preserved for any future partial return.
        outstandingWrappedStEth = uint128(cachedOutstandingStEth - matched);
        outstandingWrappedCommittedUsd = uint128(cachedOutstandingUsd - refundUsd);

        // Saturating subtraction on the budget counters. They may already have been reduced
        // by an annual rollover, an earlier refund, or an admin reset.
        annualSpendAccumulatorUSD = Math.saturatedSub(annualSpendAccumulatorUSD, refundUsd);
        cumulativeBuybacksUSD = Math.saturatedSub(cumulativeBuybacksUSD, refundUsd);

        emit SpendAdjustedForReturn(
            stEthAmount_,
            refundUsd,
            annualSpendAccumulatorUSD,
            cumulativeBuybacksUSD
        );
    }

    /**
     * @notice Updates the ETH/USD price threshold for the ETH price gate. Zero disables the gate.
     * @param  ethPriceFloorUSD_ New ETH/USD price floor.
     */
    function setEthPriceFloorUSD(uint128 ethPriceFloorUSD_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        ethPriceFloorUSD = ethPriceFloorUSD_;

        emit EthPriceFloorUSDSet(ethPriceFloorUSD_);
    }

    /**
     * @notice Updates the daily revenue threshold below which no buybacks occur.
     * @param  dailyRevenueThresholdUSD_ New daily revenue threshold in USD. Must be greater than zero.
     */
    function setDailyRevenueThresholdUSD(
        uint128 dailyRevenueThresholdUSD_
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
        uint16 surplusShareBps_
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
    function setDailyCapUSD(uint128 dailyCapUSD_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (dailyCapUSD_ == 0 || dailyCapUSD_ < minOrderSizeUSD || dailyCapUSD_ >= annualCapUSD) {
            revert InvalidDailyCap(dailyCapUSD_);
        }

        dailyCapUSD = dailyCapUSD_;

        emit DailyCapUSDSet(dailyCapUSD_);
    }

    /**
     * @notice Updates the maximum cumulative USD budget within a single annual period.
     * @dev    Does not reset the accumulator or period start. Lowering the cap below the current
     *         accumulator clamps the gate budget to zero until the period rolls over.
     * @param  annualCapUSD_ New annual cap in USD. Must be strictly greater than `dailyCapUSD`.
     */
    function setAnnualCapUSD(uint128 annualCapUSD_) external onlyRole(DEFAULT_ADMIN_ROLE) {
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
    function setMinOrderSizeUSD(uint128 minOrderSizeUSD_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (minOrderSizeUSD_ == 0 || minOrderSizeUSD_ > dailyCapUSD) {
            revert InvalidMinOrderSize(minOrderSizeUSD_);
        }

        minOrderSizeUSD = minOrderSizeUSD_;

        emit MinOrderSizeUSDSet(minOrderSizeUSD_);
    }

    /**
     * @notice Registers a new revenue source in the controller's array.
     * @dev    The source must carry a non-zero, non-stale report, otherwise the next
     *         `triggerExecution` would revert on staleness.
     * @param  source_ Address of the revenue source contract to register.
     */
    function addRevenueSource(address source_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (source_ == address(0)) {
            revert InvalidRevenueSourceAddress(source_);
        }

        if (_revenueSources.length() >= MAX_REVENUE_SOURCES) {
            revert RevenueSourceLimitReached(MAX_REVENUE_SOURCES);
        }

        (, uint256 reportTimestamp, bool isStale) = IRevenueSource(source_).getRevenue();
        if (reportTimestamp == 0) {
            revert RevenueSourceHasNoData(source_);
        }
        if (isStale) {
            revert RevenueSourceStale(source_, reportTimestamp);
        }

        if (!_revenueSources.add(source_)) {
            revert RevenueSourceAlreadyRegistered(source_);
        }

        emit RevenueSourceAdded(source_);
    }

    /**
     * @notice Removes a revenue source from the controller's array.
     * @param  source_ Address of the revenue source contract to remove.
     */
    function removeRevenueSource(address source_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!_revenueSources.remove(source_)) {
            revert RevenueSourceNotRegistered(source_);
        }

        emit RevenueSourceRemoved(source_);
    }

    /**
     * @notice Updates the Stonks v2 contract, keeping the LiquidityProvisioner unchanged.
     * @dev    The new Stonks must already settle LDO to the current receiver. Use
     *         `setStonksAndProvisioner` to change the provisioner. Sweeps stETH from the tracked
     *         Order and the old Stonks to the treasury, re-caches `orderDurationSeconds`, and drains
     *         the provisioner. Governance must recover any earlier prior Orders before calling.
     * @param  stonks_ Address of the new Stonks contract. Must not be zero.
     */
    function setStonks(address stonks_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (stonks_ == address(0)) {
            revert InvalidStonksAddress(stonks_);
        }

        _assertOrderCooldownElapsed();
        _assertStonksReceiver(stonks_, liquidityProvisioner);

        _migrateStonks(stonks_);
    }

    /**
     * @notice Migrates the Stonks v2 contract and the LiquidityProvisioner together. Pass the zero
     *         provisioner to switch to treasury-only mode.
     * @dev    `Stonks.RECEIVER` is immutable, so changing the provisioner always needs a matching
     *         Stonks whose `RECEIVER` is the new provisioner, or the treasury in treasury-only
     *         mode. Drains the outgoing provisioner while it is still bound, sweeps stETH from
     *         the tracked Order and the old Stonks to the treasury, and re-caches
     *         `orderDurationSeconds`.
     *         Governance must recover any earlier prior Orders before calling.
     * @param  stonks_ Address of the new Stonks contract. Must not be zero.
     * @param  liquidityProvisioner_ New provisioner address, or zero for treasury-only mode.
     */
    function setStonksAndProvisioner(
        address stonks_,
        address liquidityProvisioner_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (stonks_ == address(0)) {
            revert InvalidStonksAddress(stonks_);
        }

        _assertOrderCooldownElapsed();
        _assertStonksReceiver(stonks_, liquidityProvisioner_);

        _migrateStonks(stonks_);

        liquidityProvisioner = liquidityProvisioner_;

        emit LiquidityProvisionerSet(liquidityProvisioner_);
    }

    /**
     * @notice Resets the cumulative buyback accounting state to zero.
     * @dev    Escape hatch for prolonged slashing recovery where an accumulated deficit would
     *         block buybacks. Does not reset annual caps or the trigger cadence.
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
     * @notice Credits a previously committed spend back to the accumulators when an unfilled
     *         order's stETH is swept out via Stonks migration or recovery.
     * @dev    `cumulativeBuybacksUSD` always decrements. `annualSpendAccumulatorUSD` decrements
     *         only when the commitment falls in the current annual period, since an earlier
     *         commitment is no longer part of it. Both clamp to zero.
     * @param  usdAmount_           Original trigger-time USD commitment, read from the
     *                              `ExecutionTriggered` event.
     * @param  commitmentTimestamp_ Block timestamp of the original `triggerExecution`.
     */
    function creditReturnedSpend(
        uint256 usdAmount_,
        uint256 commitmentTimestamp_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (usdAmount_ == 0) {
            revert ZeroCreditAmount();
        }

        cumulativeBuybacksUSD = Math.saturatedSub(cumulativeBuybacksUSD, usdAmount_);

        bool affectsAnnualPeriod = commitmentTimestamp_ >= annualPeriodStart;
        if (affectsAnnualPeriod) {
            annualSpendAccumulatorUSD = Math.saturatedSub(annualSpendAccumulatorUSD, usdAmount_);
        }

        emit ReturnedSpendCredited(
            usdAmount_,
            affectsAnnualPeriod,
            annualSpendAccumulatorUSD,
            cumulativeBuybacksUSD
        );
    }

    /**
     * @notice Pauses order creation via `triggerExecution` and `retryFromStonks`.
     * @dev    Idempotent.
     */
    function pauseExecution() external onlyRole(EMERGENCY_ROLE) {
        _executionPaused = true;

        emit ExecutionPaused(msg.sender);
    }

    /**
     * @notice Resumes order creation via `triggerExecution` and `retryFromStonks`.
     * @dev    Idempotent.
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
     * @notice Recovers ERC-20 tokens from a Stonks contract to the treasury.
     * @dev    Takes the Stonks address as a parameter so a Stonks the controller was bound to
     *         before a migration stays recoverable. Recovered Order funds land in their parent
     *         Stonks, which `setStonks` would otherwise leave unreachable after a migration.
     * @param  stonks_ Address of the Stonks contract to recover from.
     * @param  token_ Address of the ERC-20 token to recover.
     * @param  amount_ Amount of tokens to recover.
     */
    function recoverFromStonks(
        address stonks_,
        address token_,
        uint256 amount_
    ) external onlyRole(MANAGER_ROLE) {
        if (stonks_ == address(0)) {
            revert InvalidStonksAddress(stonks_);
        }
        if (token_ == address(0)) {
            revert InvalidTokenAddress(token_);
        }

        IStonksRecoverable(stonks_).recoverERC20(token_, amount_);
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
     * @notice Recovers ERC-20 tokens from a specific Order contract to the treasury.
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
     * @notice Recovers ERC-20 tokens to the treasury. When recovering wstETH, auto-unwraps
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

            emit WstEthRecoveredAsStEth(amount_, stEthAmount, TREASURY);

            IERC20(address(STETH)).safeTransfer(TREASURY, stEthAmount);
        } else {
            emit ERC20Recovered(token_, TREASURY, amount_);

            IERC20(token_).safeTransfer(TREASURY, amount_);
        }
    }

    /*//////////////////////////////////////////////////////////////
                       EXTERNAL VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Whether `triggerExecution` would place an order at the current block. Mirrors every
     *         `triggerExecution` precondition as a read-only check and simulates accounting
     *         without writes. Never reverts.
     * @return isEligible `true` if every gate passes. `false` if any gate fails or any underlying
     *         call reverts.
     */
    function canTriggerExecution() external view returns (bool isEligible) {
        if (_executionPaused) {
            return false;
        }
        if (annualPeriodStart == 0) {
            return false;
        }
        if (_revenueSources.length() == 0) {
            return false;
        }

        int256 cachedAllocated = allocatedForBuybacksUSD;
        int256 cachedCumulativeSigned = int256(cumulativeBuybacksUSD);
        int256 preAccountingUnrealizedUSD;
        int256 dailyAllocationUSD;

        if (block.timestamp >= uint256(lastAccountingTimestamp) + TRIGGER_INTERVAL_SECONDS) {
            (uint256 totalRevenueUSD, bool aggregationSuccess) = _trySimulateAggregateRevenue(
                lastAccountingTimestamp
            );
            if (!aggregationSuccess) {
                return false;
            }
            int256 surplusUSD = int256(totalRevenueUSD) - int256(uint256(dailyRevenueThresholdUSD));
            dailyAllocationUSD =
                (surplusUSD * int256(uint256(surplusShareBps))) /
                int256(MAX_BASIS_POINTS);
            preAccountingUnrealizedUSD = cachedAllocated - cachedCumulativeSigned;
        } else {
            if (uint256(lastTriggerOrderTimestamp) >= uint256(lastAccountingTimestamp)) {
                return false;
            }
            int256 cachedLastDaily = lastDailyAllocationUSD;
            preAccountingUnrealizedUSD = cachedAllocated - cachedLastDaily - cachedCumulativeSigned;
            dailyAllocationUSD = cachedLastDaily;
        }

        (isEligible, , , ) = _evaluateEligibilityGates(
            preAccountingUnrealizedUSD,
            dailyAllocationUSD
        );
    }

    /**
     * @notice Returns whether `retryFromStonks` would succeed at the current block. Mirrors all
     *         `retryFromStonks` preconditions as read-only checks. Never reverts.
     * @return canRetry `true` if all gates pass and the tracked Order holds enough stETH to retry.
     *         `false` otherwise.
     */
    function canRetryFromStonks() external view returns (bool canRetry) {
        if (_executionPaused) {
            return false;
        }

        // The `validTo` block is still within cooldown; `Order.recoverTokenFrom` only succeeds
        // once `block.timestamp` is past it.
        if (block.timestamp <= uint256(lastOrderTimestamp) + uint256(orderDurationSeconds)) {
            return false;
        }

        address cachedLastOrder = lastOrderAddress;
        if (cachedLastOrder == address(0)) {
            return false;
        }
        // The sell amount after the transfer buffer must still clear Stonks' MIN_POSSIBLE_BALANCE.
        if (STETH.balanceOf(cachedLastOrder) < MIN_POSSIBLE_BALANCE + STETH_TRANSFER_BUFFER) {
            return false;
        }

        // Stonks rejects new orders while creation is paused or the instance is killed.
        address cachedStonks = stonks;
        if (IStonks(cachedStonks).isCreationPaused() || IStonks(cachedStonks).isKilled()) {
            return false;
        }

        uint256 stEthUsdPrice;
        try ORACLE_ROUTER.getUsdPrices(address(STETH), address(LDO)) returns (
            uint256 stEthPrice,
            uint256 ldoPrice
        ) {
            if (stEthPrice == 0 || ldoPrice == 0) {
                return false;
            }
            stEthUsdPrice = stEthPrice;
        } catch {
            return false;
        }
        uint256 cachedEthFloor = ethPriceFloorUSD;
        canRetry = cachedEthFloor == 0 || stEthUsdPrice >= cachedEthFloor;
    }

    /**
     * @notice Aggregated pipeline and annual spend state. Single read entry point for keepers,
     *         monitors, and the LiquidityProvisioner's excess-wstETH computation.
     * @return state Current `SpendingState`. See `INESTController.SpendingState` for the field list.
     */
    function getSpendingState() external view returns (INESTController.SpendingState memory state) {
        state = INESTController.SpendingState({
            lastTriggerOrderTimestamp: lastTriggerOrderTimestamp,
            lastAccountingTimestamp: lastAccountingTimestamp,
            lastOrderTimestamp: lastOrderTimestamp,
            lastOrderAddress: lastOrderAddress,
            orderDurationSeconds: orderDurationSeconds,
            annualCapUSD: annualCapUSD,
            annualSpendAccumulatorUSD: annualSpendAccumulatorUSD,
            annualPeriodStart: annualPeriodStart,
            allocatedForBuybacksUSD: allocatedForBuybacksUSD,
            cumulativeBuybacksUSD: cumulativeBuybacksUSD,
            lastDailyAllocationUSD: lastDailyAllocationUSD
        });
    }

    /**
     * @notice Order-state tuple consumed by `LiquidityProvisioner.unwrapExcessWstEth` and its
     *         view counterparts. Returns only the fields needed for the cooldown gate and the
     *         clamp lookup, including `stonks` so the clamp can be computed in a single call.
     * @return lastOrderTimestamp_ Timestamp of the most recent order creation.
     * @return orderDurationSeconds_ Cached `Stonks.ORDER_DURATION_IN_SECONDS` value.
     * @return lastOrderAddress_ Address of the most recent Order. Zero when no Order is tracked.
     * @return stonksAddress_ Currently configured Stonks address.
     */
    function getOrderState()
        external
        view
        returns (
            uint256 lastOrderTimestamp_,
            uint256 orderDurationSeconds_,
            address lastOrderAddress_,
            address stonksAddress_
        )
    {
        lastOrderTimestamp_ = lastOrderTimestamp;
        orderDurationSeconds_ = orderDurationSeconds;
        lastOrderAddress_ = lastOrderAddress;
        stonksAddress_ = stonks;
    }

    /**
     * @notice Addresses of all registered revenue source contracts.
     * @return sources Memory copy of the underlying set.
     */
    function getRevenueSources() external view returns (address[] memory sources) {
        sources = _revenueSources.values();
    }

    /**
     * @notice Snapshot of every registered revenue source with its latest report data, pause state,
     *         and self-reported staleness flag.
     * @dev    Reverts if any source's `getRevenue` or `paused` external call reverts. Use
     *         `canTriggerExecution` for a non-reverting eligibility view.
     * @return statuses One `RevenueSourceStatus` entry per registered source.
     */
    function getRevenueSourcesWithStatus()
        external
        view
        returns (INESTController.RevenueSourceStatus[] memory statuses)
    {
        uint256 sourceCount = _revenueSources.length();
        statuses = new INESTController.RevenueSourceStatus[](sourceCount);

        for (uint256 i; i < sourceCount; ) {
            IRevenueSource source = IRevenueSource(_revenueSources.at(i));
            (uint256 revenueUSD, uint256 reportTimestamp, bool isStale) = source.getRevenue();
            statuses[i] = INESTController.RevenueSourceStatus({
                source: address(source),
                lastRevenueUSD: revenueUSD,
                reportTimestamp: reportTimestamp,
                isPaused: source.paused(),
                isStale: isStale
            });

            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Current ETH/USD price reported by the oracle router via the stETH/USD feed.
     * @dev    Reverts if the oracle router itself reverts.
     * @return ethPriceUSD stETH/USD price scaled by `PRICE_SCALE`.
     */
    function getEthPriceUSD() external view returns (uint256 ethPriceUSD) {
        (ethPriceUSD, ) = ORACLE_ROUTER.getUsdPrices(address(STETH), address(LDO));
    }

    /**
     * @notice Current daily revenue surplus from sources refreshed since the last accounting
     *         cycle, without executing or mutating state. Negative values indicate the threshold
     *         was not met.
     * @dev    Reverts on stale revenue sources or when no active sources are available, mirroring
     *         the conditions under which `triggerExecution` would revert.
     * @return totalRevenueUSD Aggregated revenue across fresh sources, 1e18-scaled USD.
     * @return surplusUSD `totalRevenueUSD - dailyRevenueThresholdUSD`.
     */
    function getDailySurplus() external view returns (uint256 totalRevenueUSD, int256 surplusUSD) {
        (totalRevenueUSD, , ) = _aggregateRevenue(lastAccountingTimestamp);
        surplusUSD = int256(totalRevenueUSD) - int256(uint256(dailyRevenueThresholdUSD));
    }

    /**
     * @notice stETH balance held by the controller and available for new trade execution.
     */
    function getAvailableStEthBalance() external view returns (uint256) {
        return STETH.balanceOf(address(this));
    }

    /**
     * @notice Returns whether `triggerExecution` and `retryFromStonks` are paused.
     */
    function isExecutionPaused() external view returns (bool) {
        return _executionPaused;
    }

    /*//////////////////////////////////////////////////////////////
                     INTERNAL STATE-CHANGING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Runs the daily accounting cycle if the trigger interval has elapsed, otherwise
     *         returns the cached same-cycle figures used by the eligibility gates. A cycle with
     *         no source refreshed since the last one returns a zero allocation and does not
     *         advance the cadence.
     * @dev    Rolls the annual period first, so the eligibility gates read an accumulator that is
     *         already reset once the year has elapsed.
     * @return preAccountingUnrealizedUSD Unrealized buybacks before today's allocation. Fresh
     *         cycle: `allocated - cumulative`. Same-cycle reuse subtracts
     *         `lastDailyAllocationUSD` to avoid double-counting.
     * @return dailyAllocationUSD Today's allocation. Freshly computed on a new cycle, otherwise
     *         the cached `lastDailyAllocationUSD`.
     */
    function _runAccountingIfDue()
        internal
        returns (int256 preAccountingUnrealizedUSD, int256 dailyAllocationUSD)
    {
        if (block.timestamp >= uint256(annualPeriodStart) + ONE_YEAR) {
            uint256 previousAccumulator = annualSpendAccumulatorUSD;
            annualPeriodStart = uint64(block.timestamp);
            annualSpendAccumulatorUSD = 0;

            emit AnnualPeriodReset(block.timestamp, previousAccumulator);
        }

        int256 cachedAllocated = allocatedForBuybacksUSD;
        int256 cachedCumulativeSigned = int256(cumulativeBuybacksUSD);
        uint256 cachedLastAccountingTs = lastAccountingTimestamp;

        if (block.timestamp < cachedLastAccountingTs + TRIGGER_INTERVAL_SECONDS) {
            int256 cachedLastDaily = lastDailyAllocationUSD;
            preAccountingUnrealizedUSD = cachedAllocated - cachedLastDaily - cachedCumulativeSigned;
            dailyAllocationUSD = cachedLastDaily;

            return (preAccountingUnrealizedUSD, dailyAllocationUSD);
        }

        preAccountingUnrealizedUSD = cachedAllocated - cachedCumulativeSigned;

        (
            uint256 totalDailyRevenueUSD,
            bool hasFreshData,
            address[] memory revertedSources
        ) = _aggregateRevenue(cachedLastAccountingTs);

        for (uint256 i; i < revertedSources.length; ) {
            emit RevenueSourceReverted(revertedSources[i]);

            unchecked {
                ++i;
            }
        }
        // No source reported since the last cycle. Skip without advancing the cadence.
        if (!hasFreshData) {
            return (preAccountingUnrealizedUSD, 0);
        }

        int256 surplusUSD = int256(totalDailyRevenueUSD) -
            int256(uint256(dailyRevenueThresholdUSD));
        dailyAllocationUSD =
            (surplusUSD * int256(uint256(surplusShareBps))) /
            int256(MAX_BASIS_POINTS);

        int256 newAllocated = cachedAllocated + dailyAllocationUSD;
        allocatedForBuybacksUSD = newAllocated;
        lastDailyAllocationUSD = dailyAllocationUSD;
        lastAccountingTimestamp = uint64(block.timestamp);

        emit AccountingUpdated(surplusUSD, newAllocated, newAllocated - cachedCumulativeSigned);
    }

    /**
     * @notice Runs the eligibility-gate cascade and budget computation. Shared by
     *         `triggerExecution` and `canTriggerExecution`.
     * @dev    Non-reverting view. A router revert maps to `QuotabilityFailed`. Failed gates
     *         return `(false, reason, 0, ...)` so the caller can skip and preserve the cadence.
     * @param  preAccountingUnrealizedUSD_ Unrealized buybacks from `_runAccountingIfDue`.
     * @param  dailyAllocationUSD_ Today's allocation from `_runAccountingIfDue`.
     * @return isEligible `true` when every gate passes.
     * @return reason     Skip reason on failure. `SkipReason.NoSurplus` when `isEligible == true`.
     * @return budgetUSD  Final clamped budget. Zero on every skip path.
     * @return stEthUsdPrice stETH/USD price from the quotability gate. Zero on pre-quotability skips.
     */
    function _evaluateEligibilityGates(
        int256 preAccountingUnrealizedUSD_,
        int256 dailyAllocationUSD_
    )
        internal
        view
        returns (bool isEligible, SkipReason reason, uint256 budgetUSD, uint256 stEthUsdPrice)
    {
        // Surplus gate.
        if (dailyAllocationUSD_ <= 0) {
            return (false, SkipReason.NoSurplus, 0, 0);
        }

        // Cumulative capacity gate. Past buybacks already overshot the running allocation.
        if (preAccountingUnrealizedUSD_ < 0) {
            return (false, SkipReason.NegativeUnrealizedBuybacks, 0, 0);
        }

        // Stonks availability gate. A paused or killed Stonks rejects order placement.
        address cachedStonks = stonks;
        if (IStonks(cachedStonks).isCreationPaused() || IStonks(cachedStonks).isKilled()) {
            return (false, SkipReason.StonksUnavailable, 0, 0);
        }
        address cachedProvisioner = liquidityProvisioner;

        {
            // Receiver gate. A `Stonks.RECEIVER` out of sync with the provisioner would settle LDO
            // to a stale receiver.
            address expectedReceiver = cachedProvisioner != address(0)
                ? cachedProvisioner
                : TREASURY;
            if (IStonks(cachedStonks).RECEIVER() != expectedReceiver) {
                return (false, SkipReason.ReceiverMismatch, 0, 0);
            }
        }
        // Quotability gate. The stETH/USD leg doubles as the ETH/USD proxy below. A zero on
        // either leg counts as a failure, guarding against the router's bridged-price path that
        // can quantize to zero without reverting.
        try ORACLE_ROUTER.getUsdPrices(address(STETH), address(LDO)) returns (
            uint256 stEthPrice,
            uint256 ldoPrice
        ) {
            if (stEthPrice == 0 || ldoPrice == 0) {
                return (false, SkipReason.QuotabilityFailed, 0, 0);
            }
            stEthUsdPrice = stEthPrice;
        } catch {
            return (false, SkipReason.QuotabilityFailed, 0, 0);
        }
        // ETH price gate. Zero floor disables the gate.
        uint256 cachedEthFloor = ethPriceFloorUSD;
        if (stEthUsdPrice < cachedEthFloor) {
            return (false, SkipReason.EthPriceBelowFloor, 0, stEthUsdPrice);
        }

        // Budget computation. Start from the smaller of today's allocation and the daily cap.
        uint256 dailyAllocationAbsUSD = uint256(dailyAllocationUSD_);
        uint256 cachedDailyCap = dailyCapUSD;
        budgetUSD = dailyAllocationAbsUSD < cachedDailyCap ? dailyAllocationAbsUSD : cachedDailyCap;

        // Annual cap gate. `_runAccountingIfDue` performs the period roll. This mirrors it
        // read-only so the view path sees the same post-roll accumulator.
        uint256 cachedAnnualAccumulator = annualSpendAccumulatorUSD;
        if (block.timestamp >= uint256(annualPeriodStart) + ONE_YEAR) {
            cachedAnnualAccumulator = 0;
        }

        uint256 cachedAnnualCap = annualCapUSD;
        if (cachedAnnualAccumulator >= cachedAnnualCap) {
            return (false, SkipReason.AnnualCapExhausted, 0, stEthUsdPrice);
        }
        uint256 remainingAnnualBudget = cachedAnnualCap - cachedAnnualAccumulator;
        if (budgetUSD > remainingAnnualBudget) {
            budgetUSD = remainingAnnualBudget;
        }

        // stETH balance gate. Skip on empty, otherwise clamp the budget to the available balance.
        uint256 availableStEth = STETH.balanceOf(address(this));
        if (availableStEth == 0) {
            return (false, SkipReason.InsufficientStEthBalance, 0, stEthUsdPrice);
        }
        uint256 availableStEthUSD = (availableStEth * stEthUsdPrice) / PRICE_SCALE;
        if (budgetUSD > availableStEthUSD) {
            budgetUSD = availableStEthUSD;
        }

        // Minimum size check.
        if (budgetUSD < minOrderSizeUSD) {
            return (false, SkipReason.BudgetBelowMinOrderSize, 0, stEthUsdPrice);
        }
        {
            // Stonks placement floor. The sell amount after the transfer buffer must still clear Stonks' `MIN_POSSIBLE_BALANCE`.
            uint256 totalStEth = (budgetUSD * PRICE_SCALE) / stEthUsdPrice;
            uint256 sellAmountStEth = cachedProvisioner != address(0) ? totalStEth / 2 : totalStEth;
            if (sellAmountStEth < MIN_POSSIBLE_BALANCE + STETH_TRANSFER_BUFFER) {
                return (false, SkipReason.BudgetBelowMinOrderSize, 0, stEthUsdPrice);
            }
        }

        isEligible = true;
    }

    /**
     * @notice Transfers stETH to Stonks and places an order. The transfer is unbuffered. Only the
     *         sell argument passed to Stonks subtracts `STETH_TRANSFER_BUFFER` to absorb
     *         share-rounding loss.
     * @param  sellAmountStEth_ stETH transferred to Stonks. Also the basis for the buy estimate.
     * @return order Address of the newly placed Order.
     */
    function _placeOrderViaStonks(uint256 sellAmountStEth_) internal returns (address order) {
        address cachedStonks = stonks;

        IERC20(address(STETH)).safeTransfer(cachedStonks, sellAmountStEth_);

        uint256 minBuyAmount = IStonks(cachedStonks).estimateTradeOutput(sellAmountStEth_);

        order = IStonks(cachedStonks).placeOrderWithAmount(
            sellAmountStEth_ - STETH_TRANSFER_BUFFER,
            minBuyAmount
        );
    }

    /**
     * @notice Sweeps stETH from the tracked Order and the outgoing Stonks to the treasury, repoints
     *         `stonks`, re-caches the order duration, and drains the bound provisioner.
     * @dev    The drain runs after the repoint, while `liquidityProvisioner` still points at the
     *         outgoing provisioner, so its accounted `unwrapExcessWstEth` callback is accepted. A
     *         revert there is caught so it cannot block the migration.
     * @param  newStonks_ Address of the new Stonks contract.
     */
    function _migrateStonks(address newStonks_) internal {
        address cachedLastOrderAddress = lastOrderAddress;
        if (cachedLastOrderAddress != address(0)) {
            uint256 orderBalance = STETH.balanceOf(cachedLastOrderAddress);
            // Skip dust below MIN_POSSIBLE_BALANCE. `recoverTokenFrom` reverts on it.
            if (orderBalance >= MIN_POSSIBLE_BALANCE) {
                IOrder(cachedLastOrderAddress).recoverTokenFrom();
            }
        }

        address oldStonks = stonks;
        uint256 stonksBalance = STETH.balanceOf(oldStonks);
        if (stonksBalance > 0) {
            IStonksRecoverable(oldStonks).recoverERC20(address(STETH), stonksBalance);
        }

        stonks = newStonks_;
        lastOrderAddress = address(0);
        orderDurationSeconds = uint64(IStonks(newStonks_).ORDER_DURATION_IN_SECONDS());

        emit StonksSet(newStonks_);

        address cachedProvisioner = liquidityProvisioner;
        if (cachedProvisioner != address(0)) {
            try ILiquidityProvisioner(cachedProvisioner).unwrapExcessWstEth() {} catch {}
        }
    }

    /*//////////////////////////////////////////////////////////////
                         INTERNAL VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Reverts with `CooldownNotElapsed` until the previous order's cooldown has fully
     *         elapsed.
     * @dev    `cooldownEnd` equals the Order's `validTo`, and `Order.recoverTokenFrom` only
     *         succeeds once `block.timestamp > validTo`. The gate holds through `cooldownEnd`
     *         itself so the boundary block cannot clear the cooldown only to revert on recovery.
     */
    function _assertOrderCooldownElapsed() internal view {
        uint256 cachedLastOrder = lastOrderTimestamp;
        uint256 cooldownEnd = cachedLastOrder + orderDurationSeconds;

        if (block.timestamp <= cooldownEnd) {
            revert CooldownNotElapsed(cachedLastOrder, cooldownEnd);
        }
    }

    /**
     * @notice Reverts when `stonks_` does not settle LDO to the receiver paired with
     *         `provisioner_`.
     * @dev    The receiver is `provisioner_`, or `TREASURY` in treasury-only mode. `Stonks.RECEIVER`
     *         is immutable, so the pair is validated whenever either pointer is set.
     * @param  stonks_ Stonks contract to check.
     * @param  provisioner_ Provisioner the Stonks must pair with. Zero for treasury-only mode.
     */
    function _assertStonksReceiver(address stonks_, address provisioner_) internal view {
        address expectedReceiver = provisioner_ != address(0) ? provisioner_ : TREASURY;
        address actualReceiver = IStonks(stonks_).RECEIVER();

        if (actualReceiver != expectedReceiver) {
            revert StonksReceiverMismatch(actualReceiver, expectedReceiver);
        }
    }

    /**
     * @notice Sums revenue from every non-paused registered source whose report is newer than the
     *         last accounting cycle. A source whose `paused` or `getRevenue` getter reverts is
     *         skipped and listed in `revertedSources`. Reverts with `RevenueSourceStale` on the
     *         first stale source, or with `NoActiveRevenueSources` when nothing is active. Used by
     *         `triggerExecution` and `getDailySurplus`. The non-reverting counterpart is
     *         `_trySimulateAggregateRevenue`.
     * @param  lastAccountingTimestamp_ Timestamp of the last accounting cycle.
     * @return totalDailyRevenueUSD Aggregated 1e18-scaled USD revenue across fresh sources.
     * @return hasFreshData True if at least one source reported after the last cycle.
     * @return revertedSources Sources skipped because a getter reverted. The caller emits
     *         `RevenueSourceReverted` for each.
     */
    function _aggregateRevenue(
        uint256 lastAccountingTimestamp_
    )
        internal
        view
        returns (uint256 totalDailyRevenueUSD, bool hasFreshData, address[] memory revertedSources)
    {
        uint256 sourceCount = _revenueSources.length();
        uint256 activeSourceCount;

        address[] memory revertedBuffer = new address[](sourceCount);
        uint256 revertedCount;

        for (uint256 i; i < sourceCount; ) {
            IRevenueSource source = IRevenueSource(_revenueSources.at(i));

            bool isPaused;
            bool getterReverted;
            try source.paused() returns (bool paused) {
                isPaused = paused;
            } catch {
                getterReverted = true;
            }
            if (!getterReverted && !isPaused) {
                try source.getRevenue() returns (
                    uint256 revenueUSD,
                    uint256 reportTimestamp,
                    bool isStale
                ) {
                    if (isStale) {
                        revert RevenueSourceStale(address(source), reportTimestamp);
                    }
                    // A report not refreshed since the last cycle was already counted. Skip it.
                    if (reportTimestamp > lastAccountingTimestamp_) {
                        totalDailyRevenueUSD += revenueUSD;
                        hasFreshData = true;
                    }

                    unchecked {
                        ++activeSourceCount;
                    }
                } catch {
                    getterReverted = true;
                }
            }

            if (getterReverted) {
                revertedBuffer[revertedCount] = address(source);

                unchecked {
                    ++revertedCount;
                }
            }

            unchecked {
                ++i;
            }
        }

        if (activeSourceCount == 0) {
            revert NoActiveRevenueSources();
        }

        // shrink the output array to the actual count of reverted sources
        revertedSources = new address[](revertedCount);
        for (uint256 i; i < revertedCount; ) {
            revertedSources[i] = revertedBuffer[i];

            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Non-reverting variant of `_aggregateRevenue` used by `canTriggerExecution`. Wraps
     *         every external call in try/catch, skipping a source whose getter reverts. Counts
     *         only sources refreshed since the last accounting cycle.
     * @param  lastAccountingTimestamp_ Timestamp of the last accounting cycle.
     * @return totalRevenueUSD Aggregated 1e18-scaled USD revenue across fresh sources. Zero on
     *         failure or when no source refreshed.
     * @return success `true` when at least one active source returned non-stale data. `false` on a
     *         stale source or when no source is active. A source whose getter reverts is skipped,
     *         mirroring `_aggregateRevenue`.
     */
    function _trySimulateAggregateRevenue(
        uint256 lastAccountingTimestamp_
    ) internal view returns (uint256 totalRevenueUSD, bool success) {
        uint256 sourceCount = _revenueSources.length();
        uint256 activeSourceCount;

        for (uint256 i; i < sourceCount; ) {
            IRevenueSource source = IRevenueSource(_revenueSources.at(i));

            bool isPaused;
            bool getterReverted;
            try source.paused() returns (bool paused) {
                isPaused = paused;
            } catch {
                getterReverted = true;
            }
            if (!getterReverted && !isPaused) {
                try source.getRevenue() returns (
                    uint256 revenueUSD,
                    uint256 reportTimestamp,
                    bool isStale
                ) {
                    if (isStale) {
                        return (0, false);
                    }
                    if (reportTimestamp > lastAccountingTimestamp_) {
                        totalRevenueUSD += revenueUSD;
                    }
                    unchecked {
                        ++activeSourceCount;
                    }
                } catch {}
            }

            unchecked {
                ++i;
            }
        }

        if (activeSourceCount == 0) {
            return (0, false);
        }
        success = true;
    }
}
