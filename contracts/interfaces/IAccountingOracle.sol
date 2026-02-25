// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

interface IAccountingOracle {
    function GENESIS_TIME() external view returns (uint256);

    function SECONDS_PER_SLOT() external view returns (uint256);

    function getLastProcessingRefSlot() external view returns (uint256);
}
