// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title ITwocrypto - Interface for Curve Twocrypto pool
interface ITwocrypto {
    function get_virtual_price() external view returns (uint256);

    function price_oracle() external view returns (uint256);

    function coins(uint256 index) external view returns (address);

    function balances(uint256 index) external view returns (uint256);

    function add_liquidity(
        uint256[2] calldata amounts,
        uint256 min_mint_amount
    ) external returns (uint256);

    function remove_liquidity(
        uint256 _amount,
        uint256[2] calldata min_amounts
    ) external returns (uint256[2] memory);

    function remove_liquidity_one_coin(
        uint256 _token_amount,
        int128 i,
        uint256 min_amount
    ) external returns (uint256);

    function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) external returns (uint256);

    function exchange_underlying(
        int128 i,
        int128 j,
        uint256 dx,
        uint256 min_dy
    ) external returns (uint256);

    function calc_token_amount(
        uint256[2] calldata amounts,
        bool is_deposit
    ) external view returns (uint256);

    function calc_withdraw_one_coin(
        uint256 _token_amount,
        int128 i
    ) external view returns (uint256);

    function lp_token() external view returns (address);
}
