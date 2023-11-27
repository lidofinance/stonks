// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT

pragma solidity 0.8.19;

interface ICoWSwapSettlement {
    function domainSeparator() external view returns (bytes32);
}