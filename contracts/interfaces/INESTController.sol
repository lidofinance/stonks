// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

interface INESTController {
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

    function getSpendingState() external view returns (SpendingState memory);

    function stonks() external view returns (address);

    function accountForReturnedExcess(uint256 stEthAmount_) external;
}
