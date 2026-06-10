// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";

import {AssetRecovererACL} from "./AssetRecovererACL.sol";
import {IStETH} from "../interfaces/IStETH.sol";
import {IOracleRouter} from "../interfaces/IOracleRouter.sol";
import {IRevenueSource} from "../interfaces/IRevenueSource.sol";
import {IAllocationRecipient} from "../interfaces/IAllocationRecipient.sol";
import {MathHelpers} from "../lib/MathHelpers.sol";

/**
 * @title Allocator
 * @notice Holds a pot of stETH and pays it out, piece by piece, to a single receiver (the
 *         `spender`) for buybacks — but only as fast as the protocol earns new revenue.
 *         Anyone may call `allocate()`; the rules below decide how much (if anything) leaves
 *         the contract on each call.
 *
 * @dev
 * ===================================== THE ACCOUNTING MODEL =====================================
 *
 * Counting revenue.
 *   A list of registered "revenue source" contracts each publish one number: the total USD value
 *   that source has earned for the protocol since it went live. These numbers only ever grow.
 *   The Allocator stores no revenue itself — whenever it needs the current total, it adds up all
 *   the sources' numbers on the spot. While computing a payout, a source that fails to answer
 *   simply counts as zero for that moment, which can only lower the payout, never raise it.
 *
 * Activation.
 *   The contract starts asleep. The admin wakes it once with `activate()`, which:
 *     - snaps the start moment back to 00:00 UTC of the current day — every day and year boundary
 *       the contract uses from then on lands exactly on midnight UTC;
 *     - writes down the current revenue total as the starting point (`revenueBaselineUSD`).
 *       Everything earned before activation stays out of reach forever;
 *     - starts the clock on the daily set-aside (next section) at the rate passed in.
 *
 * The daily set-aside (reserve).
 *   Each day, a fixed USD amount (`reserveDailyRateUSD`) is put out of reach, starting with the
 *   activation day itself; a day is charged in full the moment it begins. The set-aside depends
 *   only on the clock, so calling `allocate()` more or less often cannot change it. When the
 *   admin changes the daily amount, days already finished keep the old amount; the current day
 *   onward is charged at the new one.
 *
 * The spending allowance.
 *   Take the revenue earned since activation, subtract the total set-aside so far: what remains
 *   is the extra that the protocol earned on top of its needs. A configured share of that extra
 *   (`surplusShareBP`) is the all-time spending allowance. The share applies to the whole
 *   history every time it is read, not just to the future: raising it makes more of the
 *   already-earned extra spendable, and lowering it can shrink the allowance below what was
 *   already spent (which pauses payouts; see next).
 *
 * Spending.
 *   Every payout adds to `totalSpentUSD`, which never goes down and is never reset. What can go
 *   out right now is the allowance minus everything spent since the last accounting reset (see
 *   next section), never below zero. If the allowance falls behind — the set-aside keeps growing
 *   every day, or the share was lowered — nothing is taken back from the spender; payouts simply
 *   pause until the allowance grows past the spent amount again.
 *
 * Resetting the accounting.
 *   The admin can wipe the slate with `resetAccounting()`: the extra is re-measured as zero at
 *   that moment (the starting point moves to the current revenue-minus-set-aside level, even if
 *   that forgives a set-aside shortfall), and past payouts stop counting against the allowance.
 *   Any unspent allowance is forfeited; nothing already paid out is affected. From then on only
 *   revenue earned after the reset creates allowance. This pairs with share changes: reset plus
 *   a lower share keeps buybacks flowing from new revenue instead of pausing, and reset plus a
 *   higher share applies the new share only to new revenue instead of the whole history.
 *
 * Speed limits.
 *   Two caps slow the outflow: at most `dailyCapUSD` per day slot and `yearlyCapUSD` per year
 *   slot. Slots are fixed periods counted from the activation midnight (so they also start and
 *   end at 00:00 UTC), not sliding windows; room left unused in one slot does not carry over to
 *   the next. Cap changes touch the slot in progress: raising a cap opens room right away, and
 *   lowering it below what the slot already spent pauses payouts until the slot ends. Slot
 *   bookkeeping is lazy: storage and the `WindowRolled` event update only when a payout actually
 *   happens, so slots without payouts leave no trace, and the stored per-slot spend may belong
 *   to a slot that already ended (it stops counting the moment its slot is over).
 *
 * Paying out.
 *   On `allocate()` the contract asks the oracle for the stETH price, turns the spendable USD
 *   into stETH, sends it to the spender, and then notifies the spender so it can put the funds
 *   to work. It can never send more stETH than it holds, and it records as spent exactly the
 *   USD value of what was actually sent. Instead of failing, the call quietly skips (with an
 *   `AllocationSkipped` event) when the contract is not activated yet, the price is unavailable
 *   or below the admin-set minimum (`minStEthPriceUSD`), there is nothing to spend, or the
 *   payout would be smaller than the per-call minimum. The skip reason is the first check that
 *   failed, and some reasons cover several causes: an empty or nearly empty pot shows up as
 *   "below the per-call minimum", and "no available budget" can mean either the allowance or a
 *   day/year cap is used up.
 *
 * Changing the source list.
 *   Adding a source after activation also adds its current number to the starting point, so only
 *   what it earns from that moment on counts. Removing a source subtracts its current number, so
 *   everything it contributed until then stays counted — removal only stops future earnings from
 *   counting. This bookkeeping can push the starting point below zero; that is expected, which is
 *   why `revenueBaselineUSD` is a signed number. A source must declare `IRevenueSource` support
 *   (ERC-165) to be registered, and at most 50 sources can be registered at a time.
 *
 * Funding.
 *   The stETH pot is topped up by plain transfers from outside. The balance never creates
 *   allowance; it only limits how much of the allowance can be paid out right now.
 *
 * ======================================== ASSUMPTIONS ==========================================
 *
 * 1. Revenue sources are trusted contracts vetted by governance. Their numbers are honest,
 *    18-decimals USD values that only grow. A wrong or inflated number becomes real spending
 *    allowance (drained no faster than the caps allow), and there is no way to un-count it
 *    later — removing the source keeps everything already counted.
 * 2. A broken source that stops answering makes the contract spend less, never more: its whole
 *    number drops out of the total while it is down. But `activate()`, adding a source after
 *    activation, and source removal all call the source directly and will fail while it is
 *    broken.
 * 3. The oracle returns a fair and fresh stETH/USD price (18 decimals); staleness checks live
 *    inside the oracle router. The only check here is the admin-set price floor
 *    (`minStEthPriceUSD`): if the oracle ever under-prices stETH, the contract sends more stETH
 *    per dollar, and the floor is what limits how bad that can get — so it should be set above
 *    zero in production.
 * 4. Admin roles are trusted (Lido governance). The admin can redirect all future payouts
 *    (`setSpender`) and reshape every limit; the manager role (from the base contract) can sweep
 *    any token to the treasury.
 * 5. The spender is a contract that accepts stETH and implements the `onStEthAllocated()` hook;
 *    if the hook reverts, payouts fail until the admin replaces the spender.
 * 6. stETH behaves like a regular 18-decimals token; its well-known 1-2 wei transfer rounding is
 *    tolerated.
 * 7. Block timestamps only move forward, and day boundaries are UTC.
 *
 * ========================================= INVARIANTS ==========================================
 *
 * 1. At every payout, the spending since the last accounting reset stays within the allowance
 *    of that moment (the share as configured right then, applied to the extra as measured right
 *    then). Between resets, payouts therefore never exceed the largest such allowance seen at
 *    any payout. Revenue earned before activation and the daily set-aside are never spent.
 * 2. `totalSpentUSD` only ever grows, and nothing already paid out is ever taken back.
 * 3. Payouts within one day slot never exceed the daily cap, and within one year slot never
 *    exceed the yearly cap (as configured at the moment of each payout).
 * 4. Every USD recorded as spent corresponds to stETH that actually left the contract in the
 *    same transaction, valued at the oracle price used for that payout.
 * 5. The contract never sends more stETH than it holds, and a low balance never erases
 *    allowance — it only delays payouts.
 * 6. Adding or removing a revenue source never changes, at that very moment, how much can be
 *    spent.
 * 7. Spending activity never changes the set-aside; between admin rate changes it grows with
 *    the clock alone. A rate change re-prices the current, already-charged day at the new rate,
 *    so a rate cut steps the total down by the difference for that day.
 * 8. Before activation nothing can be spent, and activation can happen only once.
 */
