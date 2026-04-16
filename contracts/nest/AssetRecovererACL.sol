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
 * @notice Role-based asset-recovery base for NEST contracts. Mirrors the responsibilities of the
 *         Ownable-based `AssetRecoverer` used by Stonks/Order, but swaps the access model for
 *         OpenZeppelin `AccessControlEnumerable` so NEST contracts can share role identifiers
 *         (`DEFAULT_ADMIN_ROLE`, `MANAGER_ROLE`, `EMERGENCY_ROLE`) with the broader role model.
 * @dev    Assets are always sent to the immutable `AGENT` address (Aragon Agent treasury).
 */
abstract contract AssetRecovererACL is AccessControlEnumerable {
    using Address for address payable;
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Role gating asset recovery and day-to-day operational actions across NEST.
    ///         Held by the admin and, post-deployment, by the Treasury Management Committee.
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");

    /// @notice Role gating pause/cancellation paths across NEST. Held by the admin, the TMC,
    ///         and the Emergency Committee after post-deployment `grantRole` calls.
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");

    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice Aragon Agent treasury address. Sole destination for every recovery path on this
    ///         contract; set once at construction and never updated.
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
     * @notice Grants `DEFAULT_ADMIN_ROLE`, `MANAGER_ROLE`, and `EMERGENCY_ROLE` to `admin_` so it
     *         can immediately operate the contract and delegate roles post-deployment via
     *         `grantRole`. TMC and Emergency Committee assignments happen via governance.
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

    /// @notice Sweeps the contract's entire ETH balance to the Aragon Agent.
    function recoverEther() external onlyRole(MANAGER_ROLE) {
        uint256 amount = address(this).balance;

        emit EtherRecovered(AGENT, amount);

        payable(AGENT).sendValue(amount);
    }

    /**
     * @notice Recovers an ERC-20 balance to the Aragon Agent.
     * @dev    Virtual so subclasses can override (e.g. the LiquidityProvisioner unwraps wstETH
     *         to stETH before forwarding, keeping treasury accounting in stETH terms).
     */
    function recoverERC20(address token_, uint256 amount_) external virtual onlyRole(MANAGER_ROLE) {
        emit ERC20Recovered(token_, AGENT, amount_);

        IERC20(token_).safeTransfer(AGENT, amount_);
    }

    /// @notice Recovers a single ERC-721 token to the Aragon Agent.
    function recoverERC721(address token_, uint256 tokenId_) external onlyRole(MANAGER_ROLE) {
        emit ERC721Recovered(token_, tokenId_, AGENT);

        IERC721(token_).safeTransferFrom(address(this), AGENT, tokenId_);
    }

    /// @notice Recovers the full ERC-1155 balance of `tokenId_` to the Aragon Agent.
    function recoverERC1155(address token_, uint256 tokenId_) external onlyRole(MANAGER_ROLE) {
        uint256 amount = IERC1155(token_).balanceOf(address(this), tokenId_);

        emit ERC1155Recovered(token_, tokenId_, AGENT, amount);

        IERC1155(token_).safeTransferFrom(address(this), AGENT, tokenId_, amount, "");
    }
}
