// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

abstract contract RecoverERC20 {
    using SafeERC20 for IERC20;

    function _recoverERC20(address tokenAddress, address tokenReceiver, uint256 tokenAmount) internal virtual {
        IERC20(tokenAddress).safeTransfer(tokenReceiver, tokenAmount);
    }
}