// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {BuybackAllocator} from "contracts/automated-buybacks/BuybackAllocator.sol";
import {IBuybackAllocator} from "contracts/interfaces/IBuybackAllocator.sol";
import {
    StEthTokenStub,
    RevenueSourceStub,
    ExecutorStub
} from "contracts/test/BuybackAllocatorStubs.sol";
import {OracleRouterUsdStub} from "contracts/test/StakingRevenueSourceStubs.sol";

/// @notice Drives random sequences of allocator actions (time warps, allocations, revenue growth,
///         source registration, stETH funding, param changes) while a ghost model records what must
///         always hold. Inputs are bounded to individually-valid calls so any revert or mismatch is
///         a real bug, not a rejected precondition. Caps move only within valid bounds and never
///         below what a window already spent; their standalone validation is fuzzed in fast-check.
contract AllocatorHandler is Test {
    BuybackAllocator public allocator;
    StEthTokenStub public stEth;
    OracleRouterUsdStub public oracle;
    ExecutorStub public executor;

    // A fixed pool of revenue sources the handler registers/unregisters at will.
    RevenueSourceStub[] public sources;
    bool[] public registered;
    uint256[] public sourceCum; // each source's cumulative, tracked to avoid re-reading the stub
    uint256 public registeredCount;

    // Ghosts checked by the invariants.
    uint256 public ghostTotalMinted; // every stETH wei ever minted to the allocator
    uint256 public ghostRegisteredRevenue; // revenue grown while its source was registered
    uint256 public ghostSpentUSD; // total USD ever allocated (sum of per-call spend)
    uint256 public ghostEligibleAllocations; // count of allocations that proceeded (not skipped)
    bool public ghostAllocateReverted; // allocate() ever reverted (with reachable sources it must only skip)
    bool public ghostSpendableMismatch; // spendable() preview ever disagreed with allocate()

    constructor(
        BuybackAllocator allocator_,
        StEthTokenStub stEth_,
        OracleRouterUsdStub oracle_,
        ExecutorStub executor_,
        RevenueSourceStub[] memory sources_
    ) {
        allocator = allocator_;
        stEth = stEth_;
        oracle = oracle_;
        executor = executor_;
        for (uint256 i = 0; i < sources_.length; ++i) {
            sources.push(sources_[i]);
        }
        registered = new bool[](sources_.length);
        sourceCum = new uint256[](sources_.length);
    }

    /// @dev Advance time, biased toward short jumps: 80% land within the first day (intra-day
    ///      dynamics before a roll), 20% span up to ~400 days (window rolls, multi-day reserve
    ///      accrual). `bucketSeed` picks the range, `amountSeed` the value in it — fuzzed independently.
    function warp(uint256 bucketSeed, uint256 amountSeed) external {
        uint256 delta = bound(bucketSeed, 0, 99) < 80
            ? bound(amountSeed, 0, 1 days - 1)
            : bound(amountSeed, 1 days, 400 days);
        vm.warp(block.timestamp + delta);
    }

    /// @dev Revenue only grows. Growth counts toward the spend bound only while the source is
    ///      registered — growth accrued while unregistered is excluded by the contract's baseline.
    function bumpRevenue(uint256 index, uint256 increment) external {
        uint256 i = bound(index, 0, sources.length - 1);
        uint256 inc = bound(increment, 0, 1_000_000e18);
        sourceCum[i] += inc;
        sources[i].setCumulativeRevenueUSD(sourceCum[i]);
        if (registered[i]) ghostRegisteredRevenue += inc;
    }

    /// @dev Register a source. Guarded so it never reverts (skip if already registered or full).
    function addSource(uint256 index) external {
        uint256 i = bound(index, 0, sources.length - 1);
        if (registered[i] || registeredCount >= allocator.MAX_REVENUE_SOURCES()) return;
        allocator.addRevenueSource(address(sources[i]));
        registered[i] = true;
        registeredCount += 1;
    }

    /// @dev Unregister a source. Guarded so it never reverts (skip if not registered). Under
    ///      fail_on_revert this also asserts the baseline subtraction never underflows.
    function removeSource(uint256 index) external {
        uint256 i = bound(index, 0, sources.length - 1);
        if (!registered[i]) return;
        allocator.removeRevenueSource(address(sources[i]));
        registered[i] = false;
        registeredCount -= 1;
    }

    /// @dev Fund the allocator's spendable stETH balance.
    function mintStEth(uint256 amount) external {
        uint256 minted = bound(amount, 0, 1_000_000e18);
        ghostTotalMinted += minted;
        stEth.mint(address(allocator), minted);
    }

    /// @dev Vary the oracle price, including 0 to exercise the QuoteUnavailable path.
    function setPrice(uint256 price) external {
        uint256 p = bound(price, 0, 100_000e18);
        oracle.setUsdPrice(p, p);
    }

    function setSurplusShare(uint16 bp) external {
        allocator.setSurplusShareBP(uint16(bound(bp, 1, 10_000)));
    }

    function setReserveRate(uint128 rate) external {
        allocator.setReserveDailyRateUSD(uint128(bound(rate, 0, 1_000e18)));
    }

    /// @dev Move the daily cap within `[max(minSpend, current daily spent), yearlyCap]` — never
    ///      below what the window already spent, so `spentUSD <= dailyCap` stays a valid invariant.
    function setDailyCap(uint256 seed) external {
        (, uint192 dailySpent) = allocator.daily();
        uint256 minSpend = allocator.minSpendPerCallUSD();
        uint256 lo = uint256(dailySpent) > minSpend ? uint256(dailySpent) : minSpend;
        uint256 hi = allocator.yearlyCapUSD();
        if (lo > hi) return;
        allocator.setDailyCapUSD(uint128(bound(seed, lo, hi)));
    }

    /// @dev Move the yearly cap within `[max(dailyCap, current yearly spent), 1e27]` — never below
    ///      the daily cap or what the window already spent.
    function setYearlyCap(uint256 seed) external {
        (, uint192 yearlySpent) = allocator.yearly();
        uint256 dailyCap = allocator.dailyCapUSD();
        uint256 lo = uint256(yearlySpent) > dailyCap ? uint256(yearlySpent) : dailyCap;
        uint256 hi = 1_000_000_000e18;
        if (lo > hi) return;
        allocator.setYearlyCapUSD(uint128(bound(seed, lo, hi)));
    }

    /// @dev The core action. With every source reachable, as in this harness, allocate() must never
    ///      revert (only skip via event), its effect must match the spendable() preview taken in
    ///      the same block, and we bank the spent USD.
    function allocate() external {
        (IBuybackAllocator.AllocationStatus status, uint256 predUSD, uint256 predStEth) = allocator
            .spendable();
        uint256 executorBefore = stEth.balanceOf(address(executor));

        try allocator.allocate() {
            uint256 moved = stEth.balanceOf(address(executor)) - executorBefore;
            bool eligible = status == IBuybackAllocator.AllocationStatus.Eligible;
            if (moved != (eligible ? predStEth : 0)) ghostSpendableMismatch = true;
            if (eligible) {
                ghostSpentUSD += predUSD;
                ghostEligibleAllocations += 1;
            }
        } catch {
            ghostAllocateReverted = true;
        }
    }
}

