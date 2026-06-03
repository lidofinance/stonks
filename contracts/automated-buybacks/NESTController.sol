// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {AssetRecovererACL} from "./AssetRecovererACL.sol";
import {IStETH} from "../interfaces/IStETH.sol";
import {IOracleRouter} from "../interfaces/IOracleRouter.sol";
import {IRevenueSource} from "../interfaces/IRevenueSource.sol";
import {IAllocationRecipient} from "../interfaces/IAllocationRecipient.sol";
import {MathHelpers} from "../lib/MathHelpers.sol";

/**
 * @title NESTController
 * @author swissarmytowel <info@lido.fi>
 * @notice Allocates a share of surplus revenue as stETH to a recipient, capped daily and per cycle.
 *         The cycle linearly protects a portion of revenue from buybacks.
 */
contract NESTController is AssetRecovererACL, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;
    using MathHelpers for uint256;

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /// @notice Allocation counter for a rolling window.
    struct AllocationWindow {
        /// @notice First timestamp at which the next window starts.
        uint64 windowEnd;
        /// @notice USD allocated in the current window. 1e18-scaled.
        uint128 allocatedUSD;
    }

    /// @notice Constructor input parameters.
    struct InitParams {
        address admin;
        address treasury;
        address stEth;
        address oracleRouter;
        address recipient;
        uint64 genesis;
        uint256 cycleDays;
        uint128 dailyCapUSD;
        uint128 cycleCapUSD;
        uint128 protectedPerDayUSD;
        uint128 minStEthQuoteUSD;
        uint128 minAllocationUSD;
        uint16 surplusShareBP;
        address[] revenueSources;
    }

    /// @notice Outcome of an allocation eligibility check. Only the eligible value passes;
    ///         the others are surfaced as the skip reason.
    enum AllocationStatus {
        Eligible,
        NoAvailableBudget,
        QuoteUnavailable,
        StEthPriceBelowMin,
        AllocationBelowMin
    }

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice 100% in basis points.
    uint256 public constant MAX_BASIS_POINTS = 10_000;

    /// @notice Upper bound on registered revenue sources.
    uint256 public constant MAX_REVENUE_SOURCES = 50;

    /// @notice Length of one day in seconds.
    uint256 internal constant ONE_DAY = 1 days;

    /// @notice USD amount precision alignment with the oracle router (1e18).
    uint256 internal constant PRICE_SCALE = 1e18;

    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice stETH token. Allocations are made in stETH sent to the recipient.
    IStETH public immutable STETH;

    /// @notice Oracle router. Quotes stETH/USD.
    IOracleRouter public immutable ORACLE_ROUTER;

    /// @notice Start of the first cycle.
    uint256 public immutable GENESIS;

    /// @notice Length of one cycle in days.
    uint256 public immutable CYCLE_DAYS;

    /*//////////////////////////////////////////////////////////////
                          CONFIGURABLE STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Daily allocation cap.
    uint128 public dailyCapUSD;

    /// @notice Cycle allocation cap.
    uint128 public cycleCapUSD;

    /// @notice Per-day rate at which protected revenue accrues within the cycle.
    uint128 public protectedPerDayUSD;

    /// @notice stETH/USD quote floor.
    uint128 public minStEthQuoteUSD;

    /// @notice Minimum per-call allocation.
    uint128 public minAllocationUSD;

    /// @notice Allocation share of the surplus, in basis points.
    uint16 public surplusShareBP;

    /// @notice Recipient of allocation.
    address public recipient;

    /// @notice Monotonic total USD allocated.
    uint256 public lifetimeAllocatedUSD;

    /// @notice Genesis-aligned daily allocation bucket.
    AllocationWindow public daily;

    /// @notice Genesis-aligned cycle allocation bucket.
    AllocationWindow public cycle;

    /// @dev Registered revenue sources counted toward total lifetime revenue.
    EnumerableSet.AddressSet internal _revenueSources;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event Allocated(
        address indexed triggeredBy, address indexed recipient, uint256 allocationUSD, uint256 allocationStEth
    );
    event AllocationSkipped(address indexed caller, AllocationStatus reason);
    event WindowRolled(uint256 windowDurationSeconds, uint256 newWindowEnd, uint256 previousAllocatedUSD);
    event RecipientSet(address indexed recipient);
    event DailyCapUSDSet(uint128 dailyCapUSD);
    event CycleCapUSDSet(uint128 cycleCapUSD);
    event ProtectedPerDayUSDSet(uint128 protectedPerDayUSD);
    event MinStEthQuoteUSDSet(uint128 minStEthQuoteUSD);
    event MinAllocationUSDSet(uint128 minAllocationUSD);
    event SurplusShareBPSet(uint16 surplusShareBP);
    event LifetimeAllocatedUSDSet(uint256 lifetimeAllocatedUSD);
    event RevenueSourceAdded(address indexed source);
    event RevenueSourceRemoved(address indexed source);

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error StEthZeroAddress();
    error OracleRouterZeroAddress();
    error RecipientZeroAddress();
    error GenesisZero();
    error GenesisInFuture();
    error CycleDaysZero();
    error SurplusShareBPInvalid();
    error DailyCapUSDZero();
    error CycleCapUSDZero();
    error MinAllocationUSDZero();
    error DailyCapExceedsCycleCap();
    error MinAllocationExceedsDailyCap();
    error RevenueSourceZeroAddress();
    error RevenueSourceAlreadyRegistered();
    error RevenueSourceNotRegistered();
    error RevenueSourceLimitReached(uint256 maxSources);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @notice Validates inputs, sets immutables, registers initial sources, seeds allocation windows.
    constructor(InitParams memory initParams_) AssetRecovererACL(initParams_.admin, initParams_.treasury) {
        if (initParams_.stEth == address(0)) revert StEthZeroAddress();
        if (initParams_.oracleRouter == address(0)) revert OracleRouterZeroAddress();
        if (initParams_.genesis == 0) revert GenesisZero();
        if (initParams_.genesis > block.timestamp) revert GenesisInFuture();
        if (initParams_.cycleDays == 0) revert CycleDaysZero();

        STETH = IStETH(initParams_.stEth);
        ORACLE_ROUTER = IOracleRouter(initParams_.oracleRouter);
        GENESIS = initParams_.genesis;
        CYCLE_DAYS = initParams_.cycleDays;

        _setRecipient(initParams_.recipient);
        _setCycleCapUSD(initParams_.cycleCapUSD);
        _setDailyCapUSD(initParams_.dailyCapUSD);
        _setMinAllocationUSD(initParams_.minAllocationUSD);
        _setSurplusShareBP(initParams_.surplusShareBP);
        _setProtectedPerDayUSD(initParams_.protectedPerDayUSD);
        _setMinStEthQuoteUSD(initParams_.minStEthQuoteUSD);

        address[] memory sources = initParams_.revenueSources;
        if (sources.length > MAX_REVENUE_SOURCES) {
            revert RevenueSourceLimitReached(MAX_REVENUE_SOURCES);
        }
        for (uint256 i = 0; i < sources.length; ++i) {
            _registerRevenueSource(sources[i]);
        }

        _setLifetimeAllocatedUSD(_lifetimeRevenueUSD());
        _advanceWindow(daily, ONE_DAY, 0);
        _advanceWindow(cycle, _cycleSeconds(), 0);
    }

    /*//////////////////////////////////////////////////////////////
                       EXTERNAL FUNCTIONS - LIFECYCLE
    //////////////////////////////////////////////////////////////*/

    /// @notice Allocates the eligible budget as stETH to the recipient. Permissionless and idempotent.
    /// @dev    Emits a skip event and returns when nothing is allocatable. After the transfer,
    ///         invokes the recipient's onStEthAllocated() hook; a revert there reverts the allocation.
    function allocate() external nonReentrant {
        (AllocationStatus status, uint256 allocationUSD, uint256 allocationStEth) = _calcAllocation();
        if (status != AllocationStatus.Eligible) {
            emit AllocationSkipped(msg.sender, status);
            return;
        }

        _advanceWindow(cycle, _cycleSeconds(), allocationUSD);
        _advanceWindow(daily, ONE_DAY, allocationUSD);

        _setLifetimeAllocatedUSD(lifetimeAllocatedUSD + allocationUSD);

        IERC20(address(STETH)).safeTransfer(recipient, allocationStEth);

        emit Allocated(msg.sender, recipient, allocationUSD, allocationStEth);

        IAllocationRecipient(recipient).onStEthAllocated();
    }

    /*//////////////////////////////////////////////////////////////
                     EXTERNAL FUNCTIONS - CONFIGURATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Sets the daily allocation cap. Must be within [minAllocationUSD, cycleCapUSD].
    function setDailyCapUSD(uint128 dailyCapUSD_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setDailyCapUSD(dailyCapUSD_);
    }

    /// @notice Sets the cycle allocation cap. Must be at least the daily cap.
    function setCycleCapUSD(uint128 cycleCapUSD_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setCycleCapUSD(cycleCapUSD_);
    }

    /// @notice Sets the per-day protected-revenue accrual rate. Unconstrained.
    function setProtectedPerDayUSD(uint128 protectedPerDayUSD_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setProtectedPerDayUSD(protectedPerDayUSD_);
    }

    /// @notice Sets the stETH/USD quote floor. Unconstrained (zero disables the gate).
    function setMinStEthQuoteUSD(uint128 minStEthQuoteUSD_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setMinStEthQuoteUSD(minStEthQuoteUSD_);
    }

    /// @notice Sets the minimum per-call allocation. Must be within (0, dailyCapUSD].
    function setMinAllocationUSD(uint128 minAllocationUSD_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setMinAllocationUSD(minAllocationUSD_);
    }

    /// @notice Sets the surplus allocation share, in basis points. Must be within (0, 100%].
    /// @dev    Rebases lifetime allocation to current revenue when the share changes
    ///         (informational; does not affect the budget).
    function setSurplusShareBP(uint16 surplusShareBP_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bool shareChanged = surplusShareBP != surplusShareBP_;
        _setSurplusShareBP(surplusShareBP_);
        if (shareChanged) {
            _setLifetimeAllocatedUSD(_lifetimeRevenueUSD());
        }
    }

    /// @notice Updates the recipient of subsequent allocations.
    function setRecipient(address newRecipient_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setRecipient(newRecipient_);
    }

    /// @notice Registers a new revenue source.
    /// @dev    Rebases lifetime allocation to current revenue.
    function addRevenueSource(address source_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_revenueSources.length() >= MAX_REVENUE_SOURCES) {
            revert RevenueSourceLimitReached(MAX_REVENUE_SOURCES);
        }
        _registerRevenueSource(source_);
        _setLifetimeAllocatedUSD(_lifetimeRevenueUSD());
    }

    /// @notice Deregisters a revenue source.
    /// @dev    Rebases lifetime allocation to current revenue.
    function removeRevenueSource(address source_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!_revenueSources.remove(source_)) revert RevenueSourceNotRegistered();
        _setLifetimeAllocatedUSD(_lifetimeRevenueUSD());
        emit RevenueSourceRemoved(source_);
    }

    /*//////////////////////////////////////////////////////////////
                        EXTERNAL FUNCTIONS - VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Allocation eligibility at the current block. Mirrors what a real allocation would compute.
    /// @return ok           True iff the budget is non-zero and all gates pass.
    /// @return reason       Allocation status code; zero on success.
    /// @return allocationUSD    USD budget that would be allocated.
    /// @return allocationStEth  stETH amount that would be transferred.
    function canAllocate()
        external
        view
        returns (bool ok, AllocationStatus reason, uint256 allocationUSD, uint256 allocationStEth)
    {
        (reason, allocationUSD, allocationStEth) = _calcAllocation();
        ok = reason == AllocationStatus.Eligible;
    }

    /// @notice Addresses of every registered revenue source.
    function getRevenueSources() external view returns (address[] memory) {
        return _revenueSources.values();
    }

    /// @notice Current stETH/USD price. Reverts on oracle failure.
    function getStEthPriceUSD() external view returns (uint256 stEthPriceUSD) {
        (stEthPriceUSD,) = ORACLE_ROUTER.getUsdPrices(address(STETH), address(STETH));
    }

    /// @notice USD reserved from buybacks in the current cycle. Accrues in
    ///         integer-day steps and resets to zero at the start of each cycle.
    function protectedRevenueUSD() public view returns (uint256) {
        uint256 elapsedInCurrentCycle = (block.timestamp - GENESIS) % _cycleSeconds();
        uint256 daysIntoCycle = elapsedInCurrentCycle / ONE_DAY;
        return uint256(protectedPerDayUSD) * daysIntoCycle;
    }

    /*//////////////////////////////////////////////////////////////
                           INTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @dev Evaluates the eligible budget for the current block.
    function _calcAllocation()
        internal
        view
        returns (AllocationStatus status, uint256 allocationUSD, uint256 allocationStEth)
    {
        uint256 surplusUSD = _lifetimeRevenueUSD().saturatedSub(protectedRevenueUSD());
        uint256 maxAllocatableUSD = Math.mulDiv(surplusUSD, surplusShareBP, MAX_BASIS_POINTS);
        allocationUSD = maxAllocatableUSD.saturatedSub(_allocatedUSD(cycle));
        if (allocationUSD == 0) return (AllocationStatus.NoAvailableBudget, 0, 0);

        // Price gate.
        uint256 stEthPriceUSD = _tryQuoteStEthUSD();
        if (stEthPriceUSD == 0) return (AllocationStatus.QuoteUnavailable, 0, 0);
        if (minStEthQuoteUSD > stEthPriceUSD) {
            return (AllocationStatus.StEthPriceBelowMin, 0, 0);
        }

        // Clamp by caps; convert to stETH; clamp by balance; restate in USD.
        allocationUSD = _clampByWindow(allocationUSD, cycle, cycleCapUSD);
        allocationUSD = _clampByWindow(allocationUSD, daily, dailyCapUSD);
        allocationStEth =
            Math.min(Math.mulDiv(allocationUSD, PRICE_SCALE, stEthPriceUSD), STETH.balanceOf(address(this)));
        allocationUSD = Math.mulDiv(allocationStEth, stEthPriceUSD, PRICE_SCALE);

        // Reject any insignificant allocation
        if (allocationUSD < minAllocationUSD) {
            return (AllocationStatus.AllocationBelowMin, 0, 0);
        }

        return (AllocationStatus.Eligible, allocationUSD, allocationStEth);
    }

    /// @dev Sums reported revenue across sources. Reverting sources contribute zero.
    function _lifetimeRevenueUSD() internal view returns (uint256 revenueUSD) {
        address[] memory sources = _revenueSources.values();
        for (uint256 i = 0; i < sources.length; ++i) {
            try IRevenueSource(sources[i]).totalRevenueUSD() returns (uint256 sourceTotal) {
                revenueUSD += sourceTotal;
            } catch {}
        }
    }

    /// @dev Sets the lifetime allocated total and emits. Used by both allocation and rebase.
    function _setLifetimeAllocatedUSD(uint256 lifetimeAllocatedUSD_) internal {
        lifetimeAllocatedUSD = lifetimeAllocatedUSD_;
        emit LifetimeAllocatedUSDSet(lifetimeAllocatedUSD_);
    }

    /// @dev Soft-fail stETH/USD quote. Returns zero on oracle revert or a zero price.
    function _tryQuoteStEthUSD() internal view returns (uint256 stEthPriceUSD) {
        try ORACLE_ROUTER.getUsdPrices(address(STETH), address(STETH)) returns (
            uint256 stEthPrice,
            uint256 /* quoteUsdPrice */
        ) {
            stEthPriceUSD = stEthPrice;
        } catch {}
    }

    /// @dev Clamps the budget by the window's remaining cap.
    function _clampByWindow(uint256 allocationUSD_, AllocationWindow memory window_, uint256 capUSD_)
        internal
        view
        returns (uint256)
    {
        return Math.min(allocationUSD_, capUSD_.saturatedSub(_allocatedUSD(window_)));
    }

    /// @dev Allocation in the current window; zero when the window has expired.
    function _allocatedUSD(AllocationWindow memory window_) internal view returns (uint256) {
        return block.timestamp >= window_.windowEnd ? 0 : uint256(window_.allocatedUSD);
    }

    /// @dev Adds the budget to the window's allocation; rolls first if the window has expired.
    function _advanceWindow(AllocationWindow storage window_, uint256 windowDurationSeconds_, uint256 allocationUSD_)
        internal
    {
        uint128 allocated = window_.allocatedUSD;
        if (block.timestamp >= window_.windowEnd) {
            uint64 newWindowEnd = _nextWindowEnd(windowDurationSeconds_);
            emit WindowRolled(windowDurationSeconds_, newWindowEnd, allocated);
            window_.windowEnd = newWindowEnd;
            allocated = 0;
        }
        window_.allocatedUSD = allocated + uint128(allocationUSD_);
    }

    /// @dev Next window boundary after the current block, anchored at genesis.
    function _nextWindowEnd(uint256 windowDurationSeconds_) internal view returns (uint64) {
        uint256 secondsSinceGenesis = block.timestamp - GENESIS;
        uint256 windowsSinceGenesis = secondsSinceGenesis / windowDurationSeconds_;
        return uint64(GENESIS + (windowsSinceGenesis + 1) * windowDurationSeconds_);
    }

    /// @dev Probes the source's reachability, then registers it.
    function _registerRevenueSource(address source_) internal {
        if (source_ == address(0)) revert RevenueSourceZeroAddress();
        IRevenueSource(source_).totalRevenueUSD();
        if (!_revenueSources.add(source_)) revert RevenueSourceAlreadyRegistered();
        emit RevenueSourceAdded(source_);
    }

    /// @dev Sets the recipient. Reverts on the zero address.
    function _setRecipient(address recipient_) internal {
        if (recipient_ == address(0)) revert RecipientZeroAddress();
        recipient = recipient_;
        emit RecipientSet(recipient_);
    }

    /// @dev Sets the daily cap: non-zero, within the cycle cap, and at least the minimum allocation.
    function _setDailyCapUSD(uint128 dailyCapUSD_) internal {
        if (dailyCapUSD_ == 0) revert DailyCapUSDZero();
        if (dailyCapUSD_ > cycleCapUSD) revert DailyCapExceedsCycleCap();
        if (minAllocationUSD > dailyCapUSD_) revert MinAllocationExceedsDailyCap();
        dailyCapUSD = dailyCapUSD_;
        emit DailyCapUSDSet(dailyCapUSD_);
    }

    /// @dev Sets the cycle cap: non-zero and at least the daily cap.
    function _setCycleCapUSD(uint128 cycleCapUSD_) internal {
        if (cycleCapUSD_ == 0) revert CycleCapUSDZero();
        if (dailyCapUSD > cycleCapUSD_) revert DailyCapExceedsCycleCap();
        cycleCapUSD = cycleCapUSD_;
        emit CycleCapUSDSet(cycleCapUSD_);
    }

    /// @dev Sets the minimum allocation: non-zero and at most the daily cap.
    function _setMinAllocationUSD(uint128 minAllocationUSD_) internal {
        if (minAllocationUSD_ == 0) revert MinAllocationUSDZero();
        if (minAllocationUSD_ > dailyCapUSD) revert MinAllocationExceedsDailyCap();
        minAllocationUSD = minAllocationUSD_;
        emit MinAllocationUSDSet(minAllocationUSD_);
    }

    /// @dev Sets the surplus share: within (0, 100%].
    function _setSurplusShareBP(uint16 surplusShareBP_) internal {
        if (surplusShareBP_ == 0 || surplusShareBP_ > MAX_BASIS_POINTS) {
            revert SurplusShareBPInvalid();
        }
        surplusShareBP = surplusShareBP_;
        emit SurplusShareBPSet(surplusShareBP_);
    }

    /// @dev Sets the per-day protected-revenue accrual rate. Unconstrained.
    function _setProtectedPerDayUSD(uint128 protectedPerDayUSD_) internal {
        protectedPerDayUSD = protectedPerDayUSD_;
        emit ProtectedPerDayUSDSet(protectedPerDayUSD_);
    }

    /// @dev Sets the stETH/USD quote floor. Unconstrained (zero disables the gate).
    function _setMinStEthQuoteUSD(uint128 minStEthQuoteUSD_) internal {
        minStEthQuoteUSD = minStEthQuoteUSD_;
        emit MinStEthQuoteUSDSet(minStEthQuoteUSD_);
    }

    /// @dev Cycle length in seconds.
    function _cycleSeconds() internal view returns (uint256) {
        return CYCLE_DAYS * ONE_DAY;
    }
}
