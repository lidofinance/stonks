// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract ERC_20 is ERC20 {
    constructor() ERC20("ERC_20", "STUB") {
        _mint(msg.sender, 1000000 ether); // Mint 1M tokens to deployer
    }
}
