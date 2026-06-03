// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IStETH} from "./IStETH.sol";
import {IOracleRouter} from "./IOracleRouter.sol";

/**
 * @title INESTController
 * @notice Public surface of the NEST Allocator.
 */
interface INESTController {
    enum AllocationStatus {
        Eligible,
        NoAvailableBudget,
        QuoteUnavailable,
        StEthPriceBelowMin,
        AllocationBelowMin
    }

    struct AllocationWindow {
        uint64 windowEnd;
        uint128 allocatedUSD;
    }

    function MAX_BASIS_POINTS() external view returns (uint256);

    function MAX_REVENUE_SOURCES() external view returns (uint256);

    function STETH() external view returns (IStETH);

    function ORACLE_ROUTER() external view returns (IOracleRouter);

    function GENESIS() external view returns (uint256);

    function CYCLE_DAYS() external view returns (uint256);

    function recipient() external view returns (address);

    function lifetimeAllocatedUSD() external view returns (uint256);

    function dailyCapUSD() external view returns (uint128);

    function cycleCapUSD() external view returns (uint128);

    function protectedPerDayUSD() external view returns (uint128);

    function minStEthQuoteUSD() external view returns (uint128);

    function minAllocationUSD() external view returns (uint128);

    function surplusShareBP() external view returns (uint16);

    function daily() external view returns (uint64 windowEnd, uint128 allocatedUSD);

    function cycle() external view returns (uint64 windowEnd, uint128 allocatedUSD);

    function canAllocate()
        external
        view
        returns (bool ok, AllocationStatus reason, uint256 allocationUSD, uint256 allocationStEth);

    function protectedRevenueUSD() external view returns (uint256);

    function getRevenueSources() external view returns (address[] memory);

    function getStEthPriceUSD() external view returns (uint256);

    function allocate() external;

    function setRecipient(address newRecipient_) external;

    function setDailyCapUSD(uint128 dailyCapUSD_) external;

    function setCycleCapUSD(uint128 cycleCapUSD_) external;

    function setProtectedPerDayUSD(uint128 protectedPerDayUSD_) external;

    function setMinStEthQuoteUSD(uint128 minStEthQuoteUSD_) external;

    function setMinAllocationUSD(uint128 minAllocationUSD_) external;

    function setSurplusShareBP(uint16 surplusShareBP_) external;

    function addRevenueSource(address source_) external;

    function removeRevenueSource(address source_) external;
}