contract Allocator is AssetRecovererACL, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
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
        address spender;
        uint128 dailyCapUSD;
        uint128 yearlyCapUSD;
        uint128 minStEthPriceUSD;
        uint128 minSpendPerCallUSD;
        uint16 surplusShareBP;
        address[] revenueSources;
    }

    uint256 public constant MAX_BASIS_POINTS = 10_000;
    uint256 public constant MAX_REVENUE_SOURCES = 50;
    uint256 internal constant PRICE_SCALE = 1e18;
    uint256 internal constant ONE_DAY = 1 days;
    uint256 internal constant ONE_YEAR = 365 days;

    IStETH public immutable STETH;
    IOracleRouter public immutable ORACLE_ROUTER;

    uint128 public dailyCapUSD;
    uint128 public yearlyCapUSD;
    uint128 public reserveDailyRateUSD;
    uint128 public minStEthPriceUSD;
    uint128 public minSpendPerCallUSD;
    uint16 public surplusShareBP;
    address public spender;

    uint256 public activationTS;
    int256 public revenueBaselineUSD;
    uint256 public reserveBaseUSD;
    uint256 public reserveAnchorTS;
    uint256 public totalSpentUSD;
    uint256 public spentBaselineUSD;
    SpendWindow public daily;
    SpendWindow public yearly;

    EnumerableSet.AddressSet internal _revenueSources;

    event Activated(uint256 activationTS, int256 revenueBaselineUSD);
    event Allocated(
        address indexed triggeredBy,
        address indexed spender,
        uint256 spendUSD,
        uint256 spendStEth
    );
    event AllocationSkipped(address indexed caller, AllocationStatus reason);
    event AccountingReset(
        uint256 forfeitedUSD,
        int256 revenueBaselineUSD,
        uint256 spentBaselineUSD
    );
    event WindowRolled(uint256 windowDurationSeconds, uint256 newEndTS, uint256 previousSpentUSD);
    event ReserveAnchored(uint256 anchorTS, uint256 reserveBaseUSD);
    event SpenderSet(address indexed spender);
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
    error SpenderZeroAddress();
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

    constructor(
        ConstructorParams memory initParams_
    ) AssetRecovererACL(initParams_.admin, initParams_.treasury) {
        if (initParams_.stEth == address(0)) revert StEthZeroAddress();
        if (initParams_.oracleRouter == address(0)) revert OracleRouterZeroAddress();

        STETH = IStETH(initParams_.stEth);
        ORACLE_ROUTER = IOracleRouter(initParams_.oracleRouter);

        _setSpender(initParams_.spender);
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

    function activate(uint128 reserveDailyRateUSD_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (activationTS != 0) revert AlreadyActivated();

        uint256 alignedTS = _todayStartTS();
        activationTS = alignedTS;

        revenueBaselineUSD = SafeCast.toInt256(_revenueSumStrictUSD());

        _setReserveDailyRateUSD(reserveDailyRateUSD_);

        _rollWindow(daily, ONE_DAY, 0);
        _rollWindow(yearly, ONE_YEAR, 0);

        emit Activated(alignedTS, revenueBaselineUSD);
    }

    function allocate() external nonReentrant {
        (AllocationStatus status, uint256 spendUSD, uint256 spendStEth) = spendable();

        if (status != AllocationStatus.Eligible) {
            emit AllocationSkipped(msg.sender, status);
            return;
        }

        totalSpentUSD += spendUSD;
        _rollWindow(yearly, ONE_YEAR, spendUSD);
        _rollWindow(daily, ONE_DAY, spendUSD);

        IERC20(address(STETH)).safeTransfer(spender, spendStEth);

        emit Allocated(msg.sender, spender, spendUSD, spendStEth);

        IAllocationRecipient(spender).onStEthAllocated();
    }

    function resetAccounting() external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (activationTS == 0) revert NotActivated();

        uint256 revenueSumUSD = _revenueSumStrictUSD();
        uint256 reserveUSD = _reserveCurrentUSD();
        int256 surplusUSD = revenueSumUSD.toInt256() - revenueBaselineUSD - reserveUSD.toInt256();
        uint256 forfeitedUSD = surplusUSD > 0
            ? _mulBP(uint256(surplusUSD), surplusShareBP).saturatedSub(
                totalSpentUSD - spentBaselineUSD
            )
            : 0;

        revenueBaselineUSD = revenueSumUSD.toInt256() - reserveUSD.toInt256();
        spentBaselineUSD = totalSpentUSD;

        emit AccountingReset(forfeitedUSD, revenueBaselineUSD, spentBaselineUSD);
    }

    function setSurplusShareBP(uint16 surplusShareBP_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setSurplusShareBP(surplusShareBP_);
    }

    function setReserveDailyRateUSD(
        uint128 reserveDailyRateUSD_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setReserveDailyRateUSD(reserveDailyRateUSD_);
    }

    function setDailyCapUSD(uint128 dailyCapUSD_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setDailyCapUSD(dailyCapUSD_);
    }

    function setYearlyCapUSD(uint128 yearlyCapUSD_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setYearlyCapUSD(yearlyCapUSD_);
    }

    function setMinStEthPriceUSD(uint128 minStEthPriceUSD_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setMinStEthPriceUSD(minStEthPriceUSD_);
    }

    function setMinSpendPerCallUSD(
        uint128 minSpendPerCallUSD_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setMinSpendPerCallUSD(minSpendPerCallUSD_);
    }

    function setSpender(address newSpender_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setSpender(newSpender_);
    }

    function addRevenueSource(address source_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _addRevenueSource(source_);
    }

    function removeRevenueSource(address source_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _removeRevenueSource(source_);
    }

    function spendable()
        public
        view
        returns (AllocationStatus status, uint256 spendableUSD, uint256 spendableStEth)
    {
        // STEP 1: Return if not activated
        if (activationTS == 0) {
            return (AllocationStatus.NotActivated, 0, 0);
        }

        // STEP 2: Return if the price oracle failed
        uint256 stEthPriceUSD = _getStEthPriceUSD();

        if (stEthPriceUSD == 0) {
            return (AllocationStatus.QuoteUnavailable, 0, 0);
        }

        // STEP 3: Return if the stEth price is too low
        if (minStEthPriceUSD > stEthPriceUSD) {
            return (AllocationStatus.StEthPriceBelowMin, 0, 0);
        }

        // STEP 4: Surplus = Revenue Sum - Revenue Baseline - Reserved Total
        uint256 revenueSumUSD = _revenueSumUSD();
        uint256 reserveUSD = _reserveCurrentUSD();
        int256 surplusUSD = revenueSumUSD.toInt256() - revenueBaselineUSD - reserveUSD.toInt256();

        // STEP 5: Buyback Budget = Surplus * Surplus Share
        uint256 budgetUSD = surplusUSD > 0 ? _mulBP(uint256(surplusUSD), surplusShareBP) : 0;

        // STEP 6: Spendable now = Buyback Budget - Spent since the last accounting reset
        spendableUSD = budgetUSD.saturatedSub(totalSpentUSD - spentBaselineUSD);
        if (spendableUSD == 0) {
            return (AllocationStatus.NoAvailableBudget, 0, 0);
        }

        // STEP 7: Limit by yearly, daily caps
        spendableUSD = Math.min(spendableUSD, _windowUnspent(yearly, yearlyCapUSD));
        spendableUSD = Math.min(spendableUSD, _windowUnspent(daily, dailyCapUSD));
        if (spendableUSD == 0) {
            return (AllocationStatus.NoAvailableBudget, 0, 0);
        }

        // STEP 8: Limit to StEth balance and restate in USD
        spendableStEth = Math.mulDiv(spendableUSD, PRICE_SCALE, stEthPriceUSD);
        spendableStEth = Math.min(spendableStEth, STETH.balanceOf(address(this)));
        spendableUSD = Math.mulDiv(spendableStEth, stEthPriceUSD, PRICE_SCALE);

        // STEP 9: Dust filter
        if (spendableUSD < minSpendPerCallUSD) {
            return (AllocationStatus.AllocationBelowMin, 0, 0);
        }

        status = AllocationStatus.Eligible;
    }

    function _rollWindow(
        SpendWindow storage window_,
        uint256 windowDuration_,
        uint256 spendUSD_
    ) internal {
        uint192 spent = window_.spentUSD;
        if (block.timestamp >= window_.endTS) {
            uint64 newEndTS = uint64(
                activationTS + ((block.timestamp - activationTS) / windowDuration_ + 1) * windowDuration_
            );
            emit WindowRolled(windowDuration_, newEndTS, spent);
            window_.endTS = newEndTS;
            spent = 0;
        }
        window_.spentUSD = spent + uint192(spendUSD_);
    }

    function _windowSpent(SpendWindow storage window_) internal view returns (uint256 spent) {
        spent = block.timestamp >= window_.endTS ? 0 : uint256(window_.spentUSD);
    }

    function _windowUnspent(
        SpendWindow storage window_,
        uint256 cap_
    ) internal view returns (uint256 unspent) {
        unspent = cap_.saturatedSub(_windowSpent(window_));
    }

    function _reserveCurrentUSD() internal view returns (uint256) {
        uint256 elapsedDays = (block.timestamp - reserveAnchorTS) / ONE_DAY;
        return reserveBaseUSD + uint256(reserveDailyRateUSD) * (elapsedDays + 1);
    }

    function _revenueSumStrictUSD() internal view returns (uint256 revenueSumUSD) {
        address[] memory sources = _revenueSources.values();
        for (uint256 i = 0; i < sources.length; ++i) {
            revenueSumUSD += IRevenueSource(sources[i]).totalRevenueUSD();
        }
    }

    function _revenueSumUSD() internal view returns (uint256 revenueSumUSD) {
        address[] memory sources = _revenueSources.values();
        for (uint256 i = 0; i < sources.length; ++i) {
            try IRevenueSource(sources[i]).totalRevenueUSD() returns (uint256 revenue) {
                revenueSumUSD += revenue;
            } catch {}
        }
    }

    function _getStEthPriceUSD() internal view returns (uint256 stEthPriceUSD) {
        try ORACLE_ROUTER.getUsdPrices(address(STETH), address(STETH)) returns (
            uint256 stEthPrice,
            uint256
        ) {
            stEthPriceUSD = stEthPrice;
        } catch {}
    }

    function _todayStartTS() internal view returns (uint256) {
        return (block.timestamp / ONE_DAY) * ONE_DAY;
    }

    function _mulBP(uint256 number_, uint256 bp_) internal pure returns (uint256) {
        return Math.mulDiv(number_, bp_, MAX_BASIS_POINTS);
    }

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
            revenueBaselineUSD += SafeCast.toInt256(IRevenueSource(source_).totalRevenueUSD());
        }

        emit RevenueSourceAdded(source_);
    }

    function _removeRevenueSource(address source_) internal {
        if (!_revenueSources.remove(source_)) revert RevenueSourceNotRegistered();

        if (activationTS != 0) {
            revenueBaselineUSD -= SafeCast.toInt256(IRevenueSource(source_).totalRevenueUSD());
        }

        emit RevenueSourceRemoved(source_);
    }

    function _setSpender(address spender_) internal {
        if (spender_ == address(0)) revert SpenderZeroAddress();
        spender = spender_;
        emit SpenderSet(spender_);
    }

    function _setYearlyCapUSD(uint128 yearlyCapUSD_) internal {
        if (yearlyCapUSD_ == 0) revert YearlyCapUSDZero();
        if (dailyCapUSD > yearlyCapUSD_) revert DailyCapExceedsYearlyCap();
        yearlyCapUSD = yearlyCapUSD_;
        emit YearlyCapUSDSet(yearlyCapUSD_);
    }

    function _setDailyCapUSD(uint128 dailyCapUSD_) internal {
        if (dailyCapUSD_ == 0) revert DailyCapUSDZero();
        if (dailyCapUSD_ > yearlyCapUSD) revert DailyCapExceedsYearlyCap();
        if (minSpendPerCallUSD > dailyCapUSD_) revert MinSpendPerCallExceedsDailyCap();
        dailyCapUSD = dailyCapUSD_;
        emit DailyCapUSDSet(dailyCapUSD_);
    }

    function _setMinSpendPerCallUSD(uint128 minSpendPerCallUSD_) internal {
        if (minSpendPerCallUSD_ == 0) revert MinSpendPerCallUSDZero();
        if (minSpendPerCallUSD_ > dailyCapUSD) revert MinSpendPerCallExceedsDailyCap();
        minSpendPerCallUSD = minSpendPerCallUSD_;
        emit MinSpendPerCallUSDSet(minSpendPerCallUSD_);
    }

    function _setSurplusShareBP(uint16 surplusShareBP_) internal {
        if (surplusShareBP_ == 0 || surplusShareBP_ > MAX_BASIS_POINTS)
            revert SurplusShareBPInvalid();
        surplusShareBP = surplusShareBP_;
        emit SurplusShareBPSet(surplusShareBP_);
    }

    function _setReserveDailyRateUSD(uint128 reserveDailyRateUSD_) internal {
        if (activationTS != 0) {
            uint256 anchorTS = _todayStartTS();
            if (reserveAnchorTS != 0) {
                reserveBaseUSD += uint256(reserveDailyRateUSD) * ((anchorTS - reserveAnchorTS) / ONE_DAY);
            }
            reserveAnchorTS = anchorTS;
            emit ReserveAnchored(anchorTS, reserveBaseUSD);
        }

        reserveDailyRateUSD = reserveDailyRateUSD_;
        emit ReserveDailyRateUSDSet(reserveDailyRateUSD_);
    }

    function _setMinStEthPriceUSD(uint128 minStEthPriceUSD_) internal {
        minStEthPriceUSD = minStEthPriceUSD_;
        emit MinStEthPriceUSDSet(minStEthPriceUSD_);
    }
}
