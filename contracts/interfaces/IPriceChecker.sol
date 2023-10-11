// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

interface IPriceChecker {
    function getExpectedOut(uint256 amount, address tokenFrom, address tokenTo, uint16 margin)
        external
        view
        returns (uint256);
}
