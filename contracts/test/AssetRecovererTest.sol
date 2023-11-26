// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {AssetRecoverer} from "../lib/AssetRecoverer.sol";

contract AssetRecovererTest is AssetRecoverer {
    constructor(address agent_, address manager_) AssetRecoverer(agent_) {
        manager = manager_;
    }
}