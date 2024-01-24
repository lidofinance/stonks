// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {GPv2Order} from "./lib/GPv2Order.sol";
import {AssetRecoverer} from "./AssetRecoverer.sol";
import {IStonks} from "./interfaces/IStonks.sol";

/**
 * @title CoW Protocol Programmatic Order
 * @dev Handles the execution of individual trading order for the Stonks contract on CoW Protocol.
 *
 * Features:
 *  - Retrieves trade parameters from Stonks contract, ensuring alignment with the overall trading strategy.
 *  - Single-use design: each contract proxy is intended for one-time use, providing fresh settings for each trade.
 *  - Complies with ERC1271 for secure order validation.
 *  - Provides asset recovery functionality.
 *
 * @notice Serves as an execution module for CoW Protocol trades, operating under parameters set by the Stonks contract.
 */
contract Order is IERC1271, AssetRecoverer {
    using GPv2Order for GPv2Order.Data;
    using SafeERC20 for IERC20;

    // bytes4(keccak256("isValidSignature(bytes32,bytes)")
    bytes4 private constant ERC1271_MAGIC_VALUE = 0x1626ba7e;
    uint256 private constant MIN_POSSIBLE_BALANCE = 10;
    uint256 private constant MAX_BASIS_POINTS = 10_000;
    bytes32 private constant APP_DATA = keccak256("LIDO_DOES_STONKS");

    address public immutable RELAYER;
    bytes32 public immutable DOMAIN_SEPARATOR;

    uint256 private sellAmount;
    uint256 private buyAmount;
    bytes32 private orderHash;
    address public stonks;
    uint32 private validTo;
    bool private initialized;

    event RelayerSet(address relayer);
    event DomainSeparatorSet(address manager);
    event OrderCreated(address indexed order, bytes32 orderHash, GPv2Order.Data orderData);

    error OrderAlreadyInitialized();
    error OrderExpired(uint256 validTo);
    error InvalidAmountToRecover(uint256 amount);
    error CannotRecoverTokenFrom(address token);
    error InvalidOrderHash(bytes32 expected, bytes32 actual);
    error OrderNotExpired(uint256 validTo, uint256 currentTimestamp);
    error PriceConditionChanged(uint256 maxAcceptedAmount, uint256 actualAmount);

    /**
     * @param agent_ The agent's address with control over the contract.
     * @param relayer_ The address of the relayer handling orders.
     * @param domainSeparator_ The EIP-712 domain separator to use.
     * @dev This constructor sets up necessary parameters and state variables to enable the contract's interaction with the CoW Protocol.
     * @dev It also marks the contract as initialized to prevent unauthorized re-initialization.
     */
    constructor(address agent_, address relayer_, bytes32 domainSeparator_) AssetRecoverer(agent_) {
        // Immutable variables are set at contract deployment and remain unchangeable thereafter.
        // This ensures that even when creating new proxies via a minimal proxy,
        // these variables retain their initial values assigned at the time of the original contract deployment.
        RELAYER = relayer_;
        DOMAIN_SEPARATOR = domainSeparator_;

        // This variable is stored in the contract's storage and will be overwritten
        // when a new proxy is created via a minimal proxy. Currently, it is set to true
        // to prevent any initialization of a transaction on 'sample' by unauthorized entities.
        initialized = true;

        emit RelayerSet(relayer_);
        emit DomainSeparatorSet(agent_);
    }

    /**
     * @notice Initializes the contract for trading by defining order parameters and approving tokens.
     * @param minBuyAmount_ The minimum accepted trade outcome.
     * @param manager_ The manager's address to be set for the contract.
     * @dev This function calculates the buy amount from ChainLink and manager input, sets the order parameters, and approves tokens for trading.
     */
    function initialize(uint256 minBuyAmount_, address manager_) external {
        if (initialized) revert OrderAlreadyInitialized();

        initialized = true;
        stonks = msg.sender;
        manager = manager_;

        IStonks.OrderParameters memory orderParameters = IStonks(stonks).getOrderParameters();

        validTo = uint32(block.timestamp + orderParameters.orderDurationInSeconds);
        sellAmount = IERC20(orderParameters.tokenFrom).balanceOf(address(this));
        buyAmount = Math.max(IStonks(stonks).estimateTradeOutput(sellAmount), minBuyAmount_);

        GPv2Order.Data memory order = GPv2Order.Data({
            sellToken: IERC20Metadata(orderParameters.tokenFrom),
            buyToken: IERC20Metadata(orderParameters.tokenTo),
            receiver: AGENT,
            sellAmount: sellAmount,
            buyAmount: buyAmount,
            validTo: validTo,
            appData: APP_DATA,
            // Fee amount is set to 0 for creating limit order
            // https://docs.cow.fi/tutorials/submit-limit-orders-via-api/general-overview
            feeAmount: 0,
            kind: GPv2Order.KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: GPv2Order.BALANCE_ERC20,
            buyTokenBalance: GPv2Order.BALANCE_ERC20
        });
        orderHash = order.hash(DOMAIN_SEPARATOR);

        // Approval is set to the maximum value of uint256 as the contract is intended for single-use only.
        // This eliminates the need for subsequent approval calls, optimizing for gas efficiency in one-time transactions.
        IERC20(orderParameters.tokenFrom).approve(RELAYER, type(uint256).max);

        emit OrderCreated(address(this), orderHash, order);
    }

    /**
     * @notice Validates the order's signature and ensures compliance with price and timing constraints.
     * @param hash_ The hash of the order for validation.
     * @dev Checks include:
     *      - Matching the provided hash with the stored order hash.
     *      - Confirming order validity within the specified timeframe (`validTo`).
     *      - Computing and comparing expected purchase amounts with market price (provided by ChainLink).
     *      - Checking that the price tolerance is not exceeded.
     */
    function isValidSignature(bytes32 hash_, bytes calldata) external view returns (bytes4 magicValue) {
        if (hash_ != orderHash) revert InvalidOrderHash(orderHash, hash_);
        if (validTo < block.timestamp) revert OrderExpired(validTo);

        IStonks.OrderParameters memory orderParameters = IStonks(stonks).getOrderParameters();

        /// The price tolerance mechanism is crucial for ensuring that the order remains valid only within a specific price range.
        /// This is a safeguard against market volatility and drastic price changes, which could otherwise lead to unfavorable trades.
        /// If the price deviates beyond the tolerance level, the order is invalidated to protect against executing a trade at an undesirable rate.
        ///
        /// |           buyAmount                 maxToleratedAmount        currentCalculatedBuyAmount
        /// |  --------------*-----------------------------*-----------------------------*-----------------> amount
        /// |                 <-------- tolerance -------->
        /// |                 <-------------------- differenceAmount ------------------->
        /// 
        /// where:
        ///     buyAmount - amount received from the Stonks contract, which is the minimum accepted result amount of the trade.
        ///     tolerance - the maximum accepted deviation of the buyAmount.
        ///     currentCalculatedBuyAmount - the currently calculated purchase amount based on real-time market conditions taken from Stonks contract.
        ///     differenceAmount - the difference between the buyAmount and the currentCalculatedBuyAmount.
        ///     maxToleratedAmount - the maximum tolerated deviation of the purchase amount. Represents the threshold beyond which the order is 
        ///                          considered invalid due to excessive deviation from the expected purchase amount.

        uint256 currentCalculatedBuyAmount = IStonks(stonks).estimateTradeOutput(sellAmount);

        if (currentCalculatedBuyAmount <= buyAmount) return ERC1271_MAGIC_VALUE;

        uint256 differenceAmount = currentCalculatedBuyAmount - buyAmount;
        uint256 maxToleratedAmountDeviation = buyAmount * orderParameters.priceToleranceInBasisPoints / MAX_BASIS_POINTS;

        if (differenceAmount > maxToleratedAmountDeviation) {
            revert PriceConditionChanged(buyAmount + maxToleratedAmountDeviation, currentCalculatedBuyAmount);
        }

        return ERC1271_MAGIC_VALUE;
    }

    /**
     * @notice Retrieves the details of the placed order.
     */
    function getOrderDetails()
        external
        view
        returns (
            bytes32 hash_,
            address tokenFrom_,
            address tokenTo_,
            uint256 sellAmount_,
            uint256 buyAmount_,
            uint32 validTo_
        )
    {
        IStonks.OrderParameters memory orderParameters = IStonks(stonks).getOrderParameters();
        return (orderHash, orderParameters.tokenFrom, orderParameters.tokenTo, sellAmount, buyAmount, validTo);
    }

    /**
     * @notice Allows to return tokens if the order has expired.
     * @dev Can only be called if the order's validity period has passed.
     */
    function recoverTokenFrom() external {
        if (validTo >= block.timestamp) revert OrderNotExpired(validTo, block.timestamp);
        IStonks.OrderParameters memory orderParameters = IStonks(stonks).getOrderParameters();
        uint256 balance = IERC20(orderParameters.tokenFrom).balanceOf(address(this));
        // Prevents dust transfers to avoid rounding issues for rebasable tokens like stETH.
        if (balance <= MIN_POSSIBLE_BALANCE) revert InvalidAmountToRecover(balance);
        IERC20(orderParameters.tokenFrom).safeTransfer(stonks, balance);
    }

    /**
     * @notice Facilitates the recovery of ERC20 tokens from the contract, except for the token involved in the order.
     * @param token_ The address of the token to recover.
     * @param amount_ The amount of the token to recover.
     * @dev Can only be called by the agent or manager of the contract. This is a safety feature to prevent accidental token loss.
     */
    function recoverERC20(address token_, uint256 amount_) public override onlyAgentOrManager {
        IStonks.OrderParameters memory orderParameters = IStonks(stonks).getOrderParameters();
        if (token_ == orderParameters.tokenFrom) revert CannotRecoverTokenFrom(orderParameters.tokenFrom);
        AssetRecoverer.recoverERC20(token_, amount_);
    }
}
