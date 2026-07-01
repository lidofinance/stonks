// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {AccessControlEnumerable} from "@openzeppelin/contracts/access/AccessControlEnumerable.sol";

/**
 * @title AssetRecovererACL
 * @author swissarmytowel <info@lido.fi>
 * @notice Asset-recovery base for Buyback contracts with role-based access control.
 * @dev    All recovery flows send to the immutable `TREASURY` address.
 */
abstract contract AssetRecovererACL is AccessControlEnumerable, ReentrancyGuard {
    using Address for address payable;
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Gates asset recovery and operational actions.
    bytes32 public constant MANAGER_ROLE = keccak256("NEST.MANAGER_ROLE");

    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice Treasury address. All recovery flows send assets here.
    address public immutable TREASURY;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event EtherRecovered(uint256 amount);
    event ERC20Recovered(address indexed token, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error InvalidAdminAddress();
    error InvalidTreasuryAddress();

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Constructor. Grants `DEFAULT_ADMIN_ROLE` to `admin_`.
     * @param  admin_ Initial role holder. Non-zero.
     * @param  treasury_ Treasury address. Non-zero.
     */
    constructor(address admin_, address treasury_) {
        if (admin_ == address(0)) {
            revert InvalidAdminAddress();
        }
        if (treasury_ == address(0)) {
            revert InvalidTreasuryAddress();
        }

        TREASURY = treasury_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
    }

    /*//////////////////////////////////////////////////////////////
                           EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Sweeps the contract's entire ETH balance to the treasury.
     */
    function recoverEther() external nonReentrant onlyRole(MANAGER_ROLE) {
        uint256 amount = address(this).balance;

        emit EtherRecovered(amount);

        payable(TREASURY).sendValue(amount);
    }

    /**
     * @notice Recovers an ERC-20 balance to the treasury.
     * @param  token_ ERC-20 token to recover.
     * @param  amount_ Token amount transferred to `TREASURY`.
     */
    function recoverERC20(
        address token_,
        uint256 amount_
    ) external nonReentrant onlyRole(MANAGER_ROLE) {
        emit ERC20Recovered(token_, amount_);

        IERC20(token_).safeTransfer(TREASURY, amount_);
    }
}
