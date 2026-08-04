// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IOrder {
    function recoverTokenFrom() external;

    function emergencyCancelAndReturn() external;

    function emergencyRevokeRelayer() external;

    function recoverERC20(address token_, uint256 amount_) external;
}
