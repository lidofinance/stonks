// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import {Order} from "./Order.sol";
import {AssetRecoverer} from "./AssetRecoverer.sol";
import {IStonks} from "./interfaces/IStonks.sol";
import {IAmountConverter} from "./interfaces/IAmountConverter.sol";
import {IOracleRouter} from "./interfaces/IOracleRouter.sol";

/**
 * @title Stonks Trading Management Contract
 * @dev Centralizes the management of CoW Swap trading orders, interfacing with the Order contract.
 *
 * Features:
 *  - Stores key trading parameters: token pair, margin, price tolerance and order duration in immutable variables.
 *  - Creates a minimum proxy from the Order contract and passes params for individual trades.
 *  - Provides asset recovery functionality.
 *  - Protected against reentrancy on order creation paths.
 *
 * @notice Orchestrates the setup and execution of trades on CoW Swap, utilizing Order contracts for each trade.
 */
contract Stonks is IStonks, AssetRecoverer, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ==================== Constants ====================

    uint16 private constant MAX_BASIS_POINTS = 1e4;
    uint16 private constant BASIS_POINTS_PARAMETERS_LIMIT = 1e3;

    uint256 private constant MIN_POSSIBLE_BALANCE = 10;
    uint256 private constant MIN_POSSIBLE_ORDER_DURATION_IN_SECONDS = 1 minutes;
    uint256 private constant MAX_POSSIBLE_ORDER_DURATION_IN_SECONDS = 1 days;

    // ==================== Immutables ====================

    /// @notice Address of the AmountConverter contract used for price calculations.
    address public immutable AMOUNT_CONVERTER;
    /// @notice Address of the Order contract implementation used as a template for cloning.
    address public immutable ORDER_SAMPLE;
    /// @notice Address of the token being sold in trades.
    address public immutable TOKEN_FROM;
    /// @notice Address of the token being bought in trades.
    address public immutable TOKEN_TO;
    /// @notice Duration in seconds for which orders remain valid.
    uint256 public immutable ORDER_DURATION_IN_SECONDS;
    /// @notice Margin in basis points subtracted from expected output to account for fees and volatility.
    uint256 public immutable MARGIN_IN_BASIS_POINTS;
    /// @notice Complement of margin in basis points (10000 - MARGIN_IN_BASIS_POINTS).
    uint256 public immutable MARGIN_DIFFERENCE_IN_BASIS_POINTS;
    /// @notice Price tolerance in basis points allowed for price changes before order becomes invalid.
    uint256 public immutable PRICE_TOLERANCE_IN_BASIS_POINTS;
    /// @notice Maximum price improvement allowed in basis points (type(uint256).max = no cap, 0 = strict mode).
    uint256 public immutable MAX_IMPROVEMENT_IN_BASIS_POINTS;
    /// @notice Whether orders should allow partial fills (useful for rebasable tokens).
    bool public immutable ALLOW_PARTIAL_FILL;

    /// @notice Oracle router contract used for quotability checks.
    IOracleRouter public immutable ORACLE_ROUTER;

    // ==================== Events ====================

    event AmountConverterSet(address amountConverter);
    event OrderSampleSet(address orderSample);
    event TokenFromSet(address tokenFrom);
    event TokenToSet(address tokenTo);
    event OrderDurationInSecondsSet(uint256 orderDurationInSeconds);
    event MarginInBasisPointsSet(uint256 marginInBasisPoints);
    event PriceToleranceInBasisPointsSet(uint256 priceToleranceInBasisPoints);
    event OrderContractCreated(address indexed orderContract, uint256 minBuyAmount);
    event OracleRouterSet(address oracleRouter);

    // ==================== Errors ====================

    error InvalidManagerAddress(address manager);
    error InvalidTokenFromAddress(address tokenFrom);
    error InvalidTokenToAddress(address tokenTo);
    error InvalidAmountConverterAddress(address amountConverter);
    error InvalidOrderSampleAddress(address orderSample);
    error InvalidOracleRouterAddress(address oracleRouter);
    error TokensCannotBeSame();
    error InvalidOrderDuration(uint256 min, uint256 max, uint256 received);
    error MarginOverflowsAllowedLimit(uint256 limit, uint256 received);
    error PriceToleranceOverflowsAllowedLimit(uint256 limit, uint256 received);
    error MinimumPossibleBalanceNotMet(uint256 min, uint256 received);
    error InvalidAmount(uint256 amount);
    error SellAmountExceedsBalance(uint256 available, uint256 requested);

    // ==================== Constructor ====================

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
        address oracleRouter_,
        uint256 orderDurationInSeconds_,
        uint256 marginInBasisPoints_,
        uint256 priceToleranceInBasisPoints_,
        uint256 maxImprovementInBasisPoints_,
        bool allowPartialFill_
    ) AssetRecoverer(agent_) {
        if (manager_ == address(0)) {
            revert InvalidManagerAddress(manager_);
        }
        if (tokenFrom_ == address(0)) {
            revert InvalidTokenFromAddress(tokenFrom_);
        }
        if (tokenTo_ == address(0)) {
            revert InvalidTokenToAddress(tokenTo_);
        }
        if (tokenFrom_ == tokenTo_) {
            revert TokensCannotBeSame();
        }
        if (amountConverter_ == address(0)) {
            revert InvalidAmountConverterAddress(amountConverter_);
        }
        if (orderSample_ == address(0)) {
            revert InvalidOrderSampleAddress(orderSample_);
        }
        if (oracleRouter_ == address(0)) {
            revert InvalidOracleRouterAddress(oracleRouter_);
        }
        if (
            orderDurationInSeconds_ > MAX_POSSIBLE_ORDER_DURATION_IN_SECONDS ||
            orderDurationInSeconds_ < MIN_POSSIBLE_ORDER_DURATION_IN_SECONDS
        ) {
            revert InvalidOrderDuration(
                MIN_POSSIBLE_ORDER_DURATION_IN_SECONDS,
                MAX_POSSIBLE_ORDER_DURATION_IN_SECONDS,
                orderDurationInSeconds_
            );
        }
        if (marginInBasisPoints_ > BASIS_POINTS_PARAMETERS_LIMIT) {
            revert MarginOverflowsAllowedLimit(BASIS_POINTS_PARAMETERS_LIMIT, marginInBasisPoints_);
        }
        if (priceToleranceInBasisPoints_ > BASIS_POINTS_PARAMETERS_LIMIT) {
            revert PriceToleranceOverflowsAllowedLimit(
                BASIS_POINTS_PARAMETERS_LIMIT,
                priceToleranceInBasisPoints_
            );
        }
        if (
            maxImprovementInBasisPoints_ != type(uint256).max &&
            maxImprovementInBasisPoints_ > BASIS_POINTS_PARAMETERS_LIMIT
        ) {
            revert MarginOverflowsAllowedLimit(
                BASIS_POINTS_PARAMETERS_LIMIT,
                maxImprovementInBasisPoints_
            );
        }

        manager = manager_;
        ORDER_SAMPLE = orderSample_;
        AMOUNT_CONVERTER = amountConverter_;
        TOKEN_FROM = tokenFrom_;
        TOKEN_TO = tokenTo_;
        ORDER_DURATION_IN_SECONDS = orderDurationInSeconds_;
        MARGIN_IN_BASIS_POINTS = marginInBasisPoints_;
        MARGIN_DIFFERENCE_IN_BASIS_POINTS = MAX_BASIS_POINTS - MARGIN_IN_BASIS_POINTS;
        PRICE_TOLERANCE_IN_BASIS_POINTS = priceToleranceInBasisPoints_;
        MAX_IMPROVEMENT_IN_BASIS_POINTS = maxImprovementInBasisPoints_;
        ALLOW_PARTIAL_FILL = allowPartialFill_;
        ORACLE_ROUTER = IOracleRouter(oracleRouter_);

        emit ManagerSet(manager_);
        emit AmountConverterSet(amountConverter_);
        emit OrderSampleSet(orderSample_);
        emit TokenFromSet(tokenFrom_);
        emit TokenToSet(tokenTo_);
        emit OrderDurationInSecondsSet(orderDurationInSeconds_);
        emit MarginInBasisPointsSet(marginInBasisPoints_);
        emit PriceToleranceInBasisPointsSet(priceToleranceInBasisPoints_);
        emit OracleRouterSet(oracleRouter_);
    }

    // ==================== External Functions ====================

    /**
     * @notice Initiates a new trading order by creating an Order contract clone with the current token balance.
     * @dev Transfers the tokenFrom balance to the new Order instance and initializes it with the Stonks' manager settings for execution.
     *      Protected against reentrancy attacks.
     * @param minBuyAmount_ Minimum amount of tokenTo to be received as a result of the trade.
     * @return Address of the newly created Order contract.
     */
    function placeOrder(
        uint256 minBuyAmount_
    ) external nonReentrant onlyAgentOrManager returns (address) {
        uint256 balance = IERC20(TOKEN_FROM).balanceOf(address(this));
        return _placeOrder(balance, minBuyAmount_, balance);
    }

    /**
     * @notice Initiates a new trading order by creating an Order contract clone with the specified sell amount.
     * @dev Protected against reentrancy attacks.
     * @param sellAmount_ Amount of `TOKEN_FROM` to transfer into the Order for this trade.
     * @param minBuyAmount_ Minimum acceptable `TOKEN_TO` received.
     */
    function placeOrderWithAmount(
        uint256 sellAmount_,
        uint256 minBuyAmount_
    ) external nonReentrant onlyAgentOrManager returns (address) {
        uint256 balance = IERC20(TOKEN_FROM).balanceOf(address(this));
        return _placeOrder(sellAmount_, minBuyAmount_, balance);
    }

    // ==================== External View Functions ====================

    /**
     * @notice Estimates trade output based on current input token balance.
     * @dev Uses current balance for output estimation via `estimateTradeOutput`.
     * @return Estimated trade output amount.
     */
    function estimateTradeOutputFromCurrentBalance() external view returns (uint256) {
        uint256 balance = IERC20(TOKEN_FROM).balanceOf(address(this));
        return estimateTradeOutput(balance);
    }

    /**
     * @notice Returns trading parameters from Stonks for use in the Order contract.
     * @dev Facilitates gas efficiency by allowing Order to access existing parameters in Stonks without redundant storage.
     * @return Tuple of order parameters (tokenFrom, tokenTo, orderDurationInSeconds).
     */
    function getOrderParameters() external view returns (address, address, uint256) {
        return (TOKEN_FROM, TOKEN_TO, ORDER_DURATION_IN_SECONDS);
    }

    /**
     * @notice Returns price tolerance parameter from Stonks for use in the Order contract.
     * @dev Facilitates gas efficiency by allowing Order to access existing parameters in Stonks without redundant storage.
     * @return Price tolerance in basis points.
     */
    function getPriceTolerance() external view returns (uint256) {
        return PRICE_TOLERANCE_IN_BASIS_POINTS;
    }

    /**
     * @notice Returns maximum price improvement parameter from Stonks for use in the Order contract.
     * @dev Facilitates gas efficiency by allowing Order to access existing parameters in Stonks without redundant storage.
     * @return Maximum improvement in basis points (type(uint256).max = no cap, 0 = strict mode).
     */
    function getMaxImprovementBps() external view returns (uint256) {
        return MAX_IMPROVEMENT_IN_BASIS_POINTS;
    }

    /**
     * @notice Asserts that a price path exists for the pair; used by Order to fail fast.
     * @dev Reads via OracleRouter which reverts if a token is not configured or the bridge is missing.
     */
    function assertQuotable() external view {
        ORACLE_ROUTER.getUsdPrices(TOKEN_FROM, TOKEN_TO); // reverts internally if unquotable
    }

    // ==================== Public Functions ====================

    /**
     * @notice Estimates output amount for a given trade input amount.
     * @param amount_ Input token amount for trade.
     * @dev Uses token amount converter for output estimation.
     * @return estimatedTradeOutput Estimated trade output amount.
     * Subtracts the amount that corresponds to the margin parameter from the result obtained from the amount converter.
     *
     * |       estimatedTradeOutput        expectedBuyAmount
     * |  --------------*--------------------------*-----------------> amount
     * |                 <-------- margin -------->
     *
     * where:
     *      expectedBuyAmount - amount received from the amountConverter based on Chainlink price feed.
     *      margin - % taken from the expectedBuyAmount includes CoW Protocol fees and maximum accepted losses
     *               to handle market volatility.
     *      estimatedTradeOutput - expectedBuyAmount subtracted by the margin that is expected to be result of the trade.
     */
    function estimateTradeOutput(
        uint256 amount_
    ) public view returns (uint256 estimatedTradeOutput) {
        if (amount_ == 0) {
            revert InvalidAmount(amount_);
        }

        uint256 expectedBuyAmount = IAmountConverter(AMOUNT_CONVERTER).getExpectedOut(
            TOKEN_FROM,
            TOKEN_TO,
            amount_
        );

        estimatedTradeOutput =
            (expectedBuyAmount * MARGIN_DIFFERENCE_IN_BASIS_POINTS) /
            MAX_BASIS_POINTS;
    }

    // ==================== Internal Functions ====================

    function _placeOrder(
        uint256 sellAmount_,
        uint256 minBuyAmount_,
        uint256 availableBalance_
    ) internal returns (address) {
        if (minBuyAmount_ == 0) {
            revert InvalidAmount(minBuyAmount_);
        }

        if (sellAmount_ < MIN_POSSIBLE_BALANCE) {
            revert MinimumPossibleBalanceNotMet(MIN_POSSIBLE_BALANCE, sellAmount_);
        }

        if (sellAmount_ > availableBalance_) {
            revert SellAmountExceedsBalance(availableBalance_, sellAmount_);
        }

        Order orderCopy = Order(Clones.clone(ORDER_SAMPLE));
        emit OrderContractCreated(address(orderCopy), minBuyAmount_);

        IERC20(TOKEN_FROM).safeTransfer(address(orderCopy), sellAmount_);
        orderCopy.initialize(minBuyAmount_, manager);

        return address(orderCopy);
    }
}