contract BuybackAllocatorInvariant is StdInvariant, Test {
    BuybackAllocator internal allocator;
    StEthTokenStub internal stEth;
    OracleRouterUsdStub internal oracle;
    ExecutorStub internal executor;
    AllocatorHandler internal handler;

    uint256 internal constant SOURCE_POOL = 5;
    uint128 internal constant DAILY_CAP = 1_000_000e18;
    uint128 internal constant YEARLY_CAP = 100_000_000e18;
    uint128 internal constant MIN_SPEND = 1e18;
    // Non-zero so the price-floor branch (StEthPriceBelowMin) is exercised: setPrice ranges over
    // [0, 100_000e18] and crosses this threshold.
    uint128 internal constant MIN_PRICE = 1_000e18;
    uint256 internal constant ONE_DAY = 1 days;
    uint256 internal constant ONE_YEAR = 365 days;

    /// @dev Builds an allocator over the given stubs. Caller activates and wires roles.
    function _deploy(
        StEthTokenStub stEth_,
        OracleRouterUsdStub oracle_,
        ExecutorStub executor_,
        address[] memory sources_,
        uint128 reserveRate_,
        uint16 surplusShareBP_
    ) internal returns (BuybackAllocator) {
        return
            new BuybackAllocator(
                BuybackAllocator.ConstructorParams({
                    admin: address(this),
                    treasury: address(this),
                    stEth: address(stEth_),
                    oracleRouter: address(oracle_),
                    executor: address(executor_),
                    dailyCapUSD: DAILY_CAP,
                    yearlyCapUSD: YEARLY_CAP,
                    reserveDailyRateUSD: reserveRate_,
                    minStEthPriceUSD: MIN_PRICE,
                    minSpendPerCallUSD: MIN_SPEND,
                    surplusShareBP: surplusShareBP_,
                    revenueSources: sources_
                })
            );
    }

    function _single(RevenueSourceStub source_) internal pure returns (address[] memory sources) {
        sources = new address[](1);
        sources[0] = address(source_);
    }

    function setUp() public {
        vm.warp(1_700_000_000); // a sane non-zero starting time (14 November 2023, 22:13:20 UTC)

        stEth = new StEthTokenStub();
        oracle = new OracleRouterUsdStub();
        executor = new ExecutorStub();
        oracle.setUsdPrice(3500e18, 3500e18); // stETH/USD, PRICE_UNIT == 1e18

        // Start with no sources; the handler registers them from its pool as it fuzzes. Baseline 0.
        allocator = _deploy(stEth, oracle, executor, new address[](0), 1_000e18, 5_000);
        allocator.activate();

        RevenueSourceStub[] memory sources = new RevenueSourceStub[](SOURCE_POOL);
        for (uint256 i = 0; i < sources.length; ++i) {
            sources[i] = new RevenueSourceStub();
        }

        handler = new AllocatorHandler(allocator, stEth, oracle, executor, sources);

        // Source registration and the share/reserve setters are admin-gated; let the handler call them.
        allocator.grantRole(allocator.DEFAULT_ADMIN_ROLE(), address(handler));

        targetContract(address(handler));
    }

    /// @notice No stETH is created or destroyed: allocator + executor balances equal all minted.
    function invariant_stEthConservation() public view {
        assertEq(
            stEth.balanceOf(address(allocator)) + stEth.balanceOf(address(executor)),
            handler.ghostTotalMinted()
        );
    }

    /// @notice The daily window never spends past its cap, however the cap was moved (the handler
    ///         never lowers it below what the window already spent).
    function invariant_dailyCapRespected() public view {
        (, uint192 spentUSD) = allocator.daily();
        assertLe(uint256(spentUSD), allocator.dailyCapUSD());
    }

    /// @notice The yearly window never spends past its cap, however the cap was moved.
    function invariant_yearlyCapRespected() public view {
        (, uint192 spentUSD) = allocator.yearly();
        assertLe(uint256(spentUSD), allocator.yearlyCapUSD());
    }

    /// @notice With every source reachable, as in this harness, allocate() never reverts: it only
    ///         proceeds or skips via event.
    function invariant_allocateNeverReverts() public view {
        assertFalse(handler.ghostAllocateReverted());
    }

    /// @notice spendable() exactly predicts what allocate() transfers in the same block.
    function invariant_spendablePredictsAllocate() public view {
        assertFalse(handler.ghostSpendableMismatch());
    }

    /// @notice No-double-count bound: the total USD ever allocated cannot exceed the revenue grown
    ///         while its source was registered. Holds for any surplus-share/reserve/registration
    ///         sequence because the share is <= 100% and the reserve only reduces the budget — so
    ///         banked budget <= registered revenue growth, and spend <= banked budget.
    function invariant_spentNeverExceedsRevenue() public view {
        assertLe(handler.ghostSpentUSD(), handler.ghostRegisteredRevenue());
    }

    /// @notice Spend windows stay aligned to the activation genesis: their end is always an exact
    ///         number of window durations after activation, however many times they rolled.
    function invariant_windowGenesisAligned() public view {
        uint256 genesis = allocator.activationTS();
        (uint64 dailyEnd, ) = allocator.daily();
        (uint64 yearlyEnd, ) = allocator.yearly();
        assertEq((uint256(dailyEnd) - genesis) % ONE_DAY, 0);
        assertEq((uint256(yearlyEnd) - genesis) % ONE_YEAR, 0);
    }

    /// @notice The executor is notified exactly once per allocation that proceeds, and never on a
    ///         skip: its callback count equals the number of eligible allocations.
    function invariant_executorNotifiedPerAllocation() public view {
        assertEq(executor.onStEthAllocatedCount(), handler.ghostEligibleAllocations());
    }

    /// @notice The activation and reserve anchor stay midnight-aligned — the reserve accrual and
    ///         window rolls derive day counts from them.
    function invariant_anchorsMidnightAligned() public view {
        assertEq(allocator.activationTS() % ONE_DAY, 0);
        assertEq(allocator.reserveAnchorTS() % ONE_DAY, 0);
    }

    /// @notice Reserve accrual is exact and never double-charged across the checkpoint re-anchor:
    ///         after `d` whole days the reserve charged is `rate * (d + 1)` (the activation/anchor
    ///         day plus each full day since), nothing more. Isolated with surplusShare = 100%, zero
    ///         revenue and no stETH, so the post-checkpoint budget is exactly `-reserve`.
    function testFuzz_reserveAccrual(uint128 rate, uint256 daysForward) public {
        rate = uint128(bound(rate, 0, 1e21));
        uint256 d = bound(daysForward, 0, 1000);

        StEthTokenStub s = new StEthTokenStub();
        OracleRouterUsdStub o = new OracleRouterUsdStub();
        o.setUsdPrice(3500e18, 3500e18);
        ExecutorStub e = new ExecutorStub();
        RevenueSourceStub r = new RevenueSourceStub();

        BuybackAllocator a = _deploy(s, o, e, _single(r), rate, 10_000);
        a.activate();

        vm.warp(block.timestamp + d * ONE_DAY);
        a.allocate(); // checkpoints; budget is negative and no stETH, so nothing is spent

        assertEq(a.budgetUSD(), -int256(uint256(rate) * (d + 1)));
    }

    /// @notice Two checkpoints on the same day charge the reserve only once. The first checkpoint
    ///         re-anchors to the next day, so a second checkpoint still within the same day sees
    ///         `now < reserveAnchor` and accrues zero — the budget does not move.
    function testFuzz_reserveNotDoubleChargedSameDay(
        uint128 rate,
        uint256 daysForward,
        uint256 sameDaySeconds
    ) public {
        rate = uint128(bound(rate, 1, 1e21)); // non-zero so a double charge would be observable
        uint256 d = bound(daysForward, 0, 1000);

        StEthTokenStub s = new StEthTokenStub();
        OracleRouterUsdStub o = new OracleRouterUsdStub();
        o.setUsdPrice(3500e18, 3500e18);
        ExecutorStub e = new ExecutorStub();
        RevenueSourceStub r = new RevenueSourceStub();

        BuybackAllocator a = _deploy(s, o, e, _single(r), rate, 10_000);
        a.activate();

        vm.warp(block.timestamp + d * ONE_DAY);
        a.allocate(); // first checkpoint: reserve charged, re-anchors to next day
        int256 budgetAfterFirst = a.budgetUSD();

        // Advance but stay before the new anchor (same day), so no further reserve accrues.
        uint256 remaining = a.reserveAnchorTS() - block.timestamp;
        vm.warp(block.timestamp + bound(sameDaySeconds, 0, remaining - 1));
        a.allocate(); // second checkpoint, same day: reserve 0, revenue unchanged -> budget unchanged

        assertEq(a.budgetUSD(), budgetAfterFirst);
    }

    /// @notice An unreachable source blocks the budget update: allocate reverts and no state
    ///         changes, then a recovered read banks the live source's growth exactly once.
    ///         Isolated with surplusShare = 100% and zero reserve, so the post-recovery budget
    ///         is exactly the live source's growth.
    function testFuzz_unreachableSourceBlocksCheckpointUntilRecovery(
        uint256 liveBase,
        uint256 frozenBase,
        uint256 growth
    ) public {
        liveBase = bound(liveBase, 0, 1e24);
        frozenBase = bound(frozenBase, 0, 1e24);
        growth = bound(growth, 0, 1e24);

        StEthTokenStub s = new StEthTokenStub();
        OracleRouterUsdStub o = new OracleRouterUsdStub();
        o.setUsdPrice(3500e18, 3500e18);
        ExecutorStub e = new ExecutorStub();
        RevenueSourceStub live = new RevenueSourceStub();
        RevenueSourceStub frozen = new RevenueSourceStub();
        live.setCumulativeRevenueUSD(liveBase);
        frozen.setCumulativeRevenueUSD(frozenBase);

        address[] memory sources = new address[](2);
        sources[0] = address(live);
        sources[1] = address(frozen);
        BuybackAllocator a = _deploy(s, o, e, sources, 0, 10_000);
        a.activate(); // baseline = liveBase + frozenBase

        frozen.setReverting(true); // every revenue read now reverts
        live.setCumulativeRevenueUSD(liveBase + growth);

        vm.expectRevert(RevenueSourceStub.RevenueSourceStubReverting.selector);
        a.allocate();
        assertEq(a.budgetUSD(), int256(0));
        assertEq(a.lastTotalRevenueUSD(), liveBase + frozenBase);

        frozen.setReverting(false);
        a.allocate(); // checkpoint: revenueSum = liveBase + growth + frozenBase, no spend

        // budget = (liveBase + growth + frozenBase − (liveBase + frozenBase)) * 100% = growth
        assertEq(a.budgetUSD(), int256(growth));
    }
}
