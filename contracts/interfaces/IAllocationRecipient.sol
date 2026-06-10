// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/**
 * @title IAllocationRecipient
 * @notice Hook the NESTController invokes on its recipient immediately after pushing an
 *         allocation of stETH, letting the recipient act on the freshly received funds.
 */
interface IAllocationRecipient {
    /// @notice Called by the controller right after a stETH allocation is transferred in.
    function onStEthAllocated() external;
}
