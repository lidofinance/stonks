// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
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
 * @notice Holds stETH and releases it to a receiver for buybacks, funded by the protocol revenue
 *         that registered sources report. Anyone can trigger a release.
 */
contract BuybackAllocator is AssetRecovererACL, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using MathHelpers for uint256;
    using EnumerableSet for EnumerableSet.AddressSet;

    enum AllocationStatus {
        Eligible, 
        NoAvailableBudget,
        QuoteUnavailable,
        StEthPriceBelowMin,
        AllocationBelowMin,
        NotActivated
    }

    struct SpendWindow {
        uint64 endTS; 
        uint192 spentUSD;
    }

    struct ConstructorParams {
        address admin;
        address treasury; 
        address stEth; 
        address oracleRouter; 
        address executor; 
        uint128 dailyCapUSD;
        uint128 yearlyCapUSD;
        uint128 minStEthPriceUSD;
        uint128 minSpendPerCallUSD;
        uint16 surplusShareBP;
        address[] revenueSources;
    }

    /// @notice 100% in basis points.
    uint256 public constant MAX_BASIS_POINTS = 10_000;

    /// @notice The max number of revenue sources.
    uint256 public constant MAX_REVENUE_SOURCES = 50;

    uint256 internal constant PRICE_SCALE = 1e18;
    uint256 internal constant ONE_DAY = 1 days;
    uint256 internal constant ONE_YEAR = 365 days;

    /// @notice StETH token address.
    IStETH public immutable STETH;

    /// @notice Oracle that prices stETH in USD.
    IOracleRouter public immutable ORACLE_ROUTER;

    /// @notice Maximum USD spendable per day.
    uint128 public dailyCapUSD;

    /// @notice Maximum USD spendable per year.
    uint128 public yearlyCapUSD;

    /// @notice USD reserved for the protocol each day; only the surplus above it is spendable.
    uint128 public reserveDailyRateUSD;

    /// @notice Lowest stETH price accepted.
    uint128 public minStEthPriceUSD;

    /// @notice Smallest allocation allowed.
    uint128 public minSpendPerCallUSD;

    /// @notice Share of the revenue surplus spendable on buybacks, in basis points.
    uint16 public surplusShareBP;

    /// @notice Address that receives allocations.
    address public executor;

    /// @notice Timestamp of allocator activation.
    uint256 public activationTS;

    /// @notice Total revenue reported by all sources as of the last time surplus was set aside.
    uint256 public lastTotalRevenueUSD;

    /// @notice USD set aside for buybacks and not yet released.
    uint256 public budgetUSD;

    /// @notice Start of the day from which the current reserve builds up.
    uint256 public reserveAnchorTS;

    /// @notice USD spent within the current day window.
    SpendWindow public daily;

    /// @notice USD spent within the current year window.
    SpendWindow public yearly;

    EnumerableSet.AddressSet internal _revenueSources;

    event Activated(uint256 activationTS, uint256 lastTotalRevenueUSD);
    event Allocated(
        address indexed triggeredBy,
        address indexed executor,
        uint256 spendUSD,
        uint256 spendStEth
    );
    event AllocationSkipped(address indexed caller, AllocationStatus reason);
    event Checkpointed(
        uint256 lastTotalRevenueUSD,
        uint256 reserveUSD,
        uint256 budgetableUSD,
        uint256 budgetUSD,
        uint256 reserveAnchorTS
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

    error StEthZeroAddress();
    error OracleRouterZeroAddress();
    error ExecutorZeroAddress();
    error AlreadyActivated();
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

    constructor(
        ConstructorParams memory initParams_
    ) AssetRecovererACL(initParams_.admin, initParams_.treasury) {
        if (initParams_.stEth == address(0)) revert StEthZeroAddress();
        if (initParams_.oracleRouter == address(0)) revert OracleRouterZeroAddress();

        STETH = IStETH(initParams_.stEth);
        ORACLE_ROUTER = IOracleRouter(initParams_.oracleRouter);

        _setExecutor(initParams_.executor);
        _setYearlyCapUSD(initParams_.yearlyCapUSD);
        _setDailyCapUSD(initParams_.dailyCapUSD);
        _setMinSpendPerCallUSD(initParams_.minSpendPerCallUSD);
        _setSurplusShareBP(initParams_.surplusShareBP);
        _setMinStEthPriceUSD(initParams_.minStEthPriceUSD);

        address[] memory sources = initParams_.revenueSources;
        for (uint256 i = 0; i < sources.length; ++i) {
            _addRevenueSource(sources[i]);
        }
    }

    /**
     * @notice Activates the contract once. Records revenue earned so far as the baseline, so only
     *         later revenue counts.
     * @param  reserveDailyRateUSD_ USD reserved for the protocol each day
     * @dev    Reverts if any registered source cannot be reached.
     */
    function activate(uint128 reserveDailyRateUSD_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (activationTS != 0) revert AlreadyActivated();

        uint256 alignedTS = _todayStartTS();
        activationTS = alignedTS;

        lastTotalRevenueUSD = _revenueSumStrictUSD();

        _setReserveDailyRateUSD(reserveDailyRateUSD_);

        _rollWindow(daily, ONE_DAY, 0);
        _rollWindow(yearly, ONE_YEAR, 0);

        emit Activated(alignedTS, lastTotalRevenueUSD);
    }

    /**
     * @notice Sets aside newly earned surplus, then sends the amount available now to the
     *         receiver. When nothing is eligible it records a skip and returns. The set-aside
     *         still stands, so anyone calling this moves the available amount forward even when
     *         it does not pay out.
     */
    function allocate() external nonReentrant {
        _checkpoint();

        // the set-aside above already banked pending surplus, so spend from the committed amount
        (AllocationStatus status, uint256 spendUSD, uint256 spendStEth) = _spendable(budgetUSD);

        if (status != AllocationStatus.Eligible) {
            emit AllocationSkipped(msg.sender, status);
            return;
        }

        budgetUSD -= spendUSD;
        
        _rollWindow(yearly, ONE_YEAR, spendUSD);
        _rollWindow(daily, ONE_DAY, spendUSD);

        IERC20(address(STETH)).safeTransfer(executor, spendStEth);

        emit Allocated(msg.sender, executor, spendUSD, spendStEth);

        IBuybackExecutor(executor).onStEthAllocated();
    }

    /**
     * @notice Sets the share of the revenue surplus set aside for buybacks.
     * @dev    Sets aside the surplus earned so far at the current share before changing it, so the
     *         new share applies only to surplus set aside later. Anything already set aside stays.
     */
    function setSurplusShareBP(uint16 surplusShareBP_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _checkpoint();
        _setSurplusShareBP(surplusShareBP_);
    }

    /**
     * @notice Sets the daily reserve rate, effective from the next day onward.
     * @dev    Restarts the reserve count from the next day at the new rate. Reserve that was
     *         building up since the last set-aside is dropped, so that slice of revenue becomes
     *         spendable at the next set-aside.
     */
    function setReserveDailyRateUSD(
        uint128 reserveDailyRateUSD_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setReserveDailyRateUSD(reserveDailyRateUSD_);
    }

    /**
     * @notice Sets the per-day spending cap, including the window in progress.
     */
    function setDailyCapUSD(uint128 dailyCapUSD_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setDailyCapUSD(dailyCapUSD_);
    }

    /**
     * @notice Sets the per-year spending cap, including the window in progress.
     */
    function setYearlyCapUSD(uint128 yearlyCapUSD_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setYearlyCapUSD(yearlyCapUSD_);
    }

    /// @notice Sets the minimum stETH price; price below it skips the allocation.
    function setMinStEthPriceUSD(uint128 minStEthPriceUSD_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setMinStEthPriceUSD(minStEthPriceUSD_);
    }

    /// @notice Sets the smallest allocation allowed; smaller amounts are skipped.
    function setMinSpendPerCallUSD(
        uint128 minSpendPerCallUSD_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setMinSpendPerCallUSD(minSpendPerCallUSD_);
    }

    /**
     * @notice Redirects all future allocations to a new receiver.
     */
    function setExecutor(address newExecutor_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setExecutor(newExecutor_);
    }

    /**
     * @notice Registers a revenue source. After activation its current total is added to the
     *         baseline, so only later earnings count.
     * @dev    Sources are trusted to report accurate USD totals that only go up (18 decimals).
     *         Reverts if the source cannot be reached.
     */
    function addRevenueSource(address source_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _addRevenueSource(source_);
    }

    /**
     * @notice Unregisters a revenue source. After activation its total is subtracted from the
     *         baseline, so its past contribution stays counted.
     * @dev    Reverts if the source cannot be reached.
     */
    function removeRevenueSource(address source_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _removeRevenueSource(source_);
    }

    /**
     * @notice Returns the eligibility and the amount a release would send right now, in USD and
     *         stETH, with revenue earned since the last set-aside included. Safe for off-chain
     *         monitoring: the result stays current no matter how long ago the last set-aside was.
     * @dev    Applies the same set-aside math a release would, then the same limits, without
     *         changing state. A release reproduces this result.
     */
    function spendable()
        public
        view
        returns (AllocationStatus status, uint256 spendableUSD, uint256 spendableStEth)
    {
        uint256 availableUSD = budgetUSD;

        if (activationTS != 0) {
            (uint256 budgetableUSD, , ) = _budgetable();
            availableUSD += budgetableUSD;
        }

        return _spendable(availableUSD);
    }

    /// @dev Sets aside the surplus earned since the last set-aside, then moves the baseline up to
    ///      the current total and restarts the reserve count. Does nothing when there is nothing to
    ///      add above the reserve that built up, so the reserve carries over and a growing reserve
    ///      can never reduce an amount already set aside.
    function _checkpoint() internal {
        if (activationTS == 0) return;

        (uint256 budgetableUSD, uint256 reserveUSD, uint256 totalRevenueUSD) = _budgetable();
        if (budgetableUSD == 0) return;

        budgetUSD += budgetableUSD;
        lastTotalRevenueUSD = totalRevenueUSD;
        reserveAnchorTS = _nextDayStartTS();

        emit Checkpointed(lastTotalRevenueUSD, reserveUSD, budgetableUSD, budgetUSD, reserveAnchorTS);
    }

    /// @dev Eligibility and amounts a release would produce from a given available amount, after
    ///      the year cap, the day cap, the stETH balance, and the smallest allowed allocation.
    ///      Shared by the committed read and the live preview.
    function _spendable(
        uint256 availableUSD
    ) internal view returns (AllocationStatus status, uint256 spendableUSD, uint256 spendableStEth) {
        // nothing can be allocated before activation
        if (activationTS == 0) {
            return (AllocationStatus.NotActivated, 0, 0);
        }

        // no usable price means no allocation
        uint256 stEthPriceUSD = _getStEthPriceUSD();

        if (stEthPriceUSD == 0) {
            return (AllocationStatus.QuoteUnavailable, 0, 0);
        }

        // a price below the floor pauses allocations
        if (minStEthPriceUSD > stEthPriceUSD) {
            return (AllocationStatus.StEthPriceBelowMin, 0, 0);
        }

        spendableUSD = availableUSD;
        if (spendableUSD == 0) {
            return (AllocationStatus.NoAvailableBudget, 0, 0);
        }

        // limit to the amount remaining under the year cap, then the day cap
        spendableUSD = Math.min(spendableUSD, _windowUnspent(yearly, yearlyCapUSD));
        spendableUSD = Math.min(spendableUSD, _windowUnspent(daily, dailyCapUSD));
        if (spendableUSD == 0) {
            return (AllocationStatus.NoAvailableBudget, 0, 0);
        }

        // convert to stETH, limit to the balance, then restate the USD actually transferable
        spendableStEth = Math.mulDiv(spendableUSD, PRICE_SCALE, stEthPriceUSD);
        spendableStEth = Math.min(spendableStEth, STETH.balanceOf(address(this)));
        spendableUSD = Math.mulDiv(spendableStEth, stEthPriceUSD, PRICE_SCALE);

        // skip an amount below the smallest allowed allocation
        if (spendableUSD < minSpendPerCallUSD) {
            return (AllocationStatus.AllocationBelowMin, 0, 0);
        }

        status = AllocationStatus.Eligible;
    }

    function _budgetable()
        internal
        view
        returns (uint256 budgetableUSD, uint256 reserveUSD, uint256 totalRevenueUSD)
    {
        totalRevenueUSD = _revenueSumUSD();
        reserveUSD = _reserveCurrentUSD();
        uint256 earnedUSD = totalRevenueUSD.saturatedSub(lastTotalRevenueUSD);

        if (earnedUSD > reserveUSD) {
            budgetableUSD = _mulBP(earnedUSD - reserveUSD, surplusShareBP);
        }
    }

    /// @dev Advances a fixed period from the activation midnight.
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

    /// @dev Counts as zero once the window has ended.
    function _windowSpent(SpendWindow storage window_) internal view returns (uint256 spent) {
        spent = block.timestamp >= window_.endTS ? 0 : uint256(window_.spentUSD);
    }

    /// @dev The amount remaining under the cap for the current window.
    function _windowUnspent(
        SpendWindow storage window_,
        uint256 cap_
    ) internal view returns (uint256 unspent) {
        unspent = cap_.saturatedSub(_windowSpent(window_));
    }

    /// @dev Reserve built up since the count last restarted. Zero for the rest of the day the
    ///      count restarted, then one daily rate for each full day after, counted in full the
    ///      moment that day begins.
    function _reserveCurrentUSD() internal view returns (uint256) {
        if (block.timestamp < reserveAnchorTS) return 0;
        uint256 elapsedDays = (block.timestamp - reserveAnchorTS) / ONE_DAY;
        return uint256(reserveDailyRateUSD) * (elapsedDays + 1);
    }

    /// @dev Sums revenue across all sources; reverts if any cannot be reached.
    function _revenueSumStrictUSD() internal view returns (uint256 revenueSumUSD) {
        address[] memory sources = _revenueSources.values();
        for (uint256 i = 0; i < sources.length; ++i) {
            revenueSumUSD += IRevenueSource(sources[i]).getCumulativeRevenueUSD();
        }
    }

    /// @dev Sums revenue across all sources; a reverting source counts as zero.
    function _revenueSumUSD() internal view returns (uint256 revenueSumUSD) {
        address[] memory sources = _revenueSources.values();
        for (uint256 i = 0; i < sources.length; ++i) {
            try IRevenueSource(sources[i]).getCumulativeRevenueUSD() returns (uint256 revenue) {
                revenueSumUSD += revenue;
            } catch {}
        }
    }

    /// @dev Gets the stEth price from an oracle.
    function _getStEthPriceUSD() internal view returns (uint256 stEthPriceUSD) {
        try ORACLE_ROUTER.getUsdPrices(address(STETH), address(STETH)) returns (
            uint256 stEthPrice,
            uint256
        ) {
            stEthPriceUSD = stEthPrice;
        } catch {}
    }

    /// @dev Rounds down to midnight UTC.
    function _todayStartTS() internal view returns (uint256) {
        return (block.timestamp / ONE_DAY) * ONE_DAY;
    }

    /// @dev Midnight UTC at the start of the day after the current block.
    function _nextDayStartTS() internal view returns (uint256) {
        return (block.timestamp / ONE_DAY + 1) * ONE_DAY;
    }

    /// @dev Multiplies a value by a basis-point share.
    function _mulBP(uint256 number_, uint256 bp_) internal pure returns (uint256) {
        return Math.mulDiv(number_, bp_, MAX_BASIS_POINTS);
    }

    /// @dev Validates and registers a revenue source, adjusting the baseline.
    function _addRevenueSource(address source_) internal {
        if (source_ == address(0)) revert RevenueSourceZeroAddress();

        if (!ERC165Checker.supportsInterface(source_, type(IRevenueSource).interfaceId)) {
            revert RevenueSourceUnsupported(source_);
        }

        if (_revenueSources.length() >= MAX_REVENUE_SOURCES) {
            revert RevenueSourceLimitReached(MAX_REVENUE_SOURCES);
        }

        if (!_revenueSources.add(source_)) revert RevenueSourceAlreadyRegistered();

        if (activationTS != 0) {
            lastTotalRevenueUSD += IRevenueSource(source_).getCumulativeRevenueUSD();
        }

        emit RevenueSourceAdded(source_);
    }

    /// @dev Removes a revenue source, adjusting the baseline.
    function _removeRevenueSource(address source_) internal {
        if (!_revenueSources.remove(source_)) revert RevenueSourceNotRegistered();

        if (activationTS != 0) {
            lastTotalRevenueUSD = lastTotalRevenueUSD.saturatedSub(
                IRevenueSource(source_).getCumulativeRevenueUSD()
            );
        }

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

    /// @dev Sets the daily reserve rate. After activation, restarts the reserve count from the
    ///      next day so the new rate applies forward; reserve building up since the last set-aside
    ///      is dropped.
    function _setReserveDailyRateUSD(uint128 reserveDailyRateUSD_) internal {
        if (activationTS != 0) {
            reserveAnchorTS = _nextDayStartTS();
            emit ReserveAnchored(reserveAnchorTS);
        }

        reserveDailyRateUSD = reserveDailyRateUSD_;
        emit ReserveDailyRateUSDSet(reserveDailyRateUSD_);
    }

    /// @dev Sets the minimum stETH price.
    function _setMinStEthPriceUSD(uint128 minStEthPriceUSD_) internal {
        minStEthPriceUSD = minStEthPriceUSD_;
        emit MinStEthPriceUSDSet(minStEthPriceUSD_);
    }
}
