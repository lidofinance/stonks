// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {AssetRecoverer} from "../AssetRecoverer.sol";

/**
 * @title Test contract for AssetRecoverer functionality.
 */
contract AssetRecovererTest is AssetRecoverer {
    // ==================== Constructor ====================

    /**
     * @notice Initializes the test contract.
     * @param admin_ Admin address.
     * @param agent_ Address of the Lido DAO agent.
     * @param manager_ Manager address.
     */
    constructor(address admin_, address agent_, address manager_) AssetRecoverer(admin_, agent_) {
        manager = manager_;
    }
}
