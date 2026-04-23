// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

interface IStonks {
    function getOrderParameters()
        external
        view
        returns (address tokenFrom, address tokenTo, uint256 orderDurationInSeconds);

    function getPriceTolerance() external view returns (uint256);

    function getMaxImprovementBps() external view returns (uint256);

    function estimateTradeOutput(uint256 amount_) external view returns (uint256);

    function ALLOW_PARTIAL_FILL() external view returns (bool);

    function ORDER_DURATION_IN_SECONDS() external view returns (uint256);

    function RECEIVER() external view returns (address);

    function areSignaturesPaused() external view returns (bool);

    function isCreationPaused() external view returns (bool);

    function isKilled() external view returns (bool);

    function placeOrder(uint256 minBuyAmount_) external returns (address);

    function placeOrderWithAmount(
        uint256 sellAmount_,
        uint256 minBuyAmount_
    ) external returns (address);
    function pauseCreation() external;

    function unpauseCreation() external;

    function pauseSignatures() external;

    function unpauseSignatures() external;
}
