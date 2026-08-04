// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/**
 * @title Ownable
 *
 * @dev Provides basic access control mechanism where two accounts (admin and manager) can be granted access to specific functions.
 * The admin is set during contract deployment and cannot be changed. The manager can be set by the admin.
 */
contract Ownable {
    // ==================== Immutables ====================

    /// @notice Address of the admin.
    address public immutable ADMIN;

    // ==================== Storage Variables ====================

    /// @notice Address of the manager with restricted access to certain functions.
    address public manager;
    /// @notice Address of the emergency operator with access to critical emergency controls (pause/kill).
    address public emergencyOperator;

    event ManagerSet(address manager);
    event EmergencyOperatorSet(address emergencyOperator);
    event AdminSet(address admin);

    error InvalidAdminAddress(address admin);
    error NotAdminOrManager(address sender);
    error NotAdmin(address sender);
    error NotEmergencyOperator(address sender);

    /**
     * @dev Modifier to restrict function access from the admin.
     */
    modifier onlyAdmin() {
        if (msg.sender != ADMIN) {
            revert NotAdmin(msg.sender);
        }
        _;
    }

    /**
     * @dev Modifier to restrict function access from either the admin or the manager.
     */
    modifier onlyAdminOrManager() {
        if (msg.sender != ADMIN && msg.sender != manager) {
            revert NotAdminOrManager(msg.sender);
        }
        _;
    }

    /**
     * @dev Modifier to restrict function access for critical emergency controls (pause/kill).
     *      Allows the admin, the manager, or the dedicated emergency operator.
     */
    modifier onlyEmergencyOperator() {
        if (msg.sender != ADMIN && msg.sender != manager && msg.sender != emergencyOperator) {
            revert NotEmergencyOperator(msg.sender);
        }
        _;
    }

    // ==================== Constructor ====================

    /**
     * @dev Initializes the contract setting the admin.
     * @param admin_ The address of the admin.
     */
    constructor(address admin_) {
        if (admin_ == address(0)) {
            revert InvalidAdminAddress(admin_);
        }

        ADMIN = admin_;

        emit AdminSet(admin_);
    }

    // ==================== External Functions ====================

    /**
     * @dev Sets the manager address.
     * @param manager_ The address of the new manager.
     */
    function setManager(address manager_) external onlyAdmin {
        manager = manager_;

        emit ManagerSet(manager_);
    }

    /**
     * @dev Sets the emergency operator address.
     * @param emergencyOperator_ The address of the emergency operator.
     */
    function setEmergencyOperator(address emergencyOperator_) external onlyAdmin {
        emergencyOperator = emergencyOperator_;

        emit EmergencyOperatorSet(emergencyOperator_);
    }
}
