// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

/**
 * @title AccessControl
 *
 * @dev Provides access control by creating agent and manager roles.
 * The agent is set during contract deployment and cannot be changed. The
 * manager can be set by the agent.
 */
contract AccessControl {
    address public immutable agent;
    address public manager;

    error InvalidAgentAddress();
    error InvalidManagerAddress();
    error NotAgentOrManager();
    error NotAgent();

    /**
     * @dev Initializes the contract setting the deployer as the initial agent.
     */
    constructor(address agent_) {
        if (agent_ == address(0)) revert InvalidAgentAddress();
        agent = agent_;
    }

    /**
     * @dev Sets the manager address.
     * @param manager_ The address of the new manager.
     */
    function setManager(address manager_) external onlyAgent {
        if (manager_ == address(0)) revert InvalidManagerAddress();
        manager = manager_;
    }

    /**
     * @dev Modifier to restrict function access from either the agent or the manager.
     */
    modifier onlyAgentOrManager() {
        if (msg.sender != agent && msg.sender != manager) revert NotAgentOrManager();
        _;
    }

    /**
     * @dev Modifier to restrict function access from the agent.
     */
    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }
}
