// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IWstETH is IERC20 {
    function wrap(uint256 stEthAmount_) external returns (uint256 wstEthAmount);

    function unwrap(uint256 wstEthAmount_) external returns (uint256 stEthAmount);

    function getStETHByWstETH(uint256 wstEthAmount_) external view returns (uint256 stEthAmount);

    function getWstETHByStETH(uint256 stEthAmount_) external view returns (uint256 wstEthAmount);

    function stEthPerToken() external view returns (uint256);

    function stETH() external view returns (address);
}
