// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

contract Swapper {
    address public priceChecker;

    address public immutable fromToken;
    address public immutable toToken;

    address public constant ORDER = address(0);
    address public constant ARAGON_AGENT = address(0);
    address public constant TREASURY = address(0);
    address public constant TREASURY_MULTISIG = address(0);

    constructor(address fromToken_, address toToken_, address priceChecker_) {
        fromToken = fromToken_;
        toToken = toToken_;
        priceChecker = priceChecker_;
    }

    function requestSwap() public {}
    function cancelSwap() public onlyOperator {}

    modifier onlyOperator() {
        require(msg.sender == TREASURY_MULTISIG || msg.sender == ARAGON_AGENT, "Swapper: not operator");
        _;
    }
}
