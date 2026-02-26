// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IERC20WstETH} from "../interfaces/IERC20WstETH.sol";

/**
 * @title WstETHStub
 * @dev Controllable stub for IERC20WstETH used in unit tests.
 *      setRate sets the return value of getStETHByWstETH for any input.
 *      setTotalSupply sets the return value of totalSupply.
 */
contract WstETHStub is IERC20WstETH {
    uint256 private _rate;
    uint256 private _totalSupply;

    function setRate(uint256 rate_) external {
        _rate = rate_;
    }

    function setTotalSupply(uint256 supply_) external {
        _totalSupply = supply_;
    }

    function getStETHByWstETH(uint256) external view returns (uint256) {
        return _rate;
    }

    function totalSupply() external view returns (uint256) {
        return _totalSupply;
    }
}
