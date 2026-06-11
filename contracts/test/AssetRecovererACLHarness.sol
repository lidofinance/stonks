// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {AssetRecovererACL} from "../automated-buybacks/AssetRecovererACL.sol";

/**
 * @title AssetRecovererACLHarness
 * @notice Test-only concretion of the abstract `AssetRecovererACL`. Forwards the constructor
 *         so the base recovery flows can be exercised directly without a full subclass in scope.
 */
contract AssetRecovererACLHarness is AssetRecovererACL {
    constructor(address admin_, address treasury_) AssetRecovererACL(admin_, treasury_) {}
}

/**
 * @title RevertingEtherReceiver
 * @notice Rejects every incoming ETH transfer. Exercises the `recoverEther` failure path
 *         when the treasury cannot accept the value.
 */
contract RevertingEtherReceiver {
    receive() external payable {
        revert("ETH rejected");
    }
}

/**
 * @title NoReturnValueERC20
 * @notice ERC-20 whose `transfer` returns no value, like USDT. Confirms `recoverERC20`
 *         recovers tokens that break the IERC20 return contract through SafeERC20.
 */
contract NoReturnValueERC20 {
    mapping(address account => uint256 balance) public balanceOf;

    constructor(uint256 initialSupply_) {
        balanceOf[msg.sender] = initialSupply_;
    }

    function transfer(address to_, uint256 amount_) external {
        balanceOf[msg.sender] -= amount_;
        balanceOf[to_] += amount_;
    }
}
