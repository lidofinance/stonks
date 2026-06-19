// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {OrderStub} from "./OrderStub.sol";

/**
 * @notice Stonks stub. The receiver drives the executor's operating mode. `placeOrderWithAmount`
 *         deploys a fresh `OrderStub` and records the sizing. Estimate and the pause forwards carry
 *         revert modes for the failure-path tests.
 */
contract StonksStub {
    error EstimateReverted();
    error MissingStonksRights();

    address public receiver;
    address public manager;
    address public tokenFrom;
    address public tokenTo;
    uint256 public orderDurationSeconds;
    uint256 public estimatedOutput;
    bool public revertEstimate;
    bool public creationPaused;
    bool public killed;
    bool public revertOnRightsCall;

    address public lastOrder;
    uint256 public lastSellAmount;
    uint256 public lastMinBuyAmount;
    uint256 public pauseCreationCalls;
    uint256 public unpauseCreationCalls;
    uint256 public pauseSignaturesCalls;
    uint256 public unpauseSignaturesCalls;

    function setReceiver(address receiver_) external {
        receiver = receiver_;
    }

    function setManager(address manager_) external {
        manager = manager_;
    }

    function setTokenPair(address tokenFrom_, address tokenTo_) external {
        tokenFrom = tokenFrom_;
        tokenTo = tokenTo_;
    }

    function setOrderDuration(uint256 orderDurationSeconds_) external {
        orderDurationSeconds = orderDurationSeconds_;
    }

    function setEstimatedOutput(uint256 estimatedOutput_) external {
        estimatedOutput = estimatedOutput_;
    }

    function setRevertEstimate(bool revertEstimate_) external {
        revertEstimate = revertEstimate_;
    }

    function setCreationPaused(bool creationPaused_) external {
        creationPaused = creationPaused_;
    }

    function setKilled(bool killed_) external {
        killed = killed_;
    }

    function setRevertOnRightsCall(bool revertOnRightsCall_) external {
        revertOnRightsCall = revertOnRightsCall_;
    }

    function RECEIVER() external view returns (address) {
        return receiver;
    }

    function ORDER_DURATION_IN_SECONDS() external view returns (uint256) {
        return orderDurationSeconds;
    }

    function getOrderParameters() external view returns (address, address, uint256) {
        return (tokenFrom, tokenTo, orderDurationSeconds);
    }

    function isCreationPaused() external view returns (bool) {
        return creationPaused;
    }

    function isKilled() external view returns (bool) {
        return killed;
    }

    function estimateTradeOutput(uint256) external view returns (uint256) {
        if (revertEstimate) {
            revert EstimateReverted();
        }
        return estimatedOutput;
    }

    function placeOrderWithAmount(
        uint256 sellAmount_,
        uint256 minBuyAmount_
    ) external returns (address) {
        lastSellAmount = sellAmount_;
        lastMinBuyAmount = minBuyAmount_;

        OrderStub order = new OrderStub();
        lastOrder = address(order);

        return lastOrder;
    }

    function pauseCreation() external {
        if (revertOnRightsCall) {
            revert MissingStonksRights();
        }
        pauseCreationCalls += 1;
    }

    function unpauseCreation() external {
        if (revertOnRightsCall) {
            revert MissingStonksRights();
        }
        unpauseCreationCalls += 1;
    }

    function pauseSignatures() external {
        if (revertOnRightsCall) {
            revert MissingStonksRights();
        }
        pauseSignaturesCalls += 1;
    }

    function unpauseSignatures() external {
        if (revertOnRightsCall) {
            revert MissingStonksRights();
        }
        unpauseSignaturesCalls += 1;
    }
}
