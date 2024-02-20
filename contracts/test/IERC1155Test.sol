// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

contract NFT_1155 is ERC1155 {
    constructor(string memory uri) ERC1155(uri) {
        _mint(msg.sender, 0, 10, "");
        _mint(msg.sender, 1, 10 ** 27, "");
        _mint(msg.sender, 2, 10 ** 18, "");
    }
}
