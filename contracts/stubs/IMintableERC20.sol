// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

/// @notice Minting surface shared by the ERC20 stubs, used across stubs to settle balances.
interface IMintableERC20 {
    function mint(address to_, uint256 amount_) external;
}
