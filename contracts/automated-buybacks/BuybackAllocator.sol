// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";

import {AssetRecovererACL} from "./AssetRecovererACL.sol";
import {IStETH} from "../interfaces/IStETH.sol";
import {IOracleRouter} from "../interfaces/IOracleRouter.sol";
import {IRevenueSource} from "../interfaces/IRevenueSource.sol";
import {IBuybackExecutor} from "../interfaces/IBuybackExecutor.sol";
import {MathHelpers} from "../lib/MathHelpers.sol";

/**
 * @title  BuybackAllocator
 * @notice Holds stETH and sends it to the executor for buybacks. The amount is determined
 *         by a share of the revenue surplus, as reported by the revenue sources.
 */
contract BuybackAllocator is AssetRecovererACL {
    using SafeERC20 for IERC20;
    using MathHelpers for uint256;
    using EnumerableSet for EnumerableSet.AddressSet;

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    enum AllocationStatus {
        Eligible,
        NoAvailableBudget,
        QuoteUnavailable,
        StEthPriceBelowMin,
        AllocationBelowMin,
        WindowCapReached
    }

    /// @notice Daily or yearly spend window.
    struct SpendWindow {
        uint64 endTS;
        uint192 spentUSD;
    }

    /// @notice Constructor inputs.
    struct ConstructorParams {
        address admin;
        address treasury;
        address stEth;
        address oracleRouter;
        address executor;
        uint128 dailyCapUSD;
        uint128 yearlyCapUSD;
        uint128 reserveDailyRateUSD;
        uint128 minStEthPriceUSD;
        uint128 minSpendPerCallUSD;
        uint16 surplusShareBP;
        address[] revenueSources;
    }

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice 100% in basis points.
    uint256 public constant MAX_BASIS_POINTS = 10_000;

    /// @notice Maximum number of revenue sources.
    uint256 public constant MAX_REVENUE_SOURCES = 50;

    uint256 internal constant ONE_DAY = 1 days;
    uint256 internal constant ONE_YEAR = 365 days;

    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice The stETH token.
    IStETH public immutable STETH;

    /// @notice Oracle that prices stETH in USD.
    IOracleRouter public immutable ORACLE_ROUTER;

    /// @dev Oracle price unit, used to convert between USD and stETH.
    uint256 internal immutable PRICE_UNIT;

    /*//////////////////////////////////////////////////////////////
                          CONFIGURABLE STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Maximum USD spendable per day.
    uint128 public dailyCapUSD;

    /// @notice Maximum USD spendable per year.
    uint128 public yearlyCapUSD;

    /// @notice USD reserved for the protocol each day. Only the surplus above it is spendable.
    uint128 public reserveDailyRateUSD;

    /// @notice Lowest stETH price accepted.
    uint128 public minStEthPriceUSD;

    /// @notice Smallest allocation allowed.
    uint128 public minSpendPerCallUSD;

    /// @notice Share of the revenue surplus spendable on buybacks, in basis points.
    uint16 public surplusShareBP;

    /// @notice Address that receives allocations.
    address public executor;

    /// @notice Midnight UTC of the day the contract was activated. Zero before activation.
    uint256 public activationTS;

    /// @notice Total revenue reported by all sources as of the last budget update.
    uint256 public lastTotalRevenueUSD;

    /// @notice USD available for buybacks. Negative value means debt against reserve.
    int256 public budgetUSD;

    /// @notice Start of the day from which the current reserve builds up.
    uint256 public reserveAnchorTS;

    /// @notice Current day spend window.
    SpendWindow public daily;

    /// @notice Current year spend window.
    SpendWindow public yearly;

    /// @dev Registered revenue sources.
    EnumerableSet.AddressSet internal _revenueSources;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event Activated(uint256 activationTS, uint256 lastTotalRevenueUSD);
    event Allocated(
        address indexed triggeredBy,
        address indexed executor,
        uint256 spendUSD,
        uint256 spendStEth
    );
    event AllocationSkipped(address indexed caller, AllocationStatus reason);
    event Checkpoint(
        uint256 lastTotalRevenueUSD,
        uint256 reserveUSD,
        int256 budgetDeltaUSD,
        int256 budgetUSD
    );
    event WindowRolled(uint256 windowDurationSeconds, uint256 newEndTS, uint256 previousSpentUSD);
    event ReserveAnchored(uint256 anchorTS);
    event ExecutorSet(address indexed executor);
    event DailyCapUSDSet(uint128 dailyCapUSD);
    event YearlyCapUSDSet(uint128 yearlyCapUSD);
    event ReserveDailyRateUSDSet(uint128 reserveDailyRateUSD);
    event MinStEthPriceUSDSet(uint128 minStEthPriceUSD);
    event MinSpendPerCallUSDSet(uint128 minSpendPerCallUSD);
    event SurplusShareBPSet(uint16 surplusShareBP);
    event RevenueSourceAdded(address indexed source);
    event RevenueSourceRemoved(address indexed source);

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error StEthZeroAddress();
    error OracleRouterZeroAddress();
    error ExecutorZeroAddress();
    error AlreadyActivated();
    error NotActivated();
    error SurplusShareBPInvalid();
    error DailyCapUSDZero();
    error YearlyCapUSDZero();
    error MinSpendPerCallUSDZero();
    error DailyCapExceedsYearlyCap();
    error MinSpendPerCallExceedsDailyCap();
    error RevenueSourceZeroAddress();
    error RevenueSourceUnsupported(address source);
    error RevenueSourceAlreadyRegistered();
    error RevenueSourceNotRegistered();
    error RevenueSourceLimitReached(uint256 maxSources);

    /*//////////////////////////////////////////////////////////////
                               MODIFIERS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Reverts until the contract is activated.
     */
    modifier whenActivated() {
        if (activationTS == 0) {
            revert NotActivated();
        }
        _;
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @notice Sets dependencies, limits, and the initial revenue sources.
    constructor(
        ConstructorParams memory initParams_
    ) AssetRecovererACL(initParams_.admin, initParams_.treasury) {
        if (initParams_.stEth == address(0)) {
            revert StEthZeroAddress();
        }
        if (initParams_.oracleRouter == address(0)) {
            revert OracleRouterZeroAddress();
        }

        STETH = IStETH(initParams_.stEth);
        ORACLE_ROUTER = IOracleRouter(initParams_.oracleRouter);

        // The USD<->stETH conversions scale by the oracle's own price unit.
        PRICE_UNIT = ORACLE_ROUTER.PRICE_UNIT();

        _setExecutor(initParams_.executor);
        _setYearlyCapUSD(initParams_.yearlyCapUSD);
        _setDailyCapUSD(initParams_.dailyCapUSD);
        _setMinSpendPerCallUSD(initParams_.minSpendPerCallUSD);
        _setSurplusShareBP(initParams_.surplusShareBP);
        _setMinStEthPriceUSD(initParams_.minStEthPriceUSD);
        _setReserveDailyRateUSD(initParams_.reserveDailyRateUSD);

        address[] memory sources = initParams_.revenueSources;
        for (uint256 i; i < sources.length; ++i) {
            _addRevenueSource(sources[i]);
        }
    }

    /*//////////////////////////////////////////////////////////////
                           EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Activates the contract once. Records current total revenue as the baseline, so only
     *         later revenue funds the budget, and starts the daily reserve accruing.
     * @dev    Reverts if any registered source cannot be reached.
     */
    function activate() external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (activationTS != 0) {
            revert AlreadyActivated();
        }

        uint256 alignedTS = _todayStartTS();
        activationTS = alignedTS;

        lastTotalRevenueUSD = _revenueSumStrictUSD();

        // Anchor the reserve to the activation day, so the reserve is charged from that day.
        reserveAnchorTS = activationTS;
        emit ReserveAnchored(reserveAnchorTS);

        _rollWindow(daily, ONE_DAY, 0);
        _rollWindow(yearly, ONE_YEAR, 0);

        emit Activated(alignedTS, lastTotalRevenueUSD);
    }

    /**
     * @notice Updates the budget, then sends the amount available to the receiver. When nothing
     *         is eligible it emits a skip event and returns; the budget update still applies even
     *         when no stETH is sent.
     */
    function allocate() external nonReentrant whenActivated {
        _checkpoint();

        uint256 availableUSD = _clampBudget(budgetUSD);
        (AllocationStatus status, uint256 spendUSD, uint256 spendStEth) = _spendable(availableUSD);

        if (status != AllocationStatus.Eligible) {
            emit AllocationSkipped(msg.sender, status);
            return;
        }

        budgetUSD -= int256(spendUSD);

        _rollWindow(yearly, ONE_YEAR, spendUSD);
        _rollWindow(daily, ONE_DAY, spendUSD);

        IERC20(address(STETH)).safeTransfer(executor, spendStEth);

        emit Allocated(msg.sender, executor, spendUSD, spendStEth);

        IBuybackExecutor(executor).onStEthAllocated();
    }

    /**
     * @notice Sets the share of the revenue surplus spendable on buybacks, in basis points.
     * @dev    Updates the budget at the current share first, so the new share applies only to
     *         revenue earned after this call. Budget already accrued is unaffected.
     * @param  surplusShareBP_ New surplus share in basis points.
     */
    function setSurplusShareBP(
        uint16 surplusShareBP_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) whenActivated {
        _checkpoint();
        _setSurplusShareBP(surplusShareBP_);
    }

    /**
     * @notice Sets the daily reserve rate.
     * @dev    Updates the budget at the current rate first, so the new rate applies only to days
     *         after this call.
     * @param  reserveDailyRateUSD_ New daily reserve rate in USD.
     */
    function setReserveDailyRateUSD(
        uint128 reserveDailyRateUSD_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) whenActivated {
        _checkpoint();
        _setReserveDailyRateUSD(reserveDailyRateUSD_);
    }

    /**
     * @notice Sets the per-day spending cap. Applies to the window in progress.
     * @param  dailyCapUSD_ New per-day spending cap in USD.
     */
    function setDailyCapUSD(uint128 dailyCapUSD_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setDailyCapUSD(dailyCapUSD_);
    }

    /**
     * @notice Sets the per-year spending cap. Applies to the window in progress.
     * @param  yearlyCapUSD_ New per-year spending cap in USD.
     */
    function setYearlyCapUSD(uint128 yearlyCapUSD_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setYearlyCapUSD(yearlyCapUSD_);
    }

/**
 * @notice Sets the minimum stETH price; a lower price skips the allocation.
 * @param  minStEthPriceUSD_ New minimum stETH price in USD.
 */
function setMinStEthPriceUSD(uint128 minStEthPriceUSD_) external onlyRole(DEFAULT_ADMIN_ROLE) {
    _setMinStEthPriceUSD(minStEthPriceUSD_);
}

    /**
     * @notice Sets the smallest allocation allowed. Smaller amounts are skipped.
     * @param  minSpendPerCallUSD_ New smallest allocation in USD.
     */
    function setMinSpendPerCallUSD(
        uint128 minSpendPerCallUSD_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setMinSpendPerCallUSD(minSpendPerCallUSD_);
    }

    /**
     * @notice Set a new executor that receives allocations.
     */
    function setExecutor(address newExecutor_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setExecutor(newExecutor_);
    }

    /**
     * @notice Registers a revenue source. Its current total is added to the baseline, so only its
     *         later earnings fund the budget.
     * @dev    Updates the budget first, banking revenue earned up to now, then adds the source's
     *         current total to the baseline. Sources are trusted to report accurate USD totals (18
     *         decimals) that only go up. Reverts if the source does not support the required
     *         interface or cannot be reached.
     * @param  source_ Revenue source to register.
     */
    function addRevenueSource(address source_) external onlyRole(DEFAULT_ADMIN_ROLE) whenActivated {
        _checkpoint();
        _addRevenueSource(source_);
    }

    /**
     * @notice Unregisters a revenue source. Budget already accrued from it stays.
     * @dev    Updates the budget first, capturing the source's surplus up to now, then subtracts its
     *         current total from the baseline so the remaining sources stay measured correctly.
     *         Reverts if the source cannot be reached.
     * @param  source_ Revenue source to unregister.
     */
    function removeRevenueSource(
        address source_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) whenActivated {
        _checkpoint();
        _removeRevenueSource(source_);
    }

    /*//////////////////////////////////////////////////////////////
                         EXTERNAL VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Returns what an allocation would spend and transfer right now, including revenue
     *         earned since the last budget update. Stays accurate however long ago that update was.
     * @dev    Applies the same budget math and limits as an allocation, without changing state, so
     *         an allocation reproduces this result. Reverts before activation.
     * @return status         whether an allocation would proceed, or why it would be skipped
     * @return spendableUSD   USD an allocation would spend now
     * @return spendableStEth stETH an allocation would transfer now
     */
    function spendable()
        external
        view
        whenActivated
        returns (AllocationStatus status, uint256 spendableUSD, uint256 spendableStEth)
    {
        (int256 budgetDeltaUSD, , ) = _budgetable();
        return _spendable(_clampBudget(budgetUSD + budgetDeltaUSD));
    }

    /*//////////////////////////////////////////////////////////////
                           INTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @dev Applies the change since the last update to the signed budget, records the new revenue
    ///      baseline, and restarts the reserve. Runs even with no new revenue, so the budget can
    ///      fall below zero. A source that reverts on one read counts as zero that time and recovers
    ///      on the next; because each update measures only the change since the last baseline, a
    ///      missed read is absorbed and never double-counted.
    function _checkpoint() internal {
        (int256 budgetDeltaUSD, uint256 totalRevenueUSD, uint256 reserveUSD) = _budgetable();

        budgetUSD += budgetDeltaUSD;
        lastTotalRevenueUSD = totalRevenueUSD;
        // restart the reserve from the next day
        reserveAnchorTS = _nextDayStartTS();
        emit ReserveAnchored(reserveAnchorTS);

        emit Checkpoint(lastTotalRevenueUSD, reserveUSD, budgetDeltaUSD, budgetUSD);
    }

    /// @dev Eligibility and the amounts an allocation would produce from a given available amount,
    ///      after applying the year cap, the day cap, the stETH balance, and the smallest allowed
    ///      allocation.
    function _spendable(
        uint256 availableUSD_
    ) internal view returns (AllocationStatus status, uint256 spendableUSD, uint256 spendableStEth) {
        if (availableUSD_ == 0) {
            return (AllocationStatus.NoAvailableBudget, 0, 0);
        }

        // no usable price means no allocation
        uint256 stEthPriceUSD = _getStEthPriceUSD();

        if (stEthPriceUSD == 0) {
            return (AllocationStatus.QuoteUnavailable, 0, 0);
        }

        // a price below the minimum means no allocation
        if (stEthPriceUSD < minStEthPriceUSD) {
            return (AllocationStatus.StEthPriceBelowMin, 0, 0);
        }

        // limit to the amount remaining under the year cap, then the day cap
        spendableUSD = availableUSD_;
        spendableUSD = Math.min(spendableUSD, _windowUnspent(yearly, yearlyCapUSD));
        spendableUSD = Math.min(spendableUSD, _windowUnspent(daily, dailyCapUSD));
        // year/day caps leave nothing
        if (spendableUSD == 0) {
            return (AllocationStatus.WindowCapReached, 0, 0);
        }

        // convert to stETH, limit to the balance, then restate the USD actually transferable
        spendableStEth = Math.mulDiv(spendableUSD, PRICE_UNIT, stEthPriceUSD);
        spendableStEth = Math.min(spendableStEth, STETH.balanceOf(address(this)));
        spendableUSD = Math.mulDiv(spendableStEth, stEthPriceUSD, PRICE_UNIT);

        // skip an amount below the smallest allowed allocation
        if (spendableUSD < minSpendPerCallUSD) {
            return (AllocationStatus.AllocationBelowMin, 0, 0);
        }

        status = AllocationStatus.Eligible;
    }

    /// @dev The signed change a budget update would apply now, and the revenue total it would record
    ///      as the new baseline. Change = (total revenue - baseline - reserve) * surplus share.
    function _budgetable()
        internal
        view
        returns (int256 budgetDeltaUSD, uint256 totalRevenueUSD, uint256 reserveUSD)
    {
        totalRevenueUSD = _revenueSumUSD();
        reserveUSD = _reserveCurrentUSD();
        int256 surplusUSD = int256(totalRevenueUSD) - int256(lastTotalRevenueUSD) - int256(reserveUSD);
        budgetDeltaUSD = (surplusUSD * int256(uint256(surplusShareBP))) / int256(MAX_BASIS_POINTS);
    }

    /// @dev Clamps the signed net budget to a non-negative spendable amount.
    function _clampBudget(int256 budget_) internal pure returns (uint256) {
        return budget_ > 0 ? uint256(budget_) : 0;
    }

    /// @dev Rolls the window forward to the next boundary aligned to activation midnight if it has
    ///      ended, resetting the spent total, then adds this spend.
    function _rollWindow(
        SpendWindow storage window_,
        uint256 windowDuration_,
        uint256 spendUSD_
    ) internal {
        uint192 spent = window_.spentUSD;
        if (block.timestamp >= window_.endTS) {
            uint64 newEndTS = uint64(
                activationTS +
                    ((block.timestamp - activationTS) / windowDuration_ + 1) *
                    windowDuration_
            );

            emit WindowRolled(windowDuration_, newEndTS, spent);

            window_.endTS = newEndTS;
            spent = 0;
        }
        window_.spentUSD = spent + uint192(spendUSD_);
    }

    /// @dev The amount in the window in progress.
    function _windowSpent(SpendWindow storage window_) internal view returns (uint256 spent) {
        spent = block.timestamp >= window_.endTS ? 0 : uint256(window_.spentUSD);
    }

    /**
     * @notice The amount remaining under the cap for the current window.
     * @param  window_ Spend window to read.
     * @param  cap_ Window spending cap in USD.
     * @return unspent USD remaining under the cap.
     */
    function _windowUnspent(
        SpendWindow storage window_,
        uint256 cap_
    ) internal view returns (uint256 unspent) {
        unspent = cap_.saturatedSub(_windowSpent(window_));
    }

    /// @dev Reserve accrued since it last updated.
    function _reserveCurrentUSD() internal view returns (uint256) {
        if (block.timestamp < reserveAnchorTS) {
            return 0;
        }

        uint256 daysSinceAnchor = (block.timestamp - reserveAnchorTS) / ONE_DAY;
        uint256 reserveDaysCharged = daysSinceAnchor + 1; // Anchor day plus each full day since.
        return uint256(reserveDailyRateUSD) * reserveDaysCharged;
    }

    /**
     * @notice Sums revenue across all sources. Reverts if any cannot be reached.
     * @return revenueSumUSD Total revenue across all sources in USD.
     */
    function _revenueSumStrictUSD() internal view returns (uint256 revenueSumUSD) {
        address[] memory sources = _revenueSources.values();
        for (uint256 i; i < sources.length; ++i) {
            revenueSumUSD += IRevenueSource(sources[i]).getCumulativeRevenueUSD();
        }
    }

    /**
     * @notice Sums revenue across all sources. A reverting source counts as zero.
     * @return revenueSumUSD Total revenue across all sources in USD.
     */
    function _revenueSumUSD() internal view returns (uint256 revenueSumUSD) {
        address[] memory sources = _revenueSources.values();
        for (uint256 i; i < sources.length; ++i) {
            try IRevenueSource(sources[i]).getCumulativeRevenueUSD() returns (uint256 revenue) {
                revenueSumUSD += revenue;
            } catch {}
        }
    }

    /// @dev Reads the stETH price in USD from the oracle.
    function _getStEthPriceUSD() internal view returns (uint256 stEthPriceUSD) {
        try ORACLE_ROUTER.getUsdPrices(address(STETH), address(STETH)) returns (
            uint256 stEthPrice,
            uint256
        ) {
            stEthPriceUSD = stEthPrice;
        } catch {}
    }

    /**
     * @notice Rounds the current block down to midnight UTC.
     * @return Midnight UTC of the current day.
     */
    function _todayStartTS() internal view returns (uint256) {
        return (block.timestamp / ONE_DAY) * ONE_DAY;
    }

    /**
     * @notice Midnight UTC at the start of the day after the current block.
     * @return Midnight UTC of the next day.
     */
    function _nextDayStartTS() internal view returns (uint256) {
        return _todayStartTS() + ONE_DAY;
    }

    /// @dev Validates and registers a revenue source, adding its current total to the baseline.
    function _addRevenueSource(address source_) internal {
        if (source_ == address(0)) revert RevenueSourceZeroAddress();

        if (!ERC165Checker.supportsInterface(source_, type(IRevenueSource).interfaceId)) {
            revert RevenueSourceUnsupported(source_);
        }

        if (_revenueSources.length() >= MAX_REVENUE_SOURCES) {
            revert RevenueSourceLimitReached(MAX_REVENUE_SOURCES);
        }

        if (!_revenueSources.add(source_)) revert RevenueSourceAlreadyRegistered();

        lastTotalRevenueUSD += IRevenueSource(source_).getCumulativeRevenueUSD();

        emit RevenueSourceAdded(source_);
    }

    /// @dev Removes a revenue source and subtracts its current total from the baseline, so only the
    ///      remaining sources' later growth counts. Must run after a checkpoint to prevent underflow.
    function _removeRevenueSource(address source_) internal {
        if (!_revenueSources.remove(source_)) revert RevenueSourceNotRegistered();

        // the budget update before this already added this source's total to the baseline, so
        // subtracting the same total now cannot underflow.
        lastTotalRevenueUSD -= IRevenueSource(source_).getCumulativeRevenueUSD();

        emit RevenueSourceRemoved(source_);
    }

    /// @dev Validates and sets the receiver.
    function _setExecutor(address executor_) internal {
        if (executor_ == address(0)) revert ExecutorZeroAddress();
        executor = executor_;
        emit ExecutorSet(executor_);
    }

    /// @dev Validates and sets the yearly cap.
    function _setYearlyCapUSD(uint128 yearlyCapUSD_) internal {
        if (yearlyCapUSD_ == 0) revert YearlyCapUSDZero();
        if (dailyCapUSD > yearlyCapUSD_) revert DailyCapExceedsYearlyCap();
        yearlyCapUSD = yearlyCapUSD_;
        emit YearlyCapUSDSet(yearlyCapUSD_);
    }

    /// @dev Validates and sets the daily cap.
    function _setDailyCapUSD(uint128 dailyCapUSD_) internal {
        if (dailyCapUSD_ == 0) revert DailyCapUSDZero();
        if (dailyCapUSD_ > yearlyCapUSD) revert DailyCapExceedsYearlyCap();
        if (minSpendPerCallUSD > dailyCapUSD_) revert MinSpendPerCallExceedsDailyCap();
        dailyCapUSD = dailyCapUSD_;
        emit DailyCapUSDSet(dailyCapUSD_);
    }

    /// @dev Validates and sets the minimum allocation per call.
    function _setMinSpendPerCallUSD(uint128 minSpendPerCallUSD_) internal {
        if (minSpendPerCallUSD_ == 0) revert MinSpendPerCallUSDZero();
        if (minSpendPerCallUSD_ > dailyCapUSD) revert MinSpendPerCallExceedsDailyCap();
        minSpendPerCallUSD = minSpendPerCallUSD_;
        emit MinSpendPerCallUSDSet(minSpendPerCallUSD_);
    }

    /// @dev Validates and sets the surplus share.
    function _setSurplusShareBP(uint16 surplusShareBP_) internal {
        if (surplusShareBP_ == 0 || surplusShareBP_ > MAX_BASIS_POINTS)
            revert SurplusShareBPInvalid();
        surplusShareBP = surplusShareBP_;
        emit SurplusShareBPSet(surplusShareBP_);
    }

    /// @dev Sets the daily reserve rate.
    function _setReserveDailyRateUSD(uint128 reserveDailyRateUSD_) internal {
        reserveDailyRateUSD = reserveDailyRateUSD_;
        emit ReserveDailyRateUSDSet(reserveDailyRateUSD_);
    }

    /// @dev Sets the minimum stETH price.
    function _setMinStEthPriceUSD(uint128 minStEthPriceUSD_) internal {
        minStEthPriceUSD = minStEthPriceUSD_;
        emit MinStEthPriceUSDSet(minStEthPriceUSD_);
    }
}
