// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IStETH} from "./IStETH.sol";
import {IWstETH} from "./IWstETH.sol";
import {IOracleRouter} from "./IOracleRouter.sol";

interface INESTController {
    function MAX_BASIS_POINTS() external view returns (uint256);

    function TRIGGER_INTERVAL_SECONDS() external view returns (uint256);

    function MAX_REVENUE_SOURCES() external view returns (uint256);

    function STETH() external view returns (IStETH);

    function WSTETH() external view returns (IWstETH);

    function LDO() external view returns (IERC20);

    function ORACLE_ROUTER() external view returns (IOracleRouter);

    function stonks() external view returns (address);

    function liquidityProvisioner() external view returns (address);

    function ethPriceFloorUSD() external view returns (uint256);

    function dailyRevenueThresholdUSD() external view returns (uint256);

    function surplusShareBps() external view returns (uint256);

    function dailyCapUSD() external view returns (uint256);

    function annualCapUSD() external view returns (uint256);

    function minOrderSizeUSD() external view returns (uint256);

    function orderPriceProtectionBps() external view returns (uint256);

    function orderDurationSeconds() external view returns (uint256);

    function lastAccountingTimestamp() external view returns (uint256);

    function lastTriggerOrderTimestamp() external view returns (uint256);

    function annualPeriodStart() external view returns (uint256);

    function lastOrderTimestamp() external view returns (uint256);

    function lastOrderAddress() external view returns (address);

    function allocatedForBuybacksUSD() external view returns (int256);

    function cumulativeBuybacksUSD() external view returns (uint256);

    function lastDailyAllocationUSD() external view returns (int256);

    function annualSpendAccumulatorUSD() external view returns (uint256);

    function setEthPriceFloorUSD(uint256 ethPriceFloorUSD_) external;

    function setDailyRevenueThresholdUSD(uint256 dailyRevenueThresholdUSD_) external;

    function setRevenueSurplusShareBps(uint256 surplusShareBps_) external;

    function setDailyCapUSD(uint256 dailyCapUSD_) external;

    function setAnnualCapUSD(uint256 annualCapUSD_) external;

    function setMinOrderSizeUSD(uint256 minOrderSizeUSD_) external;

    function setOrderPriceProtectionBps(uint256 orderPriceProtectionBps_) external;

    function addRevenueSource(address source_) external;

    function removeRevenueSource(address source_) external;

    function setLiquidityProvisioner(address liquidityProvisioner_) external;

    function setStonks(address stonks_) external;

    function resetBuybackAccounting() external;

    function pauseExecution() external;

    function unpauseExecution() external;

    function pauseStonksOrderCreation() external;

    function unpauseStonksOrderCreation() external;

    function pauseStonksOrderSignatures() external;

    function unpauseStonksOrderSignatures() external;

    function recoverFromStonks(address token_, uint256 amount_) external;

    function emergencyCancelOrder(address order_) external;

    function emergencyRevokeOrderRelayer(address order_) external;

    function recoverERC20FromOrder(address order_, address token_, uint256 amount_) external;
}
