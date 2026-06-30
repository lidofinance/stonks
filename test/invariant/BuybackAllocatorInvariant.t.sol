// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {BuybackAllocator} from "contracts/automated-buybacks/BuybackAllocator.sol";
import {
    StEthTokenStub,
    RevenueSourceStub,
    ExecutorStub
} from "contracts/test/BuybackAllocatorStubs.sol";
import {OracleRouterUsdStub} from "contracts/test/StakingRevenueSourceStubs.sol";

/// @notice Drives random sequences of allocator actions (time warps, allocations, revenue growth,
///         source registration, stETH funding, param changes) while a ghost model records what must
///         always hold. Inputs are bounded to individually-valid calls so any revert or mismatch is
///         a real bug, not a rejected precondition. Caps are fixed here (their validation is fuzzed
///         in fast-check).
contract AllocatorHandler is Test {
    uint256 internal constant MAX_SOURCES = 50; // mirrors BuybackAllocator.MAX_REVENUE_SOURCES

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
    bool public ghostAllocateReverted; // allocate() ever reverted (it must only skip, never revert)
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

    /// @dev Advance time by up to ~400 days so windows roll and the reserve accrues.
    function warp(uint256 secondsForward) external {
        vm.warp(block.timestamp + bound(secondsForward, 0, 400 days));
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
        if (registered[i] || registeredCount >= MAX_SOURCES) return;
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

    /// @dev The core action. allocate() must never revert (only skip via event), its effect must
    ///      match the spendable() preview taken in the same block, and we bank the spent USD.
    function allocate() external {
        (BuybackAllocator.AllocationStatus status, uint256 predUSD, uint256 predStEth) = allocator
            .spendable();
        uint256 executorBefore = stEth.balanceOf(address(executor));

        try allocator.allocate() {
            uint256 moved = stEth.balanceOf(address(executor)) - executorBefore;
            bool eligible = status == BuybackAllocator.AllocationStatus.Eligible;
            if (moved != (eligible ? predStEth : 0)) ghostSpendableMismatch = true;
            if (eligible) ghostSpentUSD += predUSD;
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
                    minStEthPriceUSD: 0,
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
        vm.warp(1_700_000_000); // a sane non-zero starting time

        stEth = new StEthTokenStub();
        oracle = new OracleRouterUsdStub();
        executor = new ExecutorStub();
        oracle.setUsdPrice(3500e18, 3500e18); // stETH/USD, PRICE_UNIT == 1e18

        // Start with no sources; the handler registers them from its pool as it fuzzes. Baseline 0.
        allocator = _deploy(stEth, oracle, executor, new address[](0), 1_000e18, 5_000);
        allocator.activate();

        RevenueSourceStub[] memory pool = new RevenueSourceStub[](SOURCE_POOL);
        for (uint256 i = 0; i < pool.length; ++i) {
            pool[i] = new RevenueSourceStub();
        }

        handler = new AllocatorHandler(allocator, stEth, oracle, executor, pool);

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

    /// @notice The daily window never spends past its cap.
    function invariant_dailyCapRespected() public view {
        (, uint192 spentUSD) = allocator.daily();
        assertLe(uint256(spentUSD), DAILY_CAP);
    }

    /// @notice The yearly window never spends past its cap.
    function invariant_yearlyCapRespected() public view {
        (, uint192 spentUSD) = allocator.yearly();
        assertLe(uint256(spentUSD), YEARLY_CAP);
    }

    /// @notice allocate() never reverts — it only proceeds or skips via event.
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

    /// @notice A reverting source contributes zero to the budget math (and never breaks the
    ///         checkpoint): its lifetime total stays frozen in the baseline while the remaining
    ///         sources keep funding the budget. Isolated with surplusShare = 100% and zero reserve,
    ///         so the post-checkpoint budget is exactly the live source's growth minus the frozen one.
    function testFuzz_revenueSumExcludesRevertingSource(
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
        a.activate(); // strict baseline = liveBase + frozenBase

        frozen.setReverting(true); // excluded from the non-strict sum from now on
        live.setCumulativeRevenueUSD(liveBase + growth);

        a.allocate(); // checkpoint: revenueSum = liveBase + growth (frozen counted as 0), no spend

        // budget = (liveBase + growth − (liveBase + frozenBase)) * 100% = growth − frozenBase
        assertEq(a.budgetUSD(), int256(growth) - int256(frozenBase));
    }
}
