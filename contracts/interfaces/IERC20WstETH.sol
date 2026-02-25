// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

interface IERC20WstETH {
    function getStETHByWstETH(uint256 wstETHAmount_) external view returns (uint256);

    function totalSupply() external view returns (uint256);
}
