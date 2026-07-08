// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IAssetRecoverer {
    function recoverEther() external;

    function recoverERC20(address token_, uint256 amount_) external;

    function recoverERC721(address token_, uint256 tokenId_) external;

    function recoverERC1155(address token_, uint256 tokenId_) external;
}
