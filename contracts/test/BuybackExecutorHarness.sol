// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {BuybackExecutor} from "../automated-buybacks/BuybackExecutor.sol";

/**
 * @title BuybackExecutorHarness
 * @notice Test-only subclass of `BuybackExecutor` that exposes the read-only internals the unit
 *         suite asserts directly. Mirrors the `RevenueSourceHarness` pattern.
 */
contract BuybackExecutorHarness is BuybackExecutor {
    constructor(InitParams memory initParams_) BuybackExecutor(initParams_) {}

    function evaluatePoolPriceDivergence()
        external
        view
        returns (
            AddLiquidityStatus status,
            uint256 ldoUsdPrice,
            uint256 stEthUsdPrice,
            uint256 oracleLdoPerStEth,
            uint256 poolEmaLdoPerStEth,
            uint256 divergenceBps
        )
    {
        return _evaluatePoolPriceDivergence();
    }

    function evaluateAddLiquidityGates() external view returns (AddLiquidityEvaluation memory) {
        return _evaluateAddLiquidityGates();
    }

    function computeBalancedAmounts(
        uint256 ldoBalance_,
        uint256 stEthBalance_,
        uint256 ldoUsdPrice_,
        uint256 stEthUsdPrice_
    ) external view returns (uint256 ldoAmount, uint256 stEthAmount, uint256 depositValueUsd) {
        return _computeBalancedAmounts(ldoBalance_, stEthBalance_, ldoUsdPrice_, stEthUsdPrice_);
    }

    function poolTvlUsd(
        uint256 ldoUsdPrice_,
        uint256 stEthUsdPrice_
    ) external view returns (uint256) {
        return _poolTvlUsd(ldoUsdPrice_, stEthUsdPrice_);
    }

    function computeLpModeFreeStEth() external view returns (uint256) {
        return _computeLpModeFreeStEth();
    }
}
