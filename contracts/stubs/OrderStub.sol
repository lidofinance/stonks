// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

/**
 * @notice Order stub. Records `recoverTokenFrom` calls. Its residual stETH is the stETH stub
 *         balance minted to this address.
 */
contract OrderStub {
    event RecoverTokenFromCalled();

    uint256 public recoverTokenFromCalls;

    function recoverTokenFrom() external {
        recoverTokenFromCalls += 1;
        emit RecoverTokenFromCalled();
    }
}
