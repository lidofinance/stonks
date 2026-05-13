// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {AccessControlEnumerable} from "@openzeppelin/contracts/access/AccessControlEnumerable.sol";

/**
 * @title AssetRecovererACL
 * @author swissarmytowel <info@lido.fi>
 * @notice Role-based asset-recovery base for NEST contracts. Uses `AccessControlEnumerable`
 *         to align its role identifiers with the broader NEST role model.
 * @dev    Assets are always sent to the immutable `AGENT` address.
 */
abstract contract AssetRecovererACL is AccessControlEnumerable {
    using Address for address payable;
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Role gating asset recovery and operational actions. Granted to the admin at
    ///         construction. Delegated to the Treasury Management Committee post-deployment.
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");

    /// @notice Role gating pause/cancellation paths. Granted to the admin at construction.
    ///         Delegated to the Emergency Committee post-deployment.
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");

    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice Aragon Agent treasury address. Sole destination for every recovery path.
    address public immutable AGENT;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event EtherRecovered(address indexed recipient, uint256 amount);
    event ERC20Recovered(address indexed token, address indexed recipient, uint256 amount);
    event ERC721Recovered(address indexed token, uint256 tokenId, address indexed recipient);
    event ERC1155Recovered(
        address indexed token,
        uint256 tokenId,
        address indexed recipient,
        uint256 amount
    );

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error InvalidAdminAddress(address admin);
    error InvalidAgentAddress(address agent);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Grants `DEFAULT_ADMIN_ROLE`, `MANAGER_ROLE`, and `EMERGENCY_ROLE` to `admin_`.
     *         Subsequent role assignments happen post-deployment via governance.
     * @param  admin_ Initial role holder. Non-zero.
     * @param  agent_ Aragon Agent treasury address. Non-zero. Stored as immutable `AGENT`.
     */
    constructor(address admin_, address agent_) {
        if (admin_ == address(0)) {
            revert InvalidAdminAddress(admin_);
        }
        if (agent_ == address(0)) {
            revert InvalidAgentAddress(agent_);
        }
        AGENT = agent_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(MANAGER_ROLE, admin_);
        _grantRole(EMERGENCY_ROLE, admin_);
    }

    /*//////////////////////////////////////////////////////////////
                           EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Sweeps the contract's entire ETH balance to the Aragon Agent.
     */
    function recoverEther() external onlyRole(MANAGER_ROLE) {
        uint256 amount = address(this).balance;

        emit EtherRecovered(AGENT, amount);

        payable(AGENT).sendValue(amount);
    }

    /**
     * @notice Recovers an ERC-20 balance to the Aragon Agent.
     * @dev    `LiquidityProvisioner` overrides this to auto-unwrap wstETH to stETH.
     * @param  token_ ERC-20 token to recover.
     * @param  amount_ Token amount transferred to `AGENT`.
     */
    function recoverERC20(address token_, uint256 amount_) external virtual onlyRole(MANAGER_ROLE) {
        emit ERC20Recovered(token_, AGENT, amount_);

        IERC20(token_).safeTransfer(AGENT, amount_);
    }

    /**
     * @notice Recovers a single ERC-721 token to the Aragon Agent.
     * @param  token_ ERC-721 token contract.
     * @param  tokenId_ Token id to transfer to `AGENT`.
     */
    function recoverERC721(address token_, uint256 tokenId_) external onlyRole(MANAGER_ROLE) {
        emit ERC721Recovered(token_, tokenId_, AGENT);

        IERC721(token_).safeTransferFrom(address(this), AGENT, tokenId_);
    }

    /**
     * @notice Recovers the full ERC-1155 balance of `tokenId_` to the Aragon Agent.
     * @param  token_ ERC-1155 token contract.
     * @param  tokenId_ Token id whose full balance is transferred to `AGENT`.
     */
    function recoverERC1155(address token_, uint256 tokenId_) external onlyRole(MANAGER_ROLE) {
        uint256 amount = IERC1155(token_).balanceOf(address(this), tokenId_);

        emit ERC1155Recovered(token_, tokenId_, AGENT, amount);

        IERC1155(token_).safeTransferFrom(address(this), AGENT, tokenId_, amount, "");
    }
}
