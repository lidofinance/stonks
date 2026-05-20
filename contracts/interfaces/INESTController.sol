// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IStETH} from "./IStETH.sol";
import {IWstETH} from "./IWstETH.sol";
import {IOracleRouter} from "./IOracleRouter.sol";

/**
 * @title INESTController
 * @notice Public surface of the NEST automated-buyback controller. Covers configuration,
 *         execution entry points, pipeline state reads, pass-throughs to Stonks and Order, and
 *         the `accountForReturnedExcess` callback consumed by the LiquidityProvisioner. See
 *         `NESTController` for per-function semantics and constraints.
 */
interface INESTController {
    /// @notice Aggregated pipeline and annual spend state, returned by `getSpendingState`.
    struct SpendingState {
        uint256 lastTriggerOrderTimestamp;
        uint256 lastAccountingTimestamp;
        uint256 lastOrderTimestamp;
        address lastOrderAddress;
        uint256 orderDurationSeconds;
        uint256 annualCapUSD;
        uint256 annualSpendAccumulatorUSD;
        uint256 annualPeriodStart;
        int256 allocatedForBuybacksUSD;
        uint256 cumulativeBuybacksUSD;
        int256 lastDailyAllocationUSD;
    }

    /// @notice Per-source snapshot returned by `getRevenueSourcesWithStatus`.
    struct RevenueSourceStatus {
        address source;
        uint256 lastRevenueUSD;
        uint256 reportTimestamp;
        bool isPaused;
        bool isStale;
    }

    function MAX_BASIS_POINTS() external view returns (uint256);

    function TRIGGER_INTERVAL_SECONDS() external view returns (uint256);

    function MAX_REVENUE_SOURCES() external view returns (uint256);

    function STETH() external view returns (IStETH);

    function WSTETH() external view returns (IWstETH);

    function LDO() external view returns (IERC20);

    function ORACLE_ROUTER() external view returns (IOracleRouter);

    function stonks() external view returns (address);

    function liquidityProvisioner() external view returns (address);

    function ethPriceFloorUSD() external view returns (uint128);

    function dailyRevenueThresholdUSD() external view returns (uint128);

    function surplusShareBps() external view returns (uint16);

    function dailyCapUSD() external view returns (uint128);

    function annualCapUSD() external view returns (uint128);

    function minOrderSizeUSD() external view returns (uint128);

    function orderDurationSeconds() external view returns (uint64);

    function lastAccountingTimestamp() external view returns (uint64);

    function lastTriggerOrderTimestamp() external view returns (uint64);

    function annualPeriodStart() external view returns (uint64);

    function lastOrderTimestamp() external view returns (uint96);

    function lastOrderAddress() external view returns (address);

    function allocatedForBuybacksUSD() external view returns (int256);

    function cumulativeBuybacksUSD() external view returns (uint256);

    function lastDailyAllocationUSD() external view returns (int256);

    function annualSpendAccumulatorUSD() external view returns (uint256);

    function outstandingWrappedStEth() external view returns (uint128);

    function outstandingWrappedCommittedUsd() external view returns (uint128);

    function isExecutionPaused() external view returns (bool);

    function canTriggerExecution() external view returns (bool);

    function canRetryFromStonks() external view returns (bool);

    function getSpendingState() external view returns (SpendingState memory);

    function getOrderState()
        external
        view
        returns (
            uint256 lastOrderTimestamp,
            uint256 orderDurationSeconds,
            address lastOrderAddress,
            address stonksAddress
        );

    function getRevenueSourcesWithStatus() external view returns (RevenueSourceStatus[] memory);

    function getEthPriceUSD() external view returns (uint256);

    function getDailySurplus() external view returns (uint256 totalRevenueUSD, int256 surplusUSD);

    function getAvailableStEthBalance() external view returns (uint256);

    function triggerExecution() external returns (address order);

    function retryFromStonks() external returns (address order);

    function accountForReturnedExcess(uint256 stEthAmount_) external;

    function setEthPriceFloorUSD(uint128 ethPriceFloorUSD_) external;

    function setDailyRevenueThresholdUSD(uint128 dailyRevenueThresholdUSD_) external;

    function setRevenueSurplusShareBps(uint16 surplusShareBps_) external;

    function setDailyCapUSD(uint128 dailyCapUSD_) external;

    function setAnnualCapUSD(uint128 annualCapUSD_) external;

    function setMinOrderSizeUSD(uint128 minOrderSizeUSD_) external;

    function addRevenueSource(address source_) external;

    function removeRevenueSource(address source_) external;

    function setStonks(address stonks_) external;

    function setStonksAndProvisioner(address stonks_, address liquidityProvisioner_) external;

    function resetBuybackAccounting() external;

    function creditReturnedSpend(uint256 usdAmount_, uint256 commitmentTimestamp_) external;

    function pauseExecution() external;

    function unpauseExecution() external;

    function pauseStonksOrderCreation() external;

    function unpauseStonksOrderCreation() external;

    function pauseStonksOrderSignatures() external;

    function unpauseStonksOrderSignatures() external;

    function recoverFromStonks(address stonks_, address token_, uint256 amount_) external;

    function emergencyCancelOrder(address order_) external;

    function emergencyRevokeOrderRelayer(address order_) external;

    function recoverERC20FromOrder(address order_, address token_, uint256 amount_) external;
}
