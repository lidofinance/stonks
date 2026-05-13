// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/**
 * @title ILiquidityProvisioner
 * @notice Minimal seam consumed by NESTController. Limited to the one call the controller makes
 *         on the provisioner. The controller's own balance transfers go through the wstETH ERC20.
 */
interface ILiquidityProvisioner {
    function unwrapExcessWstEth() external returns (uint256 stEthAmount);
}
