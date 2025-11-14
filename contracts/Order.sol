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

    // ==================== Immutables ====================

    /// @notice Address of the CoW Protocol relayer contract handling order execution.
    address public immutable RELAYER;
    /// @notice EIP-712 domain separator used for order signature validation.
    bytes32 public immutable DOMAIN_SEPARATOR;

    // ==================== Constants ====================

    // bytes4(keccak256("isValidSignature(bytes32,bytes)")
    bytes4 private constant ERC1271_MAGIC_VALUE = 0x1626ba7e;
    /// @notice Minimum token balance required to perform recovery (prevents dust transfers).
    uint256 private constant MIN_POSSIBLE_BALANCE = 10;
    /// @notice Maximum basis points value for percentage calculations.
    uint256 private constant MAX_BASIS_POINTS = 1e4;
    /// @notice Application-specific data for the CoW order (empty JSON object hash).
    bytes32 private constant APP_DATA = keccak256("{}");

    // ==================== Storage Variables ====================

    /// @notice Amount of tokens to sell in the order.
    uint256 private sellAmount;
    /// @notice Minimum amount of tokens to buy in the order.
    uint256 private buyAmount;
    /// @notice Minimum fill percentage in basis points.
    uint256 private minFillBps;
    /// @notice Hash of the order for signature validation.
    bytes32 private orderHash;
    /// @notice Address of the Stonks contract that created this order.
    address public stonks;
    /// @notice Time until which the order is valid.
    uint32 private validTo;
    /// @notice Internal flag indicating whether the contract has been initialized.
    bool private initialized;

    /// @notice Cached token addresses to avoid repeated external calls to Stonks.
    address private tokenFrom;
    address private tokenTo;

    // ==================== Events ====================

    event RelayerSet(address relayer);
    event DomainSeparatorSet(bytes32 domainSeparator);
    event OrderCreated(address indexed order, bytes32 orderHash, GPv2Order.Data orderData);

    // ==================== Errors ====================

    error OrderAlreadyInitialized();
    error OrderExpired(uint256 validTo);
    error InvalidAmountToRecover(uint256 amount);
    error CannotRecoverTokenFrom(address token);
    error InvalidOrderHash(bytes32 expected, bytes32 actual);
    error OrderNotExpired(uint256 validTo, uint256 currentTimestamp);
    error PriceImprovementExceedsLimit(uint256 maxAllowedBuyAmount, uint256 actualBuyAmount);
    error PriceImprovementRejectedInStrictMode(uint256 expectedBuyAmount, uint256 actualBuyAmount);
    error PriceShortfallExceedsTolerance(uint256 minAcceptableBuyAmount, uint256 actualBuyAmount);
    error InsufficientSellBalance(uint256 required, uint256 available);
    error MinFillBpsExceedsLimit(uint256 maxBasisPoints, uint256 receivedBasisPoints);

    // ==================== Constructor ====================

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

    // ==================== External Functions ====================

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

        IStonks stonksContract = IStonks(stonks);
        (
            address tokenFromLocal,
            address tokenToLocal,
            uint256 orderDurationInSeconds
        ) = stonksContract.getOrderParameters();

        // Fail-fast if either side lacks a valid oracle route (prevents stranded approvals/funds).
        stonksContract.assertQuotable();

        // validate minFillBps invariant once up-front
        minFillBps = stonksContract.MIN_FILL_BPS();
        if (minFillBps > MAX_BASIS_POINTS) {
            revert MinFillBpsExceedsLimit(MAX_BASIS_POINTS, minFillBps);
        }

        tokenFrom = tokenFromLocal;
        tokenTo = tokenToLocal;

        validTo = uint32(block.timestamp + orderDurationInSeconds);

        IERC20Metadata tokenFromErc = IERC20Metadata(tokenFromLocal);
        IERC20Metadata tokenToErc = IERC20Metadata(tokenToLocal);

        sellAmount = tokenFromErc.balanceOf(address(this));

        // Floor for the CoW order; Stonks uses router-based any-to-any quoting.
        uint256 estimatedOut = stonksContract.estimateTradeOutput(sellAmount);
        if (estimatedOut >= minBuyAmount_) {
            buyAmount = estimatedOut;
        } else {
            buyAmount = minBuyAmount_;
        }

        bool partiallyFillable_ = stonksContract.ALLOW_PARTIAL_FILL();

        GPv2Order.Data memory order = GPv2Order.Data({
            sellToken: tokenFromErc,
            buyToken: tokenToErc,
            receiver: AGENT,
            sellAmount: sellAmount,
            buyAmount: buyAmount,
            validTo: validTo,
            appData: APP_DATA,
            // Zero-fee → limit order semantics per CoW; solver pays gas via surplus.
            feeAmount: 0,
            kind: GPv2Order.KIND_SELL,
            partiallyFillable: partiallyFillable_,
            sellTokenBalance: GPv2Order.BALANCE_ERC20,
            buyTokenBalance: GPv2Order.BALANCE_ERC20
        });
        orderHash = order.hash(DOMAIN_SEPARATOR);

        // Single-use proxy: set max approval to avoid a second transaction for allowance management.
        IERC20(tokenFromLocal).forceApprove(RELAYER, type(uint256).max);

        emit OrderCreated(address(this), orderHash, order);
    }

    // ==================== External View Functions ====================

    /**
     * @notice Validates the order's signature and ensures compliance with price and timing constraints.
     * @param hash_ The hash of the order for validation.
     * @return magicValue The magic value of ERC1271.
     * @dev Checks include:
     *      - Matching the provided hash with the stored order hash.
     *      - Confirming order validity within the specified timeframe (`validTo`).
     *      - Price validation: protects against extreme price improvements and unfavorable moves beyond tolerance.
     *
     * Price Logic:
     * - ACCEPT: Current price equals expected price (perfect match)
     * - ACCEPT: Current price is better than expected (if within improvement cap)
     * - REJECT: Current price is much better than expected (beyond improvement cap, likely oracle manipulation)
     * - ACCEPT: Current price is slightly worse than expected (within tolerance)
     * - REJECT: Current price is much worse than expected (beyond tolerance)
     *
     * Improvement Modes:
     * - type(uint256).max: Accept any improvement (no cap)
     * - 0: Reject all improvements (strict mode)
     * - > 0: Accept improvements up to the specified basis points cap
     */
    function isValidSignature(
        bytes32 hash_,
        bytes calldata
    ) external view returns (bytes4 magicValue) {
        if (hash_ != orderHash) {
            revert InvalidOrderHash(orderHash, hash_);
        }

        if (validTo < block.timestamp) {
            revert OrderExpired(validTo);
        }

        IStonks stonksContract = IStonks(stonks);

        // Early revert if partial fills disabled and balance is insufficient (saves solver gas)
        if (!stonksContract.ALLOW_PARTIAL_FILL()) {
            uint256 available = IERC20(tokenFrom).balanceOf(address(this));

            if (available < sellAmount) {
                revert InsufficientSellBalance(sellAmount, available);
            }
        } else {
            if (minFillBps > 0) {
                uint256 requiredMinSell = Math.mulDiv(sellAmount, minFillBps, MAX_BASIS_POINTS);
                uint256 available = IERC20(tokenFrom).balanceOf(address(this));

                if (available < requiredMinSell) {
                    revert InsufficientSellBalance(requiredMinSell, available);
                }
            }
        }

        uint256 currentEstimatedBuyAmount = stonksContract.estimateTradeOutput(sellAmount);

        if (currentEstimatedBuyAmount == buyAmount) {
            return ERC1271_MAGIC_VALUE;
        }

        if (currentEstimatedBuyAmount > buyAmount) {
            uint256 maxImprovementBps = stonksContract.getMaxImprovementBps();

            // No cap: accept any improvement
            if (maxImprovementBps == type(uint256).max) {
                return ERC1271_MAGIC_VALUE;
            }

            // Strict mode: reject any improvement
            if (maxImprovementBps == 0) {
                revert PriceImprovementRejectedInStrictMode(buyAmount, currentEstimatedBuyAmount);
            }

            // Compute improvement cap in a single mulDiv operation
            uint256 maxAllowedBuyAmount = Math.mulDiv(
                buyAmount,
                MAX_BASIS_POINTS + maxImprovementBps,
                MAX_BASIS_POINTS
            );

            if (currentEstimatedBuyAmount > maxAllowedBuyAmount) {
                revert PriceImprovementExceedsLimit(maxAllowedBuyAmount, currentEstimatedBuyAmount);
            }

            return ERC1271_MAGIC_VALUE;
        } else {
            uint256 priceToleranceBps = stonksContract.getPriceTolerance();

            // Strict shortfall mode: reject any shortfall
            if (priceToleranceBps == 0) {
                revert PriceShortfallExceedsTolerance(buyAmount, currentEstimatedBuyAmount);
            }

            // Defensive check: ensure BPS doesn't exceed MAX_BASIS_POINTS (should be validated in constructor)
            if (priceToleranceBps > MAX_BASIS_POINTS) {
                revert PriceShortfallExceedsTolerance(buyAmount, currentEstimatedBuyAmount);
            }

            uint256 maxToleratedShortfall = Math.mulDiv(
                buyAmount,
                priceToleranceBps,
                MAX_BASIS_POINTS
            );
            uint256 minAcceptableBuyAmount = buyAmount - maxToleratedShortfall;

            if (currentEstimatedBuyAmount < minAcceptableBuyAmount) {
                revert PriceShortfallExceedsTolerance(
                    minAcceptableBuyAmount,
                    currentEstimatedBuyAmount
                );
            }

            return ERC1271_MAGIC_VALUE;
        }
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
        return (orderHash, tokenFrom, tokenTo, sellAmount, buyAmount, validTo);
    }

    /**
     * @notice Allows to return tokens if the order has expired.
     * @dev Can only be called if the order's validity period has passed.
     */
    function recoverTokenFrom() external {
        uint256 currentTimestamp = block.timestamp;

        if (validTo >= currentTimestamp) {
            revert OrderNotExpired(validTo, currentTimestamp);
        }

        IERC20 tokenFromErc = IERC20(tokenFrom);
        uint256 balance = tokenFromErc.balanceOf(address(this));

        // Prevents dust transfers to avoid rounding issues for rebasable tokens like stETH.
        if (balance < MIN_POSSIBLE_BALANCE) {
            revert InvalidAmountToRecover(balance);
        }

        tokenFromErc.safeTransfer(stonks, balance);
    }

    // ==================== Public Functions ====================

    /**
     * @notice Facilitates the recovery of ERC20 tokens from the contract, except for the token involved in the order.
     * @param token_ The address of the token to recover.
     * @param amount_ The amount of the token to recover.
     * @dev Can only be called by the agent or manager of the contract. This is a safety feature to prevent accidental token loss.
     */
    function recoverERC20(address token_, uint256 amount_) public override onlyAgentOrManager {
        address tokenFromLocal = tokenFrom;

        if (tokenFromLocal == address(0)) {
            (tokenFromLocal, , ) = IStonks(stonks).getOrderParameters();
        }

        if (token_ == tokenFromLocal) {
            revert CannotRecoverTokenFrom(tokenFromLocal);
        }

        AssetRecoverer.recoverERC20(token_, amount_);
    }
}
