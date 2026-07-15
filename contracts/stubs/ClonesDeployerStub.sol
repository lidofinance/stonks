// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @title ClonesDeployerStub
 * @notice Test stub exposing OpenZeppelin `Clones.clone`, so tests can compare hand-assembled
 *         EIP-1167 bytecode against the canonical library output.
 */
contract ClonesDeployerStub {
    /**
     * @notice Deploys an EIP-1167 minimal proxy pointing at `implementation_`.
     * @param  implementation_ Address the proxy delegates to.
     * @return instance Address of the deployed proxy.
     */
    function clone(address implementation_) external returns (address instance) {
        instance = Clones.clone(implementation_);
    }
}
