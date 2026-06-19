// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IStETH} from "./IStETH.sol";
import {IOracleRouter} from "./IOracleRouter.sol";

/**
 * @title IBuybackAllocator
 * @notice Public surface of the BuybackAllocator.
 */
interface IBuybackAllocator {
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

    function MAX_BASIS_POINTS() external view returns (uint256);

    function MAX_REVENUE_SOURCES() external view returns (uint256);

    function STETH() external view returns (IStETH);

    function ORACLE_ROUTER() external view returns (IOracleRouter);

    function dailyCapUSD() external view returns (uint128);

    function yearlyCapUSD() external view returns (uint128);

    function reserveDailyRateUSD() external view returns (uint128);

    function minStEthPriceUSD() external view returns (uint128);

    function minSpendPerCallUSD() external view returns (uint128);

    function surplusShareBP() external view returns (uint16);

    function executor() external view returns (address);

    function activationTS() external view returns (uint256);

    function lastTotalRevenueUSD() external view returns (uint256);

    function budgetUSD() external view returns (uint256);

    function reserveAnchorTS() external view returns (uint256);

    function daily() external view returns (uint64 endTS, uint192 spentUSD);

    function yearly() external view returns (uint64 endTS, uint192 spentUSD);

    function spendable()
        external
        view
        returns (AllocationStatus status, uint256 spendableUSD, uint256 spendableStEth);

    function activate(uint128 reserveDailyRateUSD_) external;

    function allocate() external;

    function setSurplusShareBP(uint16 surplusShareBP_) external;

    function setReserveDailyRateUSD(uint128 reserveDailyRateUSD_) external;

    function setDailyCapUSD(uint128 dailyCapUSD_) external;

    function setYearlyCapUSD(uint128 yearlyCapUSD_) external;

    function setMinStEthPriceUSD(uint128 minStEthPriceUSD_) external;

    function setMinSpendPerCallUSD(uint128 minSpendPerCallUSD_) external;

    function setExecutor(address newExecutor_) external;

    function addRevenueSource(address source_) external;

    function removeRevenueSource(address source_) external;
}
