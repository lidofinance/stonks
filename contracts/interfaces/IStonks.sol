// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

interface IStonks {
    function getOrderParameters()
        external
        view
        returns (address tokenFrom, address tokenTo, uint256 orderDurationInSeconds);
    function getPriceTolerance() external view returns (uint256);
    function estimateTradeOutput(uint256 amount) external view returns (uint256);
}
