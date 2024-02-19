// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

interface IAmountConverter {
    function getExpectedOut(address sellToken, address buyToken, uint256 amount) external view returns (uint256);
}
