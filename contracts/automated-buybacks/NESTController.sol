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
    uint64 internal _orderDurationSeconds;

    /*//////////////////////////////////////////////////////////////
                         OPERATIONAL STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice Timestamp of the last accounting update in `triggerExecution`.
    uint64 internal _lastAccountingTimestamp;

    /// @notice Timestamp of the last order creation by `triggerExecution`.
    uint64 internal _lastTriggerOrderTimestamp;

    /// @notice Timestamp marking the start of the current annual period.
    uint64 internal _annualPeriodStart;

    /// @notice Timestamp of the most recent order placement from either execution path.
    uint96 internal _lastOrderTimestamp;

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
            address source = initParams_.revenueSources[i];
            if (source == address(0)) {
                revert InvalidRevenueSourceAddress(source);
            }
            for (uint256 j; j < i; ) {
                if (initParams_.revenueSources[j] == source) {
                    revert RevenueSourceAlreadyRegistered(source);
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

        _orderDurationSeconds = uint64(IStonks(initParams_.stonks).ORDER_DURATION_IN_SECONDS());
        _annualPeriodStart = uint64(block.timestamp);
    }

    /*//////////////////////////////////////////////////////////////
                           EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Runs daily accounting and, if eligibility gates pass, creates a CoW Swap order via
     *         Stonks. In LP mode, also wraps the matching stETH half to wstETH and transfers it
     *         to the LiquidityProvisioner. In treasury-only mode, sells the full budget via
     *         Stonks.
     * @dev    Permissionless. At most one accounting update per day and one order per accounting
     *         cycle. Failed gates emit `ExecutionSkipped` and return `address(0)`, leaving the
     *         daily cadence intact.
     * @return order Address of the newly placed Order, or `address(0)` on skip.
     */
    function triggerExecution()
        external
        nonReentrant
        whenExecutionNotPaused
        returns (address order)
    {
        if (_revenueSources.length == 0) {
            revert NoRevenueSourcesRegistered();
        }

        (int256 preAccountingUnrealizedUSD, int256 dailyAllocationUSD) = _runAccountingIfDue();

        uint256 cachedLastTrigger = _lastTriggerOrderTimestamp;
        uint256 cachedLastAccounting = _lastAccountingTimestamp;
        if (cachedLastTrigger >= cachedLastAccounting) {
            revert OrderAlreadyCreatedInCycle(
                cachedLastTrigger,
                cachedLastAccounting + TRIGGER_INTERVAL_SECONDS
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
            IERC20(address(STETH)).forceApprove(address(WSTETH), sellAmountStEth);
            wrappedWstEthAmount = WSTETH.wrap(sellAmountStEth);
            IERC20(address(WSTETH)).safeTransfer(cachedProvisioner, wrappedWstEthAmount);
        }

        _lastTriggerOrderTimestamp = uint64(block.timestamp);
        _lastOrderTimestamp = uint96(block.timestamp);
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
     * @notice Creates a new order from stETH left in Stonks after a previous order expired.
     *         Auto-recovers stETH from the expired Order back to Stonks if needed.
     * @dev    Bypasses the budget and revenue gates because the stETH was already committed. Only
     *         the ETH-price, quotability, and cooldown gates apply. Updates `lastOrderTimestamp`
     *         but not `lastTriggerOrderTimestamp`, leaving the trigger cadence intact. Reverts on
     *         gate failures rather than skipping, since retry is a manual catch-up path.
     * @return order Address of the newly placed Order.
     */
    function retryFromStonks()
        external
        nonReentrant
        whenExecutionNotPaused
        returns (address order)
    {
        _assertOrderCooldownElapsed();

        (uint256 stEthUsdPrice, uint256 ldoPrice) = ORACLE_ROUTER.getUsdPrices(
            address(STETH),
            address(LDO)
        );
        uint256 cachedEthFloor = ethPriceFloorUSD;
        if (stEthUsdPrice == 0 || (cachedEthFloor != 0 && stEthUsdPrice < cachedEthFloor)) {
            revert EthPriceBelowFloor(stEthUsdPrice, cachedEthFloor);
        }
        if (ldoPrice == 0) {
            revert QuotabilityFailed();
        }

        address cachedStonks = stonks;
        uint256 stonksBalance = IERC20(address(STETH)).balanceOf(cachedStonks);

        if (stonksBalance == 0) {
            address cachedLastOrderAddress = lastOrderAddress;
            if (cachedLastOrderAddress != address(0)) {
                uint256 orderBalance = IERC20(address(STETH)).balanceOf(cachedLastOrderAddress);
                if (orderBalance > 0) {
                    IOrder(cachedLastOrderAddress).recoverTokenFrom();
                }
                stonksBalance = IERC20(address(STETH)).balanceOf(cachedStonks);
            }
            if (stonksBalance == 0) {
                revert ZeroStEthInStonks();
            }
        }

        uint256 minBuyAmount = IStonks(cachedStonks).estimateTradeOutput(stonksBalance);
        uint256 adjustedMinBuyAmount = (minBuyAmount *
            (MAX_BASIS_POINTS - orderPriceProtectionBps)) / MAX_BASIS_POINTS;

        order = IStonks(cachedStonks).placeOrder(adjustedMinBuyAmount);
        _lastOrderTimestamp = uint96(block.timestamp);
        lastOrderAddress = order;

        emit RetryFromStonksExecuted(order, stonksBalance);
    }

    /**
     * @notice Decrements the annual spend accumulator and cumulative buybacks tracker when the
     *         LiquidityProvisioner returns excess stETH. Recycled funds are not double-counted
     *         against caps.
     * @dev    Restricted to the current `liquidityProvisioner`. Both decrements clamp to zero to
     *         tolerate annual period resets and oracle price increases between commitment and
     *         return.
     * @param  stEthAmount_ stETH transferred back to the controller. Must be non-zero.
     */
    function accountForReturnedExcess(uint256 stEthAmount_) external nonReentrant {
        if (msg.sender != liquidityProvisioner) {
            revert CallerNotLiquidityProvisioner(msg.sender);
        }
        if (stEthAmount_ == 0) {
            revert ZeroReturnedAmount();
        }

        (uint256 stEthUsdPrice, ) = ORACLE_ROUTER.getUsdPrices(address(STETH), address(LDO));
        if (stEthUsdPrice == 0) {
            revert QuotabilityFailed();
        }
        uint256 returnedUsdValue = (stEthAmount_ * stEthUsdPrice) / PRICE_SCALE;

        uint256 cachedAccumulator = annualSpendAccumulatorUSD;
        uint256 newAccumulator;
        if (cachedAccumulator > returnedUsdValue) {
            unchecked {
                newAccumulator = cachedAccumulator - returnedUsdValue;
            }
            annualSpendAccumulatorUSD = newAccumulator;
        } else if (cachedAccumulator != 0) {
            annualSpendAccumulatorUSD = 0;
        }

        uint256 cachedCumulative = cumulativeBuybacksUSD;
        uint256 newCumulative;
        if (cachedCumulative > returnedUsdValue) {
            unchecked {
                newCumulative = cachedCumulative - returnedUsdValue;
            }
            cumulativeBuybacksUSD = newCumulative;
        } else if (cachedCumulative != 0) {
            cumulativeBuybacksUSD = 0;
        }

        emit SpendAdjustedForReturn(stEthAmount_, returnedUsdValue, newAccumulator, newCumulative);
    }

    /**
     * @notice Updates the ETH/USD price threshold for the ETH price gate. Zero disables the gate.
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
     * @dev    Does not reset the accumulator or period start. Lowering the cap below the current
     *         accumulator clamps the gate budget to zero until the period rolls over.
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
        _assertOrderCooldownElapsed();

        liquidityProvisioner = liquidityProvisioner_;

        emit LiquidityProvisionerSet(liquidityProvisioner_);
    }

    /**
     * @notice Updates the Stonks v2 contract address with migration safety guardrails.
     * @dev    Auto-recovers stETH from `lastOrderAddress` and the old Stonks to the Aragon Agent,
     *         re-caches `orderDurationSeconds` from the new Stonks, and triggers LP cleanup.
     *         Governance must recover any earlier prior Orders before calling.
     * @param  stonks_ Address of the new Stonks contract. Must not be zero.
     */
    function setStonks(address stonks_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (stonks_ == address(0)) {
            revert InvalidStonksAddress(stonks_);
        }

        _assertOrderCooldownElapsed();

        address cachedProvisioner = liquidityProvisioner;
        address expectedReceiver = cachedProvisioner != address(0) ? cachedProvisioner : AGENT;
        address actualReceiver = IStonks(stonks_).RECEIVER();
        if (actualReceiver != expectedReceiver) {
            revert StonksReceiverMismatch(actualReceiver, expectedReceiver);
        }

        address oldStonks = stonks;
        address cachedLastOrderAddress = lastOrderAddress;
        if (cachedLastOrderAddress != address(0)) {
            uint256 orderBalance = IERC20(address(STETH)).balanceOf(cachedLastOrderAddress);
            if (orderBalance > 0) {
                IOrder(cachedLastOrderAddress).recoverTokenFrom();
            }
        }

        uint256 stonksBalance = IERC20(address(STETH)).balanceOf(oldStonks);
        if (stonksBalance > 0) {
            IStonksRecoverable(oldStonks).recoverERC20(address(STETH), stonksBalance);
        }

        stonks = stonks_;
        lastOrderAddress = address(0);
        _orderDurationSeconds = uint64(IStonks(stonks_).ORDER_DURATION_IN_SECONDS());

        emit StonksSet(stonks_);

        if (cachedProvisioner != address(0)) {
            try ILiquidityProvisioner(cachedProvisioner).unwrapExcessWstEth() {} catch {}
        }
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

    /*//////////////////////////////////////////////////////////////
                       EXTERNAL VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Order duration in seconds, cached from `IStonks(stonks).ORDER_DURATION_IN_SECONDS()`.
     */
    function orderDurationSeconds() external view returns (uint256) {
        return _orderDurationSeconds;
    }

    /**
     * @notice Timestamp of the last accounting update in `triggerExecution`.
     */
    function lastAccountingTimestamp() external view returns (uint256) {
        return _lastAccountingTimestamp;
    }

    /**
     * @notice Timestamp of the last order creation by `triggerExecution`.
     */
    function lastTriggerOrderTimestamp() external view returns (uint256) {
        return _lastTriggerOrderTimestamp;
    }

    /**
     * @notice Timestamp marking the start of the current annual period.
     */
    function annualPeriodStart() external view returns (uint256) {
        return _annualPeriodStart;
    }

    /**
     * @notice Timestamp of the most recent order placement from either execution path.
     */
    function lastOrderTimestamp() external view returns (uint256) {
        return _lastOrderTimestamp;
    }

    /**
     * @notice Whether `triggerExecution` would place an order at the current block. Mirrors every
     *         `triggerExecution` precondition as a read-only check and simulates accounting
     *         without writes. Never reverts.
     * @return ok `true` if every gate passes. `false` if any gate fails or any underlying call
     *         reverts.
     */
    function canTriggerExecution() external view returns (bool ok) {
        if (_executionPaused) {
            return false;
        }
        if (_revenueSources.length == 0) {
            return false;
        }

        int256 cachedAllocated = allocatedForBuybacksUSD;
        int256 cachedCumulativeSigned = int256(cumulativeBuybacksUSD);
        int256 preAccountingUnrealizedUSD;
        int256 dailyAllocationUSD;

        if (block.timestamp >= uint256(_lastAccountingTimestamp) + TRIGGER_INTERVAL_SECONDS) {
            (uint256 totalRevenueUSD, bool aggregationOk) = _trySimulateAggregateRevenue();
            if (!aggregationOk) {
                return false;
            }
            int256 surplusUSD = int256(totalRevenueUSD) - int256(dailyRevenueThresholdUSD);
            dailyAllocationUSD = (surplusUSD * int256(surplusShareBps)) / int256(MAX_BASIS_POINTS);
            preAccountingUnrealizedUSD = cachedAllocated - cachedCumulativeSigned;
        } else {
            if (uint256(_lastTriggerOrderTimestamp) >= uint256(_lastAccountingTimestamp)) {
                return false;
            }
            int256 cachedLastDaily = lastDailyAllocationUSD;
            preAccountingUnrealizedUSD = cachedAllocated - cachedLastDaily - cachedCumulativeSigned;
            dailyAllocationUSD = cachedLastDaily;
        }

        if (dailyAllocationUSD <= 0) {
            return false;
        }
        if (preAccountingUnrealizedUSD < 0) {
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
        if (cachedEthFloor != 0 && stEthUsdPrice < cachedEthFloor) {
            return false;
        }

        uint256 dailyAllocationAbsUSD = uint256(dailyAllocationUSD);
        uint256 cachedDailyCap = dailyCapUSD;
        uint256 budgetUSD = dailyAllocationAbsUSD < cachedDailyCap
            ? dailyAllocationAbsUSD
            : cachedDailyCap;

        uint256 cachedAnnualAccumulator = annualSpendAccumulatorUSD;
        if (block.timestamp >= uint256(_annualPeriodStart) + ONE_YEAR) {
            cachedAnnualAccumulator = 0;
        }
        uint256 cachedAnnualCap = annualCapUSD;
        if (cachedAnnualAccumulator >= cachedAnnualCap) {
            return false;
        }
        uint256 remainingAnnualBudget = cachedAnnualCap - cachedAnnualAccumulator;
        if (budgetUSD > remainingAnnualBudget) {
            budgetUSD = remainingAnnualBudget;
        }

        uint256 availableStEth = IERC20(address(STETH)).balanceOf(address(this));
        if (availableStEth == 0) {
            return false;
        }
        uint256 availableStEthUSD = (availableStEth * stEthUsdPrice) / PRICE_SCALE;
        if (budgetUSD > availableStEthUSD) {
            budgetUSD = availableStEthUSD;
        }

        if (budgetUSD < minOrderSizeUSD) {
            return false;
        }

        ok = true;
    }

    /**
     * @notice Returns whether `retryFromStonks` would succeed at the current block. Mirrors all
     *         `retryFromStonks` preconditions as read-only checks. Never reverts.
     * @return ok `true` if all gates pass and stETH is available either in Stonks or the last
     *         Order. `false` otherwise.
     */
    function canRetryFromStonks() external view returns (bool ok) {
        if (_executionPaused) {
            return false;
        }

        if (block.timestamp < uint256(_lastOrderTimestamp) + uint256(_orderDurationSeconds)) {
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
        if (cachedEthFloor != 0 && stEthUsdPrice < cachedEthFloor) {
            return false;
        }

        if (IERC20(address(STETH)).balanceOf(stonks) > 0) {
            return true;
        }

        address cachedLastOrderAddress = lastOrderAddress;
        if (cachedLastOrderAddress == address(0)) {
            return false;
        }
        ok = IERC20(address(STETH)).balanceOf(cachedLastOrderAddress) > 0;
    }

    /**
     * @notice Aggregated pipeline and annual spend state. Single read entry point for keepers,
     *         monitors, and the LiquidityProvisioner's excess-wstETH computation.
     * @return state Current `SpendingState`. See `INESTController.SpendingState` for the field list.
     */
    function getSpendingState() external view returns (INESTController.SpendingState memory state) {
        state = INESTController.SpendingState({
            lastTriggerOrderTimestamp: _lastTriggerOrderTimestamp,
            lastAccountingTimestamp: _lastAccountingTimestamp,
            lastOrderTimestamp: _lastOrderTimestamp,
            lastOrderAddress: lastOrderAddress,
            orderDurationSeconds: _orderDurationSeconds,
            annualCapUSD: annualCapUSD,
            annualSpendAccumulatorUSD: annualSpendAccumulatorUSD,
            annualPeriodStart: _annualPeriodStart,
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
        lastOrderTimestamp_ = _lastOrderTimestamp;
        orderDurationSeconds_ = _orderDurationSeconds;
        lastOrderAddress_ = lastOrderAddress;
        stonksAddress_ = stonks;
    }

    /**
     * @notice Snapshot of every registered revenue source with its latest report data, pause state,
     *         and self-reported staleness flag.
     * @dev    Reverts if any source's `getRevenue` or `paused` external call reverts. Use
     *         `canTriggerExecution` for a non-reverting eligibility view.
     * @return statuses One `RevenueSourceStatus` entry per registered source, in registration order.
     */
    function getRevenueSourcesWithStatus()
        external
        view
        returns (INESTController.RevenueSourceStatus[] memory statuses)
    {
        uint256 sourceCount = _revenueSources.length;
        statuses = new INESTController.RevenueSourceStatus[](sourceCount);

        for (uint256 i; i < sourceCount; ) {
            IRevenueSource source = IRevenueSource(_revenueSources[i]);
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
     * @notice Current daily revenue surplus without executing or mutating state. Negative values
     *         indicate the threshold was not met.
     * @dev    Reverts on stale revenue sources or when no active sources are available, mirroring
     *         the conditions under which `triggerExecution` would revert.
     * @return totalRevenueUSD Aggregated revenue across active sources, 1e18-scaled USD.
     * @return surplusUSD `totalRevenueUSD - dailyRevenueThresholdUSD`.
     */
    function getDailySurplus() external view returns (uint256 totalRevenueUSD, int256 surplusUSD) {
        totalRevenueUSD = _aggregateRevenue();
        surplusUSD = int256(totalRevenueUSD) - int256(dailyRevenueThresholdUSD);
    }

    /**
     * @notice stETH balance held by the controller and available for new trade execution.
     */
    function getAvailableStEthBalance() external view returns (uint256) {
        return IERC20(address(STETH)).balanceOf(address(this));
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
     *         returns the cached same-cycle figures used by the eligibility gates.
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
        int256 cachedAllocated = allocatedForBuybacksUSD;
        int256 cachedCumulativeSigned = int256(cumulativeBuybacksUSD);

        if (block.timestamp < uint256(_lastAccountingTimestamp) + TRIGGER_INTERVAL_SECONDS) {
            int256 cachedLastDaily = lastDailyAllocationUSD;
            preAccountingUnrealizedUSD = cachedAllocated - cachedLastDaily - cachedCumulativeSigned;
            dailyAllocationUSD = cachedLastDaily;

            return (preAccountingUnrealizedUSD, dailyAllocationUSD);
        }

        preAccountingUnrealizedUSD = cachedAllocated - cachedCumulativeSigned;

        uint256 totalDailyRevenueUSD = _aggregateRevenue();
        int256 surplusUSD = int256(totalDailyRevenueUSD) - int256(dailyRevenueThresholdUSD);
        dailyAllocationUSD = (surplusUSD * int256(surplusShareBps)) / int256(MAX_BASIS_POINTS);

        int256 newAllocated = cachedAllocated + dailyAllocationUSD;
        allocatedForBuybacksUSD = newAllocated;
        lastDailyAllocationUSD = dailyAllocationUSD;
        _lastAccountingTimestamp = uint64(block.timestamp);

        emit AccountingUpdated(surplusUSD, newAllocated, newAllocated - cachedCumulativeSigned);
    }

    /**
     * @notice Runs the eligibility-gate cascade and budget computation. Non-reverting. Failed
     *         gates return `(false, reason, 0, ...)` so `triggerExecution` can emit
     *         `ExecutionSkipped` and preserve the daily cadence.
     * @dev    The only state write is the annual period reset, needed before the cap is
     *         re-evaluated.
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
        if (cachedEthFloor != 0 && stEthUsdPrice < cachedEthFloor) {
            return (false, SkipReason.EthPriceBelowFloor, 0, stEthUsdPrice);
        }

        // Budget computation. Start from the smaller of today's allocation and the daily cap.
        uint256 dailyAllocationAbsUSD = uint256(dailyAllocationUSD_);
        uint256 cachedDailyCap = dailyCapUSD;
        budgetUSD = dailyAllocationAbsUSD < cachedDailyCap ? dailyAllocationAbsUSD : cachedDailyCap;

        // Annual cap gate. Roll the period when a year has elapsed, then skip or clamp.
        uint256 cachedAnnualAccumulator = annualSpendAccumulatorUSD;
        if (block.timestamp >= uint256(_annualPeriodStart) + ONE_YEAR) {
            _annualPeriodStart = uint64(block.timestamp);
            annualSpendAccumulatorUSD = 0;

            emit AnnualPeriodReset(block.timestamp, cachedAnnualAccumulator);

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
        uint256 availableStEth = IERC20(address(STETH)).balanceOf(address(this));
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

        isEligible = true;
    }

    /**
     * @notice Transfers stETH to Stonks and places an order with a price-protection-adjusted
     *         `minBuyAmount`. The transfer is unbuffered. Only the sell argument passed to
     *         Stonks subtracts `STETH_TRANSFER_BUFFER` to absorb share-rounding loss.
     * @param  sellAmountStEth_ stETH transferred to Stonks. Also the basis for the buy estimate
     *         before the protection discount.
     * @return order Address of the newly placed Order.
     */
    function _placeOrderViaStonks(uint256 sellAmountStEth_) internal returns (address order) {
        address cachedStonks = stonks;

        IERC20(address(STETH)).safeTransfer(cachedStonks, sellAmountStEth_);

        uint256 minBuyAmount = IStonks(cachedStonks).estimateTradeOutput(sellAmountStEth_);
        uint256 adjustedMinBuyAmount = (minBuyAmount *
            (MAX_BASIS_POINTS - orderPriceProtectionBps)) / MAX_BASIS_POINTS;

        order = IStonks(cachedStonks).placeOrderWithAmount(
            sellAmountStEth_ - STETH_TRANSFER_BUFFER,
            adjustedMinBuyAmount
        );
    }

    /*//////////////////////////////////////////////////////////////
                         INTERNAL VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Reverts with `CooldownNotElapsed` when the previous order's cooldown has not yet
     *         elapsed at the current block timestamp.
     */
    function _assertOrderCooldownElapsed() internal view {
        uint256 cachedLastOrder = _lastOrderTimestamp;
        uint256 cooldownEnd = cachedLastOrder + _orderDurationSeconds;
        if (block.timestamp < cooldownEnd) {
            revert CooldownNotElapsed(cachedLastOrder, cooldownEnd);
        }
    }

    /**
     * @notice Sums revenue from every non-paused registered source. Reverts with
     *         `RevenueSourceStale` on the first stale source, or with `NoActiveRevenueSources`
     *         when nothing is active. Used by `triggerExecution` and `getDailySurplus`. The
     *         non-reverting counterpart is `_trySimulateAggregateRevenue`.
     * @return totalDailyRevenueUSD Aggregated 1e18-scaled USD revenue across active sources.
     */
    function _aggregateRevenue() internal view returns (uint256 totalDailyRevenueUSD) {
        uint256 sourceCount = _revenueSources.length;
        uint256 activeSourceCount;

        for (uint256 i; i < sourceCount; ) {
            IRevenueSource source = IRevenueSource(_revenueSources[i]);
            if (!source.paused()) {
                (uint256 revenueUSD, uint256 reportTimestamp, bool isStale) = source.getRevenue();
                if (isStale) {
                    revert RevenueSourceStale(address(source), reportTimestamp);
                }
                totalDailyRevenueUSD += revenueUSD;

                unchecked {
                    ++activeSourceCount;
                }
            }
            unchecked {
                ++i;
            }
        }

        if (activeSourceCount == 0) {
            revert NoActiveRevenueSources();
        }
    }

    /**
     * @notice Non-reverting variant of `_aggregateRevenue` used by `canTriggerExecution`. Wraps
     *         every external call in try/catch and signals failure via `ok = false`.
     * @return totalRevenueUSD Aggregated 1e18-scaled USD revenue. Zero on failure.
     * @return ok `true` when every active source returned fresh data. `false` on any revert,
     *         any stale source, or when no source is active.
     */
    function _trySimulateAggregateRevenue()
        internal
        view
        returns (uint256 totalRevenueUSD, bool ok)
    {
        uint256 sourceCount = _revenueSources.length;
        uint256 activeSourceCount;

        for (uint256 i; i < sourceCount; ) {
            IRevenueSource source = IRevenueSource(_revenueSources[i]);
            bool isPaused;
            try source.paused() returns (bool paused) {
                isPaused = paused;
            } catch {
                return (0, false);
            }
            if (!isPaused) {
                try source.getRevenue() returns (uint256 revenueUSD, uint256, bool isStale) {
                    if (isStale) {
                        return (0, false);
                    }
                    totalRevenueUSD += revenueUSD;
                    unchecked {
                        ++activeSourceCount;
                    }
                } catch {
                    return (0, false);
                }
            }
            unchecked {
                ++i;
            }
        }

        if (activeSourceCount == 0) {
            return (0, false);
        }
        ok = true;
    }
}
