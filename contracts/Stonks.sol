// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {Order} from "./Order.sol";
import {AssetRecoverer} from "./lib/AssetRecoverer.sol";
import {IStonks} from "./interfaces/IStonks.sol";
import {IAmountConverter} from "./interfaces/IAmountConverter.sol";

/**
 * @title Stonks Trading Management Contract
 * @dev Centralizes the management of CoWswap trading orders, interfacing with the Order contract.
 *
 * Features:
 *  - Stores key trading parameters like token pairs and margins in immutable variables.
 *  - Facilitates the creation of new Order contracts for individual trades.
 *  - Provides asset recovery functionality for additional security.
 *  - Maintains a consistent trading strategy through centralized parameter management.
 *
 * @notice Orchestrates the setup and execution of trades on CoWswap, utilizing Order contracts for each transaction.
 */
contract Stonks is IStonks, AssetRecoverer {
    using SafeERC20 for IERC20;

    uint8 private constant MIN_POSSIBLE_BALANCE = 10;
    uint16 private constant MAX_BASIS_POINTS = 10_000;

    address public immutable orderSample;
    OrderParameters public orderParameters;

    error InvalidManagerAddress();
    error InvalidTokenFromAddress();
    error InvalidTokenToAddress();
    error TokensCannotBeSame();
    error InvalidTokenAmountConverterAddress();
    error InvalidOrderAddress();
    error InvalidOrderDuration();
    error MarginOverflow();
    error PriceToleranceOverflow();
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
        address tokenAmountConverter_,
        address orderSample_,
        uint256 orderDurationInSeconds_,
        uint256 marginInBasisPoints_,
        uint256 priceToleranceInBasisPoints_
    ) AssetRecoverer(agent_) {
        if (manager_ == address(0)) revert InvalidManagerAddress();
        if (tokenFrom_ == address(0)) revert InvalidTokenFromAddress();
        if (tokenTo_ == address(0)) revert InvalidTokenToAddress();
        if (tokenFrom_ == tokenTo_) revert TokensCannotBeSame();
        if (tokenAmountConverter_ == address(0)) revert InvalidTokenAmountConverterAddress();
        if (orderSample_ == address(0)) revert InvalidOrderAddress();
        if (orderDurationInSeconds_ == 0) revert InvalidOrderDuration();
        if (marginInBasisPoints_ > MAX_BASIS_POINTS) revert MarginOverflow();
        if (priceToleranceInBasisPoints_ > MAX_BASIS_POINTS) revert PriceToleranceOverflow();

        manager = manager_;
        orderSample = orderSample_;

        orderParameters = OrderParameters({
            tokenFrom: tokenFrom_,
            tokenTo: tokenTo_,
            tokenAmountConverter: tokenAmountConverter_,
            orderDurationInSeconds: uint64(orderDurationInSeconds_),
            marginInBasisPoints: uint16(marginInBasisPoints_),
            priceToleranceInBasisPoints: uint16(priceToleranceInBasisPoints_)
        });
    }

    /**
     * @notice Initiates a new trading order by creating an Order contract clone with the current token balance.
     * @dev Transfers the tokenFrom balance to the new Order instance and initializes it with the Stonks' manager settings for execution.
     */
    function placeOrder() external {
        uint256 balance = IERC20(orderParameters.tokenFrom).balanceOf(address(this));

        // Contract needs to hold at least 10 wei to cover steth shares issue
        if (balance <= MIN_POSSIBLE_BALANCE) revert MinimumPossibleBalanceNotMet();

        Order orderCopy = Order(Clones.clone(orderSample));
        IERC20(orderParameters.tokenFrom).safeTransfer(address(orderCopy), balance);
        orderCopy.initialize(manager);
    }

    /**
     * @notice Estimates output amount for a given trade input amount.
     * @param amount Input token amount for trade.
     * @dev Uses token amount converter for output estimation.
     */
    function estimateTradeOutput(uint256 amount) public view returns (uint256) {
        if (amount == 0) revert InvalidAmount();
        return IAmountConverter(orderParameters.tokenAmountConverter).getExpectedOut(
            amount, orderParameters.tokenFrom, orderParameters.tokenTo
        );
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
