// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title AssetRecoverer
 * @dev Abstract contract providing mechanisms for recovering various asset types (ETH, ERC20, ERC721, ERC1155) from a contract.
 * This contract is designed to allow asset recovery by an authorized agent or a manager.
 */
abstract contract AssetRecoverer {
    using SafeERC20 for IERC20;

    address public immutable agent;
    address public manager;

    event EtherRecovered(address indexed _recipient, uint256 _amount);
    event ERC20Recovered(address indexed _token, address indexed _recipient, uint256 _amount);
    event ERC721Recovered(address indexed _token, uint256 _tokenId, address indexed _recipient);
    event ERC1155Recovered(address indexed _token, uint256 _tokenId, address indexed _recipient, uint256 _amount);

    error InvalidAgentAddress();
    error NotAgentOrManager();

    /**
     * @dev Sets the initial agent address.
     * @param agent_ The address of the Lido DAO treasury.
     */
    constructor(address agent_) {
        if (agent_ == address(0)) revert InvalidAgentAddress();
        agent = agent_;
    }

    /**
     * @dev Allows the agent or manager to recover Ether held by the contract.
     * Emits an EtherRecovered event upon success.
     */
    function recoverEther() external onlyAgentOrManager {
        uint256 amount = address(this).balance;
        (bool success,) = agent.call{value: amount}("");
        require(success);
        emit EtherRecovered(agent, amount);
    }

    /**
     * @dev Allows the agent or manager to recover ERC20 tokens held by the contract.
     * @param _token The address of the ERC20 token to recover.
     * @param _amount The amount of the ERC20 token to recover.
     * Emits an ERC20Recovered event upon success.
     */
    function recoverERC20(address _token, uint256 _amount) public virtual onlyAgentOrManager {
        IERC20(_token).safeTransfer(agent, _amount);
        emit ERC20Recovered(_token, agent, _amount);
    }

    /**
     * @dev Allows the agent or manager to recover ERC721 tokens held by the contract.
     * @param _token The address of the ERC721 token to recover.
     * @param _tokenId The token ID of the ERC721 token to recover.
     * Emits an ERC721Recovered event upon success.
     */
    function recoverERC721(address _token, uint256 _tokenId) external onlyAgentOrManager {
        IERC721(_token).safeTransferFrom(address(this), agent, _tokenId);
        emit ERC721Recovered(_token, _tokenId, agent);
    }

    /**
     * @dev Allows the agent or manager to recover ERC1155 tokens held by the contract.
     * @param _token The address of the ERC1155 token to recover.
     * @param _tokenId The token ID of the ERC1155 token to recover.
     * Emits an ERC1155Recovered event upon success.
     */
    function recoverERC1155(address _token, uint256 _tokenId) external onlyAgentOrManager {
        uint256 amount = IERC1155(_token).balanceOf(address(this), _tokenId);
        IERC1155(_token).safeTransferFrom(address(this), agent, _tokenId, amount, "");
        emit ERC1155Recovered(_token, _tokenId, agent, amount);
    }

    /**
     * @dev Modifier to restrict function access to either the agent or the manager.
     */
    modifier onlyAgentOrManager() {
        if (msg.sender != agent && msg.sender != manager) revert NotAgentOrManager();
        _;
    }
}
