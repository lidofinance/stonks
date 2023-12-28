// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT

pragma solidity 0.8.19;

/// @title Management and ownership extension for the contracts
/// @notice Allows the owner of the contract to set the manager. When the manager is set
///     Only the manager address may perform operations protected by the onlyManager() modifier.
///     In the other case, anyone is allowed to call such methods.
///     Only the owner is allowed to call a method protected by the onlyOwner() modifier, including
///     setOwner() and setManager() methods.
abstract contract ManageableStub {
    address public owner;
    address public manager;

    constructor(address owner_, address manager_) {
        _setOwner(owner_);
        _setManager(manager_);
    }

    function setManager(address manager_) external onlyOwner {
        _setManager(manager_);
    }

    function setOwner(address newOwner_) external onlyOwner {
        _setOwner(newOwner_);
    }

    function _setManager(address manager_) internal {
        manager = manager_;
        emit ManagerSet(manager_);
    }

    function _setOwner(address owner_) internal {
        owner = owner_;
        emit OwnerSet(owner_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) {
            revert NotOwner(msg.sender, owner);
        }
        _;
    }

    /// @notice When the owner sets the manager, msg.sender must be the manager address to
    ///     pass the modifier check
    modifier onlyManager() {
        if (manager != address(0) && manager != msg.sender) {
            revert NotManager(msg.sender, manager);
        }
        _;
    }

    event ManagerSet(address newManager);
    event OwnerSet(address newOwner);
}

error NotOwner(address sender, address owner);
error NotManager(address sender, address manager);
error InvalidSignature();
