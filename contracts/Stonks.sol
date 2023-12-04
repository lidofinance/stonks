// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {Order} from "./Order.sol";
import {AssetRecoverer} from "./AssetRecoverer.sol";
import {IStonks} from "./interfaces/IStonks.sol";
import {IAmountConverter} from "./interfaces/IAmountConverter.sol";
import {IAmountConverterGoerli} from "./interfaces/IAmountConverterGoerli.sol";

/**
 * @title Stonks Trading Management Contract
 * @dev Centralizes the management of CoW Swap trading orders, interfacing with the Order contract.
 *
 * Features:
 *  - Stores key trading parameters like token pairs and margins in immutable variables.
 *  - Facilitates the creation of new Order contracts for individual trades.
 *  - Provides asset recovery functionality for additional security.
 *  - Maintains a consistent trading strategy through centralized parameter management.
 *
 * @notice Orchestrates the setup and execution of trades on CoW Swap, utilizing Order contracts for each transaction.
 */
contract Stonks is IStonks, AssetRecoverer {
    using SafeERC20 for IERC20;

    uint16 private constant MAX_BASIS_POINTS = 10_000;
    uint16 private constant BASIS_POINTS_PARAMETERS_LIMIT = 1_000;

    uint8 private constant MIN_POSSIBLE_BALANCE = 10;
    uint8 private constant MIN_POSSIBLE_ORDER_DURATION_IN_SECONDS = 60;
    uint16 private constant MAX_POSSIBLE_ORDER_DURATION_IN_SECONDS = 60 * 60 * 7;

    address public immutable amountConverter;
    address public immutable orderSample;

    OrderParameters public orderParameters;

    error ZeroAddress();
    error TokensCannotBeSame();
    error InvalidOrderDuration();
    error MarginOverflowsAllowedLimit();
    error PriceToleranceOverflowsAllowedLimit();
    error MinimumPossibleBalanceNotMet();
    error InvalidAmount();

    /**
     * @notice Initializes the Stonks contract with key trading parameters.
     * @dev Stores essential parameters for trade execution in immutable variables, ensuring consistency and security of trades.
     */
    constructor(
        address agent_,
        address manager_,
        address tokenFrom_,
        address tokenTo_,
        address amountConverter_,
        address orderSample_,
        uint256 orderDurationInSeconds_,
        uint256 marginInBasisPoints_,
        uint256 priceToleranceInBasisPoints_
    ) AssetRecoverer(agent_) {
        if (manager_ == address(0)) revert ZeroAddress();
        if (tokenFrom_ == address(0)) revert ZeroAddress();
        if (tokenTo_ == address(0)) revert ZeroAddress();
        if (tokenFrom_ == tokenTo_) revert TokensCannotBeSame();
        if (amountConverter_ == address(0)) revert ZeroAddress();
        if (orderSample_ == address(0)) revert ZeroAddress();
        if (orderDurationInSeconds_ <= MIN_POSSIBLE_ORDER_DURATION_IN_SECONDS) revert InvalidOrderDuration();
        if (orderDurationInSeconds_ > MAX_POSSIBLE_ORDER_DURATION_IN_SECONDS) revert InvalidOrderDuration();
        if (marginInBasisPoints_ > BASIS_POINTS_PARAMETERS_LIMIT) revert MarginOverflowsAllowedLimit();
        if (priceToleranceInBasisPoints_ > BASIS_POINTS_PARAMETERS_LIMIT) revert PriceToleranceOverflowsAllowedLimit();

        manager = manager_;
        orderSample = orderSample_;
        amountConverter = amountConverter_;

        orderParameters = OrderParameters({
            tokenFrom: tokenFrom_,
            tokenTo: tokenTo_,
            orderDurationInSeconds: uint64(orderDurationInSeconds_),
            marginInBasisPoints: uint16(marginInBasisPoints_),
            priceToleranceInBasisPoints: uint16(priceToleranceInBasisPoints_)
        });
    }

    /**
     * @notice Initiates a new trading order by creating an Order contract clone with the current token balance.
     * @dev Transfers the tokenFrom balance to the new Order instance and initializes it with the Stonks' manager settings for execution.
     */
    function placeOrder() external onlyAgentOrManager returns (address) {
        uint256 balance = IERC20(orderParameters.tokenFrom).balanceOf(address(this));

        // Contract needs to hold at least 10 wei to cover steth shares issue
        if (balance <= MIN_POSSIBLE_BALANCE) revert MinimumPossibleBalanceNotMet();

        Order orderCopy = Order(Clones.clone(orderSample));
        IERC20(orderParameters.tokenFrom).safeTransfer(address(orderCopy), balance);
        orderCopy.initialize(manager);

        return address(orderCopy);
    }

    /**
     * @notice Estimates output amount for a given trade input amount.
     * @param amount Input token amount for trade.
     * @dev Uses token amount converter for output estimation.
     */
    function estimateTradeOutput(uint256 amount) public view returns (uint256) {
        if (amount == 0) revert InvalidAmount();
        uint256 expectedPurchaseAmount = IAmountConverterGoerli(amountConverter).getExpectedOut(
            amount, orderParameters.tokenFrom, orderParameters.tokenTo, new bytes(0)
        );
        return (expectedPurchaseAmount * (MAX_BASIS_POINTS - orderParameters.marginInBasisPoints)) / MAX_BASIS_POINTS;
    }

    /**
     * @notice Estimates trade output based on current input token balance.
     * @dev Uses current balance for output estimation via `getExpectedTradeResult`.
     */
    function estimateOutputFromCurrentBalance() external view returns (uint256) {
        uint256 balance = IERC20(orderParameters.tokenFrom).balanceOf(address(this));
        return estimateTradeOutput(balance);
    }

    /**
     * @notice Returns trading parameters from Stonks for use in the Order contract.
     * @dev Facilitates gas efficiency by allowing Order to access existing parameters in Stonks without redundant storage.
     * @return Tuple of tokenFrom, tokenTo, tokenConverter, orderDuration, margin, and price tolerance values.
     */
    function getOrderParameters() external view returns (OrderParameters memory) {
        return orderParameters;
    }
}
