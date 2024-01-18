// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/**
 * @title Ownable
 *
 * @dev Provides basic access control mechanism where two accounts (agent and manager) can be granted access to specific functions.
 * The agent is set during contract deployment and cannot be changed. The manager can be set by the agent.
 */
contract Ownable {
    address public immutable AGENT;
    address public manager;

    error InvalidAgentAddress(address agent_);
    error NotAgentOrManager(address sender);
    error NotAgent(address sender);

    event ManagerSet(address indexed manager);

    /**
     * @dev Initializes the contract setting the agent.
     */
    constructor(address agent_) {
        if (agent_ == address(0)) revert InvalidAgentAddress(agent_);
        AGENT = agent_;
    }

    /**
     * @dev Sets the manager address.
     * @param manager_ The address of the new manager.
     */
    function setManager(address manager_) external onlyAgent {
        manager = manager_;
        emit ManagerSet(manager_);
    }

    /**
     * @dev Modifier to restrict function access from either the agent or the manager.
     */
    modifier onlyAgentOrManager() {
        if (msg.sender != AGENT && msg.sender != manager) revert NotAgentOrManager(msg.sender);
        _;
    }

    /**
     * @dev Modifier to restrict function access from the agent.
     */
    modifier onlyAgent() {
        if (msg.sender != AGENT) revert NotAgent(msg.sender);
        _;
    }
}