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
    bytes32 private constant APP_DATA = keccak256("{}");

    address public immutable RELAYER;
    bytes32 public immutable DOMAIN_SEPARATOR;

    uint256 private sellAmount;
    uint256 private buyAmount;
    bytes32 private orderHash;
    address public stonks;
    uint32 private validTo;
    bool private initialized;

    event RelayerSet(address relayer);
    event DomainSeparatorSet(bytes32 domainSeparator);
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
        // Immutable parameters are captured at deployment time. When used with minimal proxies,
        // these retain values baked into the original implementation.
        RELAYER = relayer_;
        DOMAIN_SEPARATOR = domainSeparator_;

        // Prevents accidental initialization on the implementation itself.
        initialized = true;

        emit RelayerSet(relayer_);
        emit DomainSeparatorSet(domainSeparator_);
    }

    /**
     * @notice Initializes the contract for trading by defining order parameters and approving tokens.
     * @param minBuyAmount_ The minimum accepted trade outcome.
     * @param manager_ The manager's address to be set for the contract.
     * @dev Pulls pair params from Stonks, asserts a quotable price path up front, computes amounts, and arms allowance.
     */
    function initialize(uint256 minBuyAmount_, address manager_) external {
        if (initialized) {
            revert OrderAlreadyInitialized();
        }

        initialized = true;
        stonks = msg.sender;
        manager = manager_;

        (address tokenFrom, address tokenTo, uint256 orderDurationInSeconds) = IStonks(stonks)
            .getOrderParameters();

        // Fail-fast if either side lacks a valid oracle route (prevents stranded approvals/funds).
        IStonks(stonks).assertQuotable();

        validTo = uint32(block.timestamp + orderDurationInSeconds);
        sellAmount = IERC20(tokenFrom).balanceOf(address(this));

        // Floor for the CoW order; Stonks uses router-based any-to-any quoting.
        buyAmount = Math.max(IStonks(stonks).estimateTradeOutput(sellAmount), minBuyAmount_);

        GPv2Order.Data memory order = GPv2Order.Data({
            sellToken: IERC20Metadata(tokenFrom),
            buyToken: IERC20Metadata(tokenTo),
            receiver: AGENT,
            sellAmount: sellAmount,
            buyAmount: buyAmount,
            validTo: validTo,
            appData: APP_DATA,
            // Zero-fee → limit order semantics per CoW; solver pays gas via surplus.
            feeAmount: 0,
            kind: GPv2Order.KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: GPv2Order.BALANCE_ERC20,
            buyTokenBalance: GPv2Order.BALANCE_ERC20
        });
        orderHash = order.hash(DOMAIN_SEPARATOR);

        // Single-use proxy: set max approval to avoid a second transaction for allowance management.
        IERC20(tokenFrom).forceApprove(RELAYER, type(uint256).max);

        emit OrderCreated(address(this), orderHash, order);
    }

    /**
     * @notice Validates the order's signature and ensures compliance with price and timing constraints.
     * @param hash_ The hash of the order for validation.
     * @return magicValue The magic value of ERC1271.
     * @dev Checks include:
     *      - Matching the provided hash with the stored order hash.
     *      - Confirming order validity within the specified timeframe (`validTo`).
     *      - Price validation: protects against both price improvements and unfavorable moves beyond tolerance.
     *
     * Price Logic:
     * - ACCEPT: Current price equals expected price (perfect match)
     * - REJECT: Current price is better than expected (any improvement makes order unfulfillable)
     * - ACCEPT: Current price is slightly worse than expected (within tolerance)
     * - REJECT: Current price is much worse than expected (beyond tolerance)
     *
     * Note: Any price improvement is rejected because it makes the order unrealistic for fulfillment
     * by solvers who cannot buy tokens at the limit price when market price is higher.
     */
    function isValidSignature(bytes32 hash_, bytes calldata) external view returns (bytes4 magicValue) {
        if (hash_ != orderHash) {
            revert InvalidOrderHash(orderHash, hash_);
        }
        if (validTo < block.timestamp) {
            revert OrderExpired(validTo);
        }

        uint256 currentCalculatedBuyAmount = IStonks(stonks).estimateTradeOutput(sellAmount);

        // Perfect match - accept
        if (currentCalculatedBuyAmount == buyAmount) {
            return ERC1271_MAGIC_VALUE;
        }

        // Reject any price improvement - makes order unfulfillable
        if (currentCalculatedBuyAmount > buyAmount) {
            revert PriceConditionChanged(
                buyAmount,                           // Expected price (limit)
                currentCalculatedBuyAmount          // Actual current price (better)
            );
        }

        // Current price is worse than expected - check tolerance
        uint256 shortfall = buyAmount - currentCalculatedBuyAmount;
        uint256 priceToleranceInBasisPoints = IStonks(stonks).getPriceTolerance();
        uint256 maxToleratedShortfall = (buyAmount * priceToleranceInBasisPoints) / MAX_BASIS_POINTS;

        // Reject if beyond tolerance
        if (shortfall > maxToleratedShortfall) {
            revert PriceConditionChanged(
                buyAmount - maxToleratedShortfall,  // Minimum acceptable price
                currentCalculatedBuyAmount         // Actual current price
            );
        }

        // Accept if within tolerance
        return ERC1271_MAGIC_VALUE;
    }


    /**
     * @notice Retrieves the details of the placed order.
     * @return hash_ The hash of the order.
     * @return tokenFrom_ The address of the token being sold.
     * @return tokenTo_ The address of the token being bought.
     * @return sellAmount_ The amount of `tokenFrom_` that is being sold.
     * @return buyAmount_ The amount of `tokenTo_` that is expected to be bought.
     * @return validTo_ The timestamp until which the order remains valid.
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
        (address tokenFrom, address tokenTo, ) = IStonks(stonks).getOrderParameters();
        return (orderHash, tokenFrom, tokenTo, sellAmount, buyAmount, validTo);
    }

    /**
     * @notice Allows to return tokens if the order has expired.
     * @dev Can only be called if the order's validity period has passed.
     */
    function recoverTokenFrom() external {
        if (validTo >= block.timestamp) {
            revert OrderNotExpired(validTo, block.timestamp);
        }

        (address tokenFrom, , ) = IStonks(stonks).getOrderParameters();
        uint256 balance = IERC20(tokenFrom).balanceOf(address(this));

        // Prevents dust transfers to avoid rounding issues for rebasable tokens like stETH.
        if (balance < MIN_POSSIBLE_BALANCE) {
            revert InvalidAmountToRecover(balance);
        }

        IERC20(tokenFrom).safeTransfer(stonks, balance);
    }

    /**
     * @notice Facilitates the recovery of ERC20 tokens from the contract, except for the token involved in the order.
     * @param token_ The address of the token to recover.
     * @param amount_ The amount of the token to recover.
     * @dev Can only be called by the agent or manager of the contract. This is a safety feature to prevent accidental token loss.
     */
    function recoverERC20(address token_, uint256 amount_) public override onlyAgentOrManager {
        (address tokenFrom, , ) = IStonks(stonks).getOrderParameters();

        if (token_ == tokenFrom) {
            revert CannotRecoverTokenFrom(tokenFrom);
        }

        AssetRecoverer.recoverERC20(token_, amount_);
    }
}
