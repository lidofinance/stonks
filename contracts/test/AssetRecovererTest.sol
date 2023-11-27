// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {AssetRecoverer} from "../AssetRecoverer.sol";

contract AssetRecovererTest is AssetRecoverer {
    constructor(address agent_, address manager_) AssetRecoverer(agent_) {
        manager = manager_;
    }
}