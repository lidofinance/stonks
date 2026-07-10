// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title ITwocryptoNGPool
 * @notice Test-only view of a Curve TwoCrypto-NG pool (which is also its own LP token). Covers the
 *         swap and oracle surface the integration tests exercise but the production `ICurvePool`
 *         intentionally omits (`exchange`, `get_dy`, `price_scale`). Extends `IERC20` for the LP
 *         token reads (`totalSupply`, `balanceOf`, `approve`).
 */
interface ITwocryptoNGPool is IERC20 {
    function add_liquidity(
        uint256[2] calldata amounts,
        uint256 min_mint_amount
    ) external returns (uint256);

    function remove_liquidity(
        uint256 amount,
        uint256[2] calldata min_amounts
    ) external returns (uint256[2] memory withdrawn);

    function exchange(
        uint256 i,
        uint256 j,
        uint256 dx,
        uint256 min_dy
    ) external returns (uint256);

    function get_dy(uint256 i, uint256 j, uint256 dx) external view returns (uint256);

    function coins(uint256 index) external view returns (address);

    function balances(uint256 index) external view returns (uint256);

    function price_oracle() external view returns (uint256);

    function price_scale() external view returns (uint256);
}
