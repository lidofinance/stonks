// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IOwnable {
    function manager() external view returns (address);
}
