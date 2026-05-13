// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

interface ICurvePool {
    function add_liquidity(uint256[2] calldata amounts_, uint256 minMintAmount_)
        external
        returns (uint256 lpAmount);

    function remove_liquidity(uint256 lpAmount_, uint256[2] calldata minAmounts_)
        external
        returns (uint256[2] memory withdrawn);

    function calc_token_amount(uint256[2] calldata amounts_, bool isDeposit_)
        external
        view
        returns (uint256 lpAmount);

    function price_oracle() external view returns (uint256);

    function coins(uint256 index_) external view returns (address);

    function balances(uint256 index_) external view returns (uint256);
}
