// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

contract NFT_1155 is ERC1155 {
    using Address for address;

    constructor(string memory uri, address tokenHolder) ERC1155(uri) {
        _mint(tokenHolder, 0, 10, "");
        _mint(tokenHolder, 1, 1000, "");
        _mint(tokenHolder, 2, 1000, "");
    }

    function mint(address to, uint256 id, uint256 amount, bytes memory data) external {
        _mint(to, id, amount, data);
    }
}
