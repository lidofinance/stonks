// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

abstract contract RecoverERC20 {
    using SafeERC20 for IERC20;

    address public constant ARAGON_AGENT = 0x7Cd64b87251f793027590c34b206145c3aa362Ae;
    address public operator;

    event ERC20Recovered(
        address indexed _token,
        address indexed _recipient,
        uint256 _amount
    );

    function _recoverERC20(address tokenAddress, address tokenReceiver, uint256 tokenAmount) internal virtual {
        IERC20(tokenAddress).safeTransfer(tokenReceiver, tokenAmount);
        emit ERC20Recovered(tokenAddress, tokenReceiver, tokenAmount);
    }

    modifier onlyOperator() {
        require(msg.sender == operator || msg.sender == ARAGON_AGENT, "Stonks: not operator");
        _;
    }
}