// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

interface ITokenConverter {
    function getExpectedOut(uint256 amount, address tokenFrom, address tokenTo)
        external
        view
        returns (uint256);
}
