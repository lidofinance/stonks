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

/**
 * @title NESTController
 * @author swissarmytowel <info@lido.fi>
 * @notice Allocates a configurable share of accrued revenue as stETH to a spender,
 *         capped per day and per year and gated by an oracle price floor.
 */
contract NESTController is AssetRecovererACL, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    struct AllocatorConfig {
        uint128 minEthPriceUSD;
        uint128 dailyCapUSD;
        uint128 annualCapUSD;
        uint128 minAllocationUSD;
        uint16  allocationShareBP;
    }

    struct SpendWindow {
        uint64  windowEnd;
        uint192 spentUSD;
    }

    struct InitParams {
        address admin;
        address treasury;
        address stEth;
        address ldo;
        address oracleRouter;
        address spender;
        AllocatorConfig config;
        address[] revenueSources;
    }

    enum SkipReason {
        OK,
        NoAvailableBudget,
        QuotabilityFailed,
        EthPriceBelowMin,
        AllocationBelowMin
    }

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 public constant MAX_BASIS_POINTS = 10_000;
    uint256 public constant MAX_REVENUE_SOURCES = 50;

    uint256 internal constant ONE_DAY = 1 days;
    uint256 internal constant ONE_YEAR = 365 days;

    /// @dev Matches OracleRouter's USD precision.
    uint256 internal constant PRICE_SCALE = 1e18;

    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    IStETH public immutable STETH;
    IERC20 public immutable LDO;
    IOracleRouter public immutable ORACLE_ROUTER;

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    AllocatorConfig public config;
    address public spender;
    uint256 public lifetimeSpentUSD;
    SpendWindow public daily;
    SpendWindow public annual;

    EnumerableSet.AddressSet internal _revenueSources;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event Allocated(
        address indexed triggeredBy,
        address indexed spender,
        uint256 budgetUSD,
        uint256 budgetStEth,
        uint256 lifetimeSpentUSD
    );
    event AllocationSkipped(address indexed caller, uint8 reason);
    event WindowRolled(uint256 windowDuration, uint256 newWindowEnd, uint256 previousSpentUSD);
    event SpenderSet(address indexed spender);
    event ConfigSet(AllocatorConfig config);
    event RevenueSourceAdded(address indexed source);
    event RevenueSourceRemoved(address indexed source);

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error InvalidStEthAddress(address stEth);
    error InvalidLdoAddress(address ldo);
    error InvalidOracleRouterAddress(address oracleRouter);
    error InvalidSpenderAddress(address spender);
    error InvalidConfig();
    error InvalidRevenueSourceAddress(address source);
    error RevenueSourceAlreadyRegistered(address source);
    error RevenueSourceNotRegistered(address source);
    error RevenueSourceLimitReached(uint256 maxSources);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(
        InitParams memory initParams_
    ) AssetRecovererACL(initParams_.admin, initParams_.treasury) {
        if (initParams_.stEth == address(0)) revert InvalidStEthAddress(initParams_.stEth);
        if (initParams_.ldo == address(0)) revert InvalidLdoAddress(initParams_.ldo);
        if (initParams_.oracleRouter == address(0)) {
            revert InvalidOracleRouterAddress(initParams_.oracleRouter);
        }
        if (initParams_.spender == address(0)) revert InvalidSpenderAddress(initParams_.spender);
        _validateConfig(initParams_.config);

        STETH = IStETH(initParams_.stEth);
        LDO = IERC20(initParams_.ldo);
        ORACLE_ROUTER = IOracleRouter(initParams_.oracleRouter);

        config = initParams_.config;
        spender = initParams_.spender;

        address[] memory sources = initParams_.revenueSources;
        if (sources.length > MAX_REVENUE_SOURCES) {
            revert RevenueSourceLimitReached(MAX_REVENUE_SOURCES);
        }
        for (uint256 i = 0; i < sources.length; ++i) {
            _registerRevenueSource(sources[i]);
        }
        
        lifetimeSpentUSD = _sumRevenueUSD();
    }

    /*//////////////////////////////////////////////////////////////
                        EXTERNAL - LIFECYCLE
    //////////////////////////////////////////////////////////////*/

    /// @notice Permissionless and idempotent. No-op when nothing is allocatable.
    function allocate() external nonReentrant {
        (bool ok, SkipReason reason, uint256 budgetUSD, uint256 budgetStEth) = _evaluate();
        if (!ok) {
            emit AllocationSkipped(msg.sender, uint8(reason));
            return;
        }

        _updateWindow(annual, ONE_YEAR, budgetUSD);
        _updateWindow(daily, ONE_DAY, budgetUSD);

        uint256 newLifetimeSpent = lifetimeSpentUSD + budgetUSD;
        lifetimeSpentUSD = newLifetimeSpent;

        IERC20(address(STETH)).safeTransfer(spender, budgetStEth);

        emit Allocated(msg.sender, spender, budgetUSD, budgetStEth, newLifetimeSpent);
    }

    /*//////////////////////////////////////////////////////////////
                       EXTERNAL - CONFIGURATION
    //////////////////////////////////////////////////////////////*/
    function setConfig(AllocatorConfig calldata newConfig_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _validateConfig(newConfig_);
        uint16 oldShareBP = config.allocationShareBP;
        config = newConfig_;

        if (oldShareBP != newConfig_.allocationShareBP) {
            lifetimeSpentUSD = _sumRevenueUSD();
        }

        emit ConfigSet(newConfig_);
    }

    function setSpender(address newSpender_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newSpender_ == address(0)) revert InvalidSpenderAddress(newSpender_);
        spender = newSpender_;
        emit SpenderSet(newSpender_);
    }

    function addRevenueSource(address source_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_revenueSources.length() >= MAX_REVENUE_SOURCES) {
            revert RevenueSourceLimitReached(MAX_REVENUE_SOURCES);
        }
        _registerRevenueSource(source_);

        lifetimeSpentUSD = _sumRevenueUSD();
    }

    function removeRevenueSource(address source_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!_revenueSources.remove(source_)) revert RevenueSourceNotRegistered(source_);
        lifetimeSpentUSD = _sumRevenueUSD();
        emit RevenueSourceRemoved(source_);
    }

    /*//////////////////////////////////////////////////////////////
                          EXTERNAL - VIEWS
    //////////////////////////////////////////////////////////////*/

    function canAllocate()
        external
        view
        returns (bool ok, uint8 reason, uint256 budgetUSD, uint256 budgetStEth)
    {
        SkipReason reasonEnum;
        (ok, reasonEnum, budgetUSD, budgetStEth) = _evaluate();
        reason = uint8(reasonEnum);
    }

    function getRevenueSources() external view returns (address[] memory) {
        return _revenueSources.values();
    }

    /// @notice Reverts on oracle failure.
    function getStEthPriceUSD() external view returns (uint256 stEthPriceUSD) {
        (stEthPriceUSD, ) = ORACLE_ROUTER.getUsdPrices(address(STETH), address(LDO));
    }

    /*//////////////////////////////////////////////////////////////
                              INTERNAL
    //////////////////////////////////////////////////////////////*/

    function _evaluate()
        internal
        view
        returns (bool ok, SkipReason reason, uint256 budgetUSD, uint256 budgetStEth)
    {
        AllocatorConfig memory cfg = config;

        // 1. Available budget = share of cumulative revenue minus lifetime spend.
        uint256 totalAllocation = (_sumRevenueUSD() * cfg.allocationShareBP) / MAX_BASIS_POINTS;
        if (totalAllocation <= lifetimeSpentUSD) {
            return (false, SkipReason.NoAvailableBudget, 0, 0);
        }
        budgetUSD = totalAllocation - lifetimeSpentUSD;

        // 2. Oracle must quote both legs; stETH (proxy for ETH) must clear the floor.
        (bool quotable, uint256 stEthPriceUSD) = _quoteStEthUSD();
        if (!quotable) return (false, SkipReason.QuotabilityFailed, 0, 0);
        if (cfg.minEthPriceUSD > stEthPriceUSD) {
            return (false, SkipReason.EthPriceBelowMin, 0, 0);
        }

        // 3. Clamp by spend caps, convert to stETH, clamp by balance.
        budgetUSD = _clampByWindow(budgetUSD, annual, cfg.annualCapUSD);
        budgetUSD = _clampByWindow(budgetUSD, daily, cfg.dailyCapUSD);

        budgetStEth = Math.min(
            (budgetUSD * PRICE_SCALE) / stEthPriceUSD,
            STETH.balanceOf(address(this))
        );
        budgetUSD = (budgetStEth * stEthPriceUSD) / PRICE_SCALE;

        // 4. Reject dust spends.
        if (budgetUSD < cfg.minAllocationUSD) {
            return (false, SkipReason.AllocationBelowMin, 0, 0);
        }

        return (true, SkipReason.OK, budgetUSD, budgetStEth);
    }

    /// @dev A reverting source contributes zero so it cannot brick allocation.
    function _sumRevenueUSD() internal view returns (uint256 total) {
        address[] memory sources = _revenueSources.values();
        for (uint256 i = 0; i < sources.length; ++i) {
            try IRevenueSource(sources[i]).totalRevenueUSD() returns (uint256 sourceTotal) {
                total += sourceTotal;
            } catch {}
        }
    }

    /// @dev ok=false on revert or any zero leg.
    function _quoteStEthUSD() internal view returns (bool ok, uint256 stEthPriceUSD) {
        try ORACLE_ROUTER.getUsdPrices(address(STETH), address(LDO)) returns (
            uint256 stEthPrice,
            uint256 ldoPrice
        ) {
            if (stEthPrice == 0 || ldoPrice == 0) return (false, 0);
            return (true, stEthPrice);
        } catch {
            return (false, 0);
        }
    }

    /// @dev An expired window contributes zero spent.
    function _clampByWindow(
        uint256 budgetUSD_,
        SpendWindow memory window_,
        uint256 capUSD_
    ) internal view returns (uint256) {
        uint256 spent = block.timestamp >= window_.windowEnd ? 0 : window_.spentUSD;
        if (spent >= capUSD_) return 0;
        return Math.min(budgetUSD_, capUSD_ - spent);
    }

    function _updateWindow(
        SpendWindow storage window_,
        uint256 windowDuration_,
        uint256 budgetUSD_
    ) internal {
        uint192 spent = window_.spentUSD;
        if (block.timestamp >= window_.windowEnd) {
            uint64 newWindowEnd = uint64(block.timestamp + windowDuration_);
            emit WindowRolled(windowDuration_, newWindowEnd, spent);
            window_.windowEnd = newWindowEnd;
            spent = 0;
        }
        window_.spentUSD = spent + uint192(budgetUSD_);
    }

    function _registerRevenueSource(address source_) internal {
        if (source_ == address(0)) revert InvalidRevenueSourceAddress(source_);
        // Reachability check
        IRevenueSource(source_).totalRevenueUSD();
        if (!_revenueSources.add(source_)) revert RevenueSourceAlreadyRegistered(source_);
        emit RevenueSourceAdded(source_);
    }

    function _validateConfig(AllocatorConfig memory cfg_) internal pure {
        if (cfg_.allocationShareBP == 0 || cfg_.allocationShareBP > MAX_BASIS_POINTS) {
            revert InvalidConfig();
        }
        if (cfg_.dailyCapUSD == 0 || cfg_.annualCapUSD == 0 || cfg_.minAllocationUSD == 0) {
            revert InvalidConfig();
        }
        if (cfg_.dailyCapUSD >= cfg_.annualCapUSD) revert InvalidConfig();
        if (cfg_.minAllocationUSD > cfg_.dailyCapUSD) revert InvalidConfig();
    }
}
