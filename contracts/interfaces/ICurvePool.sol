// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

interface ICurvePool {
    function add_liquidity(uint256[2] calldata amounts, uint256 min_mint_amount)
        external
        returns (uint256 lpAmount);

    function remove_liquidity(uint256 amount, uint256[2] calldata min_amounts)
        external
        returns (uint256[2] memory withdrawn);

    function price_oracle() external view returns (uint256);

    function coins(uint256 index) external view returns (address);

    function balances(uint256 index) external view returns (uint256);
}
