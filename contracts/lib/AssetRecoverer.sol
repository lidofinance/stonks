// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

abstract contract AssetRecoverer {
    using SafeERC20 for IERC20;

    address public constant ARAGON_AGENT = 0x3e40D73EB977Dc6a537aF587D48316feE66E9C8c;
    address public operator;

    event EtherRecovered(address indexed _recipient, uint256 _amount);
    event ERC20Recovered(address indexed _token, address indexed _recipient, uint256 _amount);
    event ERC721Recovered(address indexed _token, uint256 _tokenId, address indexed _recipient);
    event ERC1155Recovered(address indexed _token, uint256 _tokenId, address indexed _recipient, uint256 _amount);

    function recoverEther() external onlyOperator {
        uint256 amount = address(this).balance;
        (bool success,) = ARAGON_AGENT.call{value: amount}("");
        require(success);
        emit EtherRecovered(ARAGON_AGENT, amount);
    }

    function recoverERC20(address _token, uint256 _amount)
        external
        virtual
        onlyOperator
    {
        IERC20(_token).safeTransfer(ARAGON_AGENT, _amount);
        emit ERC20Recovered(_token, ARAGON_AGENT, _amount);
    }

    function recoverERC721(address _token, uint256 _tokenId)
        external
        onlyOperator
    {
        IERC721(_token).safeTransferFrom(address(this), ARAGON_AGENT, _tokenId);
        emit ERC721Recovered(_token, _tokenId, ARAGON_AGENT);
    }

    function recoverERC1155(address _token, uint256 _tokenId)
        external
        onlyOperator
    {
        uint256 amount = IERC1155(_token).balanceOf(address(this), _tokenId);
        IERC1155(_token).safeTransferFrom(address(this), ARAGON_AGENT, _tokenId, amount, "");
        emit ERC1155Recovered(_token, _tokenId, ARAGON_AGENT, amount);
    }

    modifier onlyOperator() {
        require(msg.sender == operator || msg.sender == ARAGON_AGENT, "asset recoverer: not operator");
        _;
    }
}
