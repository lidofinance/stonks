// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {IMintableERC20} from "./IMintableERC20.sol";

/**
 * @notice wstETH stub. Wraps stETH at a settable share rate, with an optional 1-wei wrap round-down
 *         to exercise the executor's use of the minted amount. Doubles as the wstETH ERC20.
 */
contract WstEthStub is ERC20 {
    uint256 internal constant SHARE_RATE_UNIT = 1e18;

    address public stEthAddress;
    uint256 public stEthPerTokenValue = SHARE_RATE_UNIT;
    bool public roundDownWrap;

    constructor(address stEthAddress_) ERC20("Wrapped stETH stub", "wstETHstub") {
        stEthAddress = stEthAddress_;
    }

    function setStEth(address stEthAddress_) external {
        stEthAddress = stEthAddress_;
    }

    function setStEthPerToken(uint256 stEthPerTokenValue_) external {
        stEthPerTokenValue = stEthPerTokenValue_;
    }

    function setRoundDownWrap(bool roundDownWrap_) external {
        roundDownWrap = roundDownWrap_;
    }

    function mint(address to_, uint256 amount_) external {
        _mint(to_, amount_);
    }

    function stETH() external view returns (address) {
        return stEthAddress;
    }

    function stEthPerToken() external view returns (uint256) {
        return stEthPerTokenValue;
    }

    function getStETHByWstETH(uint256 wstEthAmount_) public view returns (uint256) {
        return (wstEthAmount_ * stEthPerTokenValue) / SHARE_RATE_UNIT;
    }

    function getWstETHByStETH(uint256 stEthAmount_) public view returns (uint256) {
        return (stEthAmount_ * SHARE_RATE_UNIT) / stEthPerTokenValue;
    }

    function wrap(uint256 stEthAmount_) external returns (uint256 wstEthAmount) {
        ERC20(stEthAddress).transferFrom(msg.sender, address(this), stEthAmount_);

        wstEthAmount = getWstETHByStETH(stEthAmount_);
        if (roundDownWrap && wstEthAmount > 0) {
            wstEthAmount -= 1;
        }

        _mint(msg.sender, wstEthAmount);
    }

    function unwrap(uint256 wstEthAmount_) external returns (uint256 stEthAmount) {
        _burn(msg.sender, wstEthAmount_);

        stEthAmount = getStETHByWstETH(wstEthAmount_);
        IMintableERC20(stEthAddress).mint(msg.sender, stEthAmount);
    }
}
