// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IAccountingOracle} from "../interfaces/IAccountingOracle.sol";

/**
 * @title AccountingOracleStub
 * @dev Controllable stub for IAccountingOracle used in unit tests.
 *      GENESIS_TIME and SECONDS_PER_SLOT are fixed at construction.
 *      setLastProcessingRefSlot controls getLastProcessingRefSlot().
 */
contract AccountingOracleStub is IAccountingOracle {
    uint256 public immutable GENESIS_TIME;
    uint256 public immutable SECONDS_PER_SLOT;

    uint256 private _lastProcessingRefSlot;

    constructor(uint256 genesisTime_, uint256 secondsPerSlot_) {
        GENESIS_TIME = genesisTime_;
        SECONDS_PER_SLOT = secondsPerSlot_;
    }

    function setLastProcessingRefSlot(uint256 slot_) external {
        _lastProcessingRefSlot = slot_;
    }

    function getLastProcessingRefSlot() external view returns (uint256) {
        return _lastProcessingRefSlot;
    }
}
