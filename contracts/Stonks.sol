// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {Order} from "./Order.sol";
import {AssetRecoverer} from "./AssetRecoverer.sol";
import {IStonks} from "./interfaces/IStonks.sol";
import {IAmountConverter} from "./interfaces/IAmountConverter.sol";

/**
 * @title Stonks Trading Management Contract
 * @dev Centralizes the management of CoW Swap trading orders, interfacing with the Order contract.
 *
 * Features:
 *  - Stores key trading parameters: token pair, margin, price tokerance and order duration in immutable variables.
 *  - Creates a minimum proxy from the Order contract and passes params for individual trades.
 *  - Provides asset recovery functionality.
 *
 * @notice Orchestrates the setup and execution of trades on CoW Swap, utilizing Order contracts for each trade.
 */
contract Stonks is IStonks, AssetRecoverer {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint16 private constant MAX_BASIS_POINTS = 10_000;
    uint16 private constant BASIS_POINTS_PARAMETERS_LIMIT = 1_000;

    uint256 private constant MIN_POSSIBLE_BALANCE = 10;
    uint256 private constant MIN_POSSIBLE_ORDER_DURATION_IN_SECONDS = 1 minutes;
    uint256 private constant MAX_POSSIBLE_ORDER_DURATION_IN_SECONDS = 1 days;

    address public immutable AMOUNT_CONVERTER;
    address public immutable ORDER_SAMPLE;

    OrderParameters public orderParameters;

    error InvalidManagerAddress(address manager);
    error InvalidTokenFromAddress(address tokenFrom);
    error InvalidTokenToAddress(address tokenTo);
    error InvalidAmountConverterAddress(address amountConverter);
    error InvalidOrderSampleAddress(address orderSample);
    error TokensCannotBeSame();
    error InvalidOrderDuration(uint256 min, uint256 max, uint256 recieved);
    error MarginOverflowsAllowedLimit(uint256 limit, uint256 recieved);
    error PriceToleranceOverflowsAllowedLimit(uint256 limit, uint256 recieved);
    error MinimumPossibleBalanceNotMet(uint256 min, uint256 recieved);
    error InvalidAmount(uint256 amount);

    event OrderContractCreated(address indexed orderContract, uint256 minBuyAmount);
    event AmountConverterSet(address amountConverter);
    event OrderSampleSet(address orderSample);

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
        if (manager_ == address(0)) revert InvalidManagerAddress(manager_);
        if (tokenFrom_ == address(0)) revert InvalidTokenFromAddress(tokenFrom_);
        if (tokenTo_ == address(0)) revert InvalidTokenToAddress(tokenTo_);
        if (tokenFrom_ == tokenTo_) revert TokensCannotBeSame();
        if (amountConverter_ == address(0)) revert InvalidAmountConverterAddress(amountConverter_);
        if (orderSample_ == address(0)) revert InvalidOrderSampleAddress(orderSample_);
        if (orderDurationInSeconds_ < MIN_POSSIBLE_ORDER_DURATION_IN_SECONDS) {
            revert InvalidOrderDuration(
                MIN_POSSIBLE_ORDER_DURATION_IN_SECONDS, MAX_POSSIBLE_ORDER_DURATION_IN_SECONDS, orderDurationInSeconds_
            );
        }
        if (orderDurationInSeconds_ > MAX_POSSIBLE_ORDER_DURATION_IN_SECONDS) {
            revert InvalidOrderDuration(
                MIN_POSSIBLE_ORDER_DURATION_IN_SECONDS, MAX_POSSIBLE_ORDER_DURATION_IN_SECONDS, orderDurationInSeconds_
            );
        }
        if (marginInBasisPoints_ > BASIS_POINTS_PARAMETERS_LIMIT) {
            revert MarginOverflowsAllowedLimit(BASIS_POINTS_PARAMETERS_LIMIT, marginInBasisPoints_);
        }
        if (priceToleranceInBasisPoints_ > BASIS_POINTS_PARAMETERS_LIMIT) {
            revert PriceToleranceOverflowsAllowedLimit(BASIS_POINTS_PARAMETERS_LIMIT, priceToleranceInBasisPoints_);
        }

        manager = manager_;
        ORDER_SAMPLE = orderSample_;
        AMOUNT_CONVERTER = amountConverter_;

        orderParameters = OrderParameters({
            tokenFrom: tokenFrom_,
            tokenTo: tokenTo_,
            orderDurationInSeconds: orderDurationInSeconds_.toUint32(),
            marginInBasisPoints: marginInBasisPoints_.toUint16(),
            priceToleranceInBasisPoints: priceToleranceInBasisPoints_.toUint16()
        });

        emit ManagerSet(manager_);
        emit AmountConverterSet(amountConverter_);
        emit OrderSampleSet(orderSample_);
    }

    /**
     * @notice Initiates a new trading order by creating an Order contract clone with the current token balance.
     * @dev Transfers the tokenFrom balance to the new Order instance and initializes it with the Stonks' manager settings for execution.
     * @param minBuyAmount_ Minimum amount of tokenTo to be received as a result of the trade.
     */
    function placeOrder(uint256 minBuyAmount_) external onlyAgentOrManager returns (address) {
        if (minBuyAmount_ == 0) revert InvalidAmount(minBuyAmount_);

        uint256 balance = IERC20(orderParameters.tokenFrom).balanceOf(address(this));

        // Prevents dust trades to avoid rounding issues for rebasable tokens like stETH.
        if (balance <= MIN_POSSIBLE_BALANCE) revert MinimumPossibleBalanceNotMet(MIN_POSSIBLE_BALANCE, balance);

        Order orderCopy = Order(Clones.clone(ORDER_SAMPLE));
        IERC20(orderParameters.tokenFrom).safeTransfer(address(orderCopy), balance);
        orderCopy.initialize(minBuyAmount_, manager);

        emit OrderContractCreated(address(orderCopy), minBuyAmount_);

        return address(orderCopy);
    }

    /**
     * @notice Estimates output amount for a given trade input amount.
     * @param amount_ Input token amount for trade.
     * @dev Uses token amount converter for output estimation.
     * Subtracts the amount that corresponds to the margin parameter from the result obtained from the amount converter.
     * 
     * |       estimatedTradeOutput       expectedPurchaseAmount
     * |  --------------*--------------------------*-----------------> amount
     * |                 <-------- margin -------->
     * 
     * where:
     *      expectedPurchaseAmount - amount received from the amountConverter based on Chainlink price feed.
     *      margin - % taken from the expectedPurchaseAmount includes CoW Protocol fees and maximum accepted losses 
     *               to handle market volatility.
     *      estimatedTradeOutput - expectedPurchaseAmount subtracted by the margin that is expected to be result of the trade.
     */
    function estimateTradeOutput(uint256 amount_) public view returns (uint256) {
        if (amount_ == 0) revert InvalidAmount(amount_);
        uint256 expectedPurchaseAmount = IAmountConverter(AMOUNT_CONVERTER).getExpectedOut(
            orderParameters.tokenFrom, orderParameters.tokenTo, amount_
        );
        return (expectedPurchaseAmount * (MAX_BASIS_POINTS - orderParameters.marginInBasisPoints)) / MAX_BASIS_POINTS;
    }

    /**
     * @notice Estimates trade output based on current input token balance.
     * @dev Uses current balance for output estimation via `estimateTradeOutput`.
     */
    function estimateTradeOutputFromCurrentBalance() external view returns (uint256) {
        uint256 balance = IERC20(orderParameters.tokenFrom).balanceOf(address(this));
        return estimateTradeOutput(balance);
    }

    /**
     * @notice Returns trading parameters from Stonks for use in the Order contract.
     * @dev Facilitates gas efficiency by allowing Order to access existing parameters in Stonks without redundant storage.
     * @return Tuple of tokenFrom, tokenTo, orderDurationInSeconds, marginInBasisPoints, and priceToleranceInBasisPoints.
     */
    function getOrderParameters() external view returns (OrderParameters memory) {
        return orderParameters;
    }
}
