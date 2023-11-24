// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

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

    constructor(address agent_) {
        if (agent_ == address(0)) revert InvalidAgentAddress();
        agent = agent_;
    }

    function recoverEther() external onlyAgentOrManager {
        uint256 amount = address(this).balance;
        (bool success,) = agent.call{value: amount}("");
        require(success);
        emit EtherRecovered(agent, amount);
    }

    function recoverERC20(address _token, uint256 _amount) public virtual onlyAgentOrManager {
        IERC20(_token).safeTransfer(agent, _amount);
        emit ERC20Recovered(_token, agent, _amount);
    }

    function recoverERC721(address _token, uint256 _tokenId) external onlyAgentOrManager {
        IERC721(_token).safeTransferFrom(address(this), agent, _tokenId);
        emit ERC721Recovered(_token, _tokenId, agent);
    }

    function recoverERC1155(address _token, uint256 _tokenId) external onlyAgentOrManager {
        uint256 amount = IERC1155(_token).balanceOf(address(this), _tokenId);
        IERC1155(_token).safeTransferFrom(address(this), agent, _tokenId, amount, "");
        emit ERC1155Recovered(_token, _tokenId, agent, amount);
    }

    modifier onlyAgentOrManager() {
        if (msg.sender != agent && msg.sender != manager) revert NotAgentOrManager();
        _;
    }
}
