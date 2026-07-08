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
 * @notice Holds stETH and releases it to a receiver for buybacks, funded by a share of the
 *         protocol revenue that registered sources report. Anyone can trigger a release.
 */
contract BuybackAllocator is AssetRecovererACL {
    using SafeERC20 for IERC20;
    using MathHelpers for uint256;
    using EnumerableSet for EnumerableSet.AddressSet;

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /// @notice Whether a release can proceed, or why it is skipped. Reported in the skip event.
    enum AllocationStatus {
        // The release can proceed
        Eligible,
        // No budget available to spend
        NoAvailableBudget,
        // The oracle returned no price
        QuoteUnavailable,
        // The price is below the floor
        StEthPriceBelowMin,
        // The spendable amount is below the smallest allowed
        AllocationBelowMin,
        // The daily or yearly cap leaves no room
        WindowCapReached
    }

    /// @notice Daily or yearly spend window.
    struct SpendWindow {
        // When the current window ends and the spent total resets
        uint64 endTS;
        // USD spent within the current window
        uint192 spentUSD;
    }

    /// @notice Constructor inputs.
    struct ConstructorParams {
        // Initial admin role holder
        address admin;
        // Destination for recovered assets
        address treasury;
        // The stETH token
        address stEth;
        // Prices stETH in USD
        address oracleRouter;
        // Receives allocations
        address executor;
        // Maximum USD per day
        uint128 dailyCapUSD;
        // Maximum USD per year
        uint128 yearlyCapUSD;
        // USD reserved for the protocol each day
        uint128 reserveDailyRateUSD;
        // Lowest stETH price accepted
        uint128 minStEthPriceUSD;
        // Smallest allocation allowed
        uint128 minSpendPerCallUSD;
        // Share of the revenue surplus spendable, in basis points
        uint16 surplusShareBP;
        // Sources registered at deployment
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

    /// @notice Total revenue reported by all sources as of the last budget update. Later revenue is
    ///         measured against this baseline.
    uint256 public lastTotalRevenueUSD;

    /// @notice USD available for buybacks. Can go below zero when revenue lags behind the reserve.
    ///         A release then treats it as zero.
    int256 public budgetUSD;

    /// @notice Start of the day from which the current reserve builds up.
    uint256 public reserveAnchorTS;

    /// @notice Current day spend window: when it ends and the USD spent in it so far.
    SpendWindow public daily;

    /// @notice Current year spend window: when it ends and the USD spent in it so far.
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

    /**
     * @notice Sets dependencies, limits, and the initial revenue sources.
     * @dev    Activation is a separate step that must run before the first release.
     * @param  initParams_ See `ConstructorParams`.
     */
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

        lastTotalRevenueUSD = _revenueSumUSD();

        // Anchor the reserve to the activation day itself, so the activation day's reserve is charged
        // rather than forgiven (unlike the post-checkpoint re-anchor to the next day).
        reserveAnchorTS = activationTS;
        emit ReserveAnchored(reserveAnchorTS);

        _rollWindow(daily, ONE_DAY, 0);
        _rollWindow(yearly, ONE_YEAR, 0);

        emit Activated(alignedTS, lastTotalRevenueUSD);
    }

    /**
     * @notice Updates the budget, then sends the amount available now to the receiver. When nothing
     *         is eligible it emits a skip event and returns; the budget update still applies, so any
     *         caller advances the accounting even when no transfer happens.
     */
    function allocate() external nonReentrant whenActivated {
        _checkpoint();

        // Budget is current after the checkpoint above. Spend only its non-negative part.
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
     * @notice Sets the minimum stETH price. A lower price skips the release.
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
     * @notice Redirects all future allocations to a new receiver.
     * @param  newExecutor_ New receiver address.
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
     *         interface, or if it or any registered source cannot be reached.
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
     *         Reverts if any registered source cannot be reached, including the one being removed.
     *         Sources are trusted to always respond with a sane value. In an unlikely scenario where
     *         a source ever stops responding, buybacks are paused and the allocator is redeployed.
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
     * @notice Previews a release at the current moment, including revenue earned since the last
     *         budget update. Stays accurate however long ago that update was, so it is safe for
     *         off-chain monitoring.
     * @dev    Applies the same budget math and limits as a release, without changing state, so a
     *         release reproduces this result. Reverts before activation, or when any registered
     *         source cannot be reached.
     * @return status Whether a release proceeds, or why it is skipped.
     * @return spendableUSD USD a release spends now.
     * @return spendableStEth stETH a release transfers now.
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

    /**
     * @notice Banks the surplus share of new revenue, less the accrued reserve, into the signed
     *         budget, then records the new revenue baseline and restarts the reserve.
     * @dev    Runs even with no new revenue, so the budget can fall below zero.
     */
    function _checkpoint() internal {
        (int256 budgetDeltaUSD, uint256 totalRevenueUSD, uint256 reserveUSD) = _budgetable();

        budgetUSD += budgetDeltaUSD;
        lastTotalRevenueUSD = totalRevenueUSD;
        // Move the reserve cursor to the next day.
        reserveAnchorTS = _nextDayStartTS();
        emit ReserveAnchored(reserveAnchorTS);

        emit Checkpoint(lastTotalRevenueUSD, reserveUSD, budgetDeltaUSD, budgetUSD);
    }

    /**
     * @notice Rolls an ended window forward to the next activation-aligned boundary and resets its
     *         spent total, then adds this spend.
     * @param  window_ Spend window to update.
     * @param  windowDuration_ Window length in seconds.
     * @param  spendUSD_ USD spent to add to the window.
     */
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

    /**
     * @notice Validates and registers a revenue source, adding its current total to the baseline.
     * @param  source_ Revenue source to register.
     */
    function _addRevenueSource(address source_) internal {
        if (source_ == address(0)) {
            revert RevenueSourceZeroAddress();
        }
        if (!ERC165Checker.supportsInterface(source_, type(IRevenueSource).interfaceId)) {
            revert RevenueSourceUnsupported(source_);
        }
        if (_revenueSources.length() >= MAX_REVENUE_SOURCES) {
            revert RevenueSourceLimitReached(MAX_REVENUE_SOURCES);
        }
        if (!_revenueSources.add(source_)) {
            revert RevenueSourceAlreadyRegistered();
        }

        lastTotalRevenueUSD += IRevenueSource(source_).getCumulativeRevenueUSD();

        emit RevenueSourceAdded(source_);
    }

    /**
     * @notice Removes a revenue source and subtracts its current total from the baseline, so only
     *         the remaining sources' later growth counts.
     * @dev    Must run after a budget update, which captures this source's surplus up to now.
     *         Subtracting the same total keeps the remaining baseline exact and cannot underflow.
     * @param  source_ Revenue source to unregister.
     */
    function _removeRevenueSource(address source_) internal {
        if (!_revenueSources.remove(source_)) {
            revert RevenueSourceNotRegistered();
        }

        // removeRevenueSource() checkpoints first, so lastTotalRevenueUSD already includes this
        // source's current total — the subtraction is therefore exact and cannot underflow.
        lastTotalRevenueUSD -= IRevenueSource(source_).getCumulativeRevenueUSD();

        emit RevenueSourceRemoved(source_);
    }

    /**
     * @notice Validates and sets the receiver.
     * @param  executor_ New receiver address.
     */
    function _setExecutor(address executor_) internal {
        if (executor_ == address(0)) {
            revert ExecutorZeroAddress();
        }

        executor = executor_;

        emit ExecutorSet(executor_);
    }

    /**
     * @notice Validates and sets the yearly cap against the current daily cap.
     * @param  yearlyCapUSD_ New per-year spending cap in USD.
     */
    function _setYearlyCapUSD(uint128 yearlyCapUSD_) internal {
        if (yearlyCapUSD_ == 0) {
            revert YearlyCapUSDZero();
        }
        if (dailyCapUSD > yearlyCapUSD_) {
            revert DailyCapExceedsYearlyCap();
        }

        yearlyCapUSD = yearlyCapUSD_;

        emit YearlyCapUSDSet(yearlyCapUSD_);
    }

    /**
     * @notice Validates and sets the daily cap against the yearly cap and the minimum allocation.
     * @param  dailyCapUSD_ New per-day spending cap in USD.
     */
    function _setDailyCapUSD(uint128 dailyCapUSD_) internal {
        if (dailyCapUSD_ == 0) {
            revert DailyCapUSDZero();
        }
        if (dailyCapUSD_ > yearlyCapUSD) {
            revert DailyCapExceedsYearlyCap();
        }
        if (minSpendPerCallUSD > dailyCapUSD_) {
            revert MinSpendPerCallExceedsDailyCap();
        }

        dailyCapUSD = dailyCapUSD_;

        emit DailyCapUSDSet(dailyCapUSD_);
    }

    /**
     * @notice Validates and sets the minimum allocation per call against the daily cap.
     * @param  minSpendPerCallUSD_ New smallest allocation in USD.
     */
    function _setMinSpendPerCallUSD(uint128 minSpendPerCallUSD_) internal {
        if (minSpendPerCallUSD_ == 0) {
            revert MinSpendPerCallUSDZero();
        }
        if (minSpendPerCallUSD_ > dailyCapUSD) {
            revert MinSpendPerCallExceedsDailyCap();
        }

        minSpendPerCallUSD = minSpendPerCallUSD_;

        emit MinSpendPerCallUSDSet(minSpendPerCallUSD_);
    }

    /**
     * @notice Validates and sets the surplus share.
     * @param  surplusShareBP_ New surplus share in basis points.
     */
    function _setSurplusShareBP(uint16 surplusShareBP_) internal {
        if (surplusShareBP_ == 0 || surplusShareBP_ > MAX_BASIS_POINTS) {
            revert SurplusShareBPInvalid();
        }

        surplusShareBP = surplusShareBP_;

        emit SurplusShareBPSet(surplusShareBP_);
    }

    /**
     * @notice Sets the daily reserve rate.
     * @param  reserveDailyRateUSD_ New daily reserve rate in USD.
     */
    function _setReserveDailyRateUSD(uint128 reserveDailyRateUSD_) internal {
        reserveDailyRateUSD = reserveDailyRateUSD_;

        emit ReserveDailyRateUSDSet(reserveDailyRateUSD_);
    }

    /**
     * @notice Sets the minimum stETH price.
     * @param  minStEthPriceUSD_ New minimum stETH price in USD.
     */
    function _setMinStEthPriceUSD(uint128 minStEthPriceUSD_) internal {
        minStEthPriceUSD = minStEthPriceUSD_;

        emit MinStEthPriceUSDSet(minStEthPriceUSD_);
    }

    /*//////////////////////////////////////////////////////////////
                         INTERNAL VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Eligibility and the amounts a release produces from a given available amount, after the
     *         year cap, the day cap, the stETH balance, and the smallest allowed allocation.
     * @dev    Shared by the release path and the preview.
     * @param  availableUSD_ Spendable budget in USD.
     * @return status Whether a release proceeds, or why it is skipped.
     * @return spendableUSD USD a release spends.
     * @return spendableStEth stETH a release transfers.
     */
    function _spendable(
        uint256 availableUSD_
    )
        internal
        view
        returns (AllocationStatus status, uint256 spendableUSD, uint256 spendableStEth)
    {
        if (availableUSD_ == 0) {
            return (AllocationStatus.NoAvailableBudget, 0, 0);
        }

        // No usable price means no allocation.
        uint256 stEthPriceUSD = _getStEthPriceUSD();

        if (stEthPriceUSD == 0) {
            return (AllocationStatus.QuoteUnavailable, 0, 0);
        }

        // A price below the floor pauses allocations.
        if (stEthPriceUSD < minStEthPriceUSD) {
            return (AllocationStatus.StEthPriceBelowMin, 0, 0);
        }

        // Limit to the amount remaining under the year cap, then the day cap.
        spendableUSD = availableUSD_;
        spendableUSD = Math.min(spendableUSD, _windowUnspent(yearly, yearlyCapUSD));
        spendableUSD = Math.min(spendableUSD, _windowUnspent(daily, dailyCapUSD));
        // Year and day caps leave nothing.
        if (spendableUSD == 0) {
            return (AllocationStatus.WindowCapReached, 0, 0);
        }

        // Convert to stETH, limit to the balance, then restate the USD actually transferable.
        spendableStEth = Math.mulDiv(spendableUSD, PRICE_UNIT, stEthPriceUSD);
        spendableStEth = Math.min(spendableStEth, STETH.balanceOf(address(this)));
        spendableUSD = Math.mulDiv(spendableStEth, stEthPriceUSD, PRICE_UNIT);

        // Skip an amount below the smallest allowed allocation.
        if (spendableUSD < minSpendPerCallUSD) {
            return (AllocationStatus.AllocationBelowMin, 0, 0);
        }

        status = AllocationStatus.Eligible;
    }

    /**
     * @notice The signed budget change applied now, and the revenue total recorded as the new
     *         baseline. Change is (total revenue - baseline - reserve) * surplus share, and can be
     *         negative since the signed budget absorbs it.
     * @dev    The reserve sits inside the share-weighted term on purpose, so only the surplus share
     *         of revenue net of reserve is taken. This is intended, not a missing full subtraction.
     * @return budgetDeltaUSD Signed budget change in USD.
     * @return totalRevenueUSD New revenue baseline in USD.
     * @return reserveUSD Reserve accrued since the last update in USD.
     */
    function _budgetable()
        internal
        view
        returns (int256 budgetDeltaUSD, uint256 totalRevenueUSD, uint256 reserveUSD)
    {
        totalRevenueUSD = _revenueSumUSD();
        reserveUSD = _reserveCurrentUSD();
        int256 surplusUSD = int256(totalRevenueUSD) -
            int256(lastTotalRevenueUSD) -
            int256(reserveUSD);
        budgetDeltaUSD = (surplusUSD * int256(uint256(surplusShareBP))) / int256(MAX_BASIS_POINTS);
    }

    /**
     * @notice Clamps the signed net budget to a non-negative spendable amount.
     * @dev    A negative budget spends nothing but stays in storage, so later surplus must first
     *         lift it back above zero.
     * @param  budget_ Signed net budget.
     * @return Non-negative spendable amount.
     */
    function _clampBudget(int256 budget_) internal pure returns (uint256) {
        return budget_ > 0 ? uint256(budget_) : 0;
    }

    /**
     * @notice USD spent in the current window. Counts as zero once the window has ended.
     * @param  window_ Spend window to read.
     * @return spent USD spent in the current window.
     */
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

    /**
     * @notice Reserve accrued since it last restarted.
     * @dev    Zero until the next day begins, then one daily rate at the start of that day and one
     *         more at the start of each day after.
     * @return Reserve accrued in USD.
     */
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
     * @dev    Sources are trusted, so a source that cannot be reached makes the read revert rather
     *         than count as zero.
     * @return revenueSumUSD Total revenue across all sources in USD.
     */
    function _revenueSumUSD() internal view returns (uint256 revenueSumUSD) {
        address[] memory sources = _revenueSources.values();
        for (uint256 i; i < sources.length; ++i) {
            revenueSumUSD += IRevenueSource(sources[i]).getCumulativeRevenueUSD();
        }
    }

    /**
     * @notice Reads the stETH price in USD from the oracle.
     * @dev    Returns zero if the oracle reverts, which a release treats as no quote.
     * @return stEthPriceUSD stETH price in USD, or zero when unavailable.
     */
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
}
