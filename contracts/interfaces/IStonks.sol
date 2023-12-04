// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

interface IStonks {
    struct OrderParameters {
        address tokenFrom;
        address tokenTo;
        uint32 orderDurationInSeconds;
        uint16 marginInBasisPoints;
        uint16 priceToleranceInBasisPoints;
    }

    function getOrderParameters() external view returns (OrderParameters memory);
    function estimateTradeOutput(uint256 amount) external view returns (uint256);
}
