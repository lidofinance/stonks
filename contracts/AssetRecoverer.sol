// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {AccessControl} from "./AccessControl.sol";

/**
 * @title AssetRecoverer
 * @dev Abstract contract providing mechanisms for recovering various asset types (ETH, ERC20, ERC721, ERC1155) from a contract.
 * This contract is designed to allow asset recovery by an authorized agent or a manager.
 */
abstract contract AssetRecoverer is AccessControl {
    using SafeERC20 for IERC20;

    event EtherRecovered(address indexed _recipient, uint256 _amount);
    event ERC20Recovered(address indexed _token, address indexed _recipient, uint256 _amount);
    event ERC721Recovered(address indexed _token, uint256 _tokenId, address indexed _recipient);
    event ERC1155Recovered(address indexed _token, uint256 _tokenId, address indexed _recipient, uint256 _amount);

    /**
     * @dev Sets the initial agent address.
     * @param agent_ The address of the Lido DAO treasury.
     */
    constructor(address agent_) AccessControl(agent_) {}

    /**
     * @dev Allows the agent or manager to recover Ether held by the contract.
     * Emits an EtherRecovered event upon success.
     */
    function recoverEther() external onlyAgentOrManager {
        uint256 amount = address(this).balance;
        (bool success,) = AGENT.call{value: amount}("");
        require(success);
        emit EtherRecovered(AGENT, amount);
    }

    /**
     * @dev Allows the agent or manager to recover ERC20 tokens held by the contract.
     * @param token_ The address of the ERC20 token to recover.
     * @param amount_ The amount of the ERC20 token to recover.
     * Emits an ERC20Recovered event upon success.
     */
    function recoverERC20(address token_, uint256 amount_) public virtual onlyAgentOrManager {
        IERC20(token_).safeTransfer(AGENT, amount_);
        emit ERC20Recovered(token_, AGENT, amount_);
    }

    /**
     * @dev Allows the agent or manager to recover ERC721 tokens held by the contract.
     * @param token_ The address of the ERC721 token to recover.
     * @param tokenId_ The token ID of the ERC721 token to recover.
     * Emits an ERC721Recovered event upon success.
     */
    function recoverERC721(address token_, uint256 tokenId_) external onlyAgentOrManager {
        IERC721(token_).safeTransferFrom(address(this), AGENT, tokenId_);
        emit ERC721Recovered(token_, tokenId_, AGENT);
    }

    /**
     * @dev Allows the agent or manager to recover ERC1155 tokens held by the contract.
     * @param token_ The address of the ERC1155 token to recover.
     * @param tokenId_ The token ID of the ERC1155 token to recover.
     * Emits an ERC1155Recovered event upon success.
     */
    function recoverERC1155(address token_, uint256 tokenId_) external onlyAgentOrManager {
        uint256 amount = IERC1155(token_).balanceOf(address(this), tokenId_);
        IERC1155(token_).safeTransferFrom(address(this), AGENT, tokenId_, amount, "");
        emit ERC1155Recovered(token_, tokenId_, AGENT, amount);
    }
}
