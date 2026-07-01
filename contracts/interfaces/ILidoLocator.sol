// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

/**
 * @title ILidoLocator (minimal)
 * @notice Subset of `LidoLocator` getters consumed by NEST revenue sources. Each getter is
 *         backed by an `immutable` in `LidoLocator` so calls are gas-cheap, but the locator
 *         contract itself is upgradeable behind a proxy — values may change across upgrades.
 */
interface ILidoLocator {
    function lido() external view returns (address);
    function stakingRouter() external view returns (address);
    function postTokenRebaseReceiver() external view returns (address);
}
