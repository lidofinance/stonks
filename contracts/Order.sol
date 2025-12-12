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
    /// @notice Price scaling factor for ratio calculations (1e18 matches router precision PRICE_UNIT).
    uint256 private constant PRICE_SCALE = 1e18;
    /// @notice Allowed delta (in token units) when comparing amounts to absorb rounding noise.
    uint256 private constant AMOUNT_EQUALITY_TOLERANCE = 2;
    /// @notice Application-specific data for the CoW order (empty JSON object hash).
    bytes32 private constant APP_DATA = keccak256("{}");

    // ==================== Storage Variables ====================

    /// @notice Amount of tokens to sell in the order.
    uint256 private sellAmount;
    /// @notice Minimum amount of tokens to buy in the order.
    uint256 private buyAmount;
    /// @notice Price tolerance in basis points (cached from Stonks to avoid external calls).
    uint256 private priceToleranceBps;
    /// @notice Maximum price improvement in basis points (cached from Stonks to avoid external calls).
    uint256 private maxImprovementBps;
    /// @notice Time until which the order is valid.
    uint32 private validTo;
    /// @notice Hash of the order for signature validation.
    bytes32 private orderHash;
    /// @notice Address of the Stonks contract that created this order.
    address public stonks;
    /// @notice token from address (cached from Stonks to avoid external calls).
    address private tokenFrom;
    /// @notice token to address (cached from Stonks to avoid external calls).
    address private tokenTo;
    /// @notice Internal flag indicating whether the contract has been initialized.
    bool private initialized;
    /// @notice Whether this order allows partial fills (cached from Stonks to avoid external calls).
    bool public allowPartialFill;
    /// @notice Order cancellation flag.
    bool public cancelled;

    // ==================== Events ====================

    event RelayerSet(address relayer);
    event DomainSeparatorSet(bytes32 domainSeparator);
    event OrderCreated(address indexed order, bytes32 orderHash, GPv2Order.Data orderData);
    event OrderCancelled(address indexed order);
    event RelayerAllowanceRevokedEvent(address indexed order);
    event OrderFundsReturnedEvent(address indexed order, uint256 amount);

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
    error ZeroQuotableAmount(uint256 basisSellAmount);
    error SignaturesGloballyPaused();
    error OrderIsCancelled();
    error NotInitialized();

    // ==================== Constructor ====================

    /**
     * @param admin_ The admin address.
     * @param agent_ The address of the Lido DAO agent.
     * @param relayer_ The address of the relayer handling orders.
     * @param domainSeparator_ The EIP-712 domain separator to use.
     * @dev This constructor sets up necessary parameters and state variables to enable the contract's interaction with the CoW Protocol.
     * @dev It also marks the contract as initialized to prevent unauthorized re-initialization.
     */
    constructor(
        address admin_,
        address agent_,
        address relayer_,
        bytes32 domainSeparator_
    ) AssetRecoverer(admin_, agent_) {
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

        emit ManagerSet(manager_);

        IStonks stonksContract = IStonks(stonks);
        (
            address tokenFromLocal,
            address tokenToLocal,
            uint256 orderDurationInSeconds
        ) = stonksContract.getOrderParameters();

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

        allowPartialFill = stonksContract.ALLOW_PARTIAL_FILL();

        // Cache immutable values to avoid repeated external calls during validation
        priceToleranceBps = stonksContract.getPriceTolerance();
        maxImprovementBps = stonksContract.getMaxImprovementBps();

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
            partiallyFillable: allowPartialFill,
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
     * @dev For partially fillable orders, validates price pro-rata to the currently available balance
     *      using price ratios to ensure consistent validation at all sizes and prevent rounding issues.
     * @dev Price validation uses 1e18-scaled ratios to maintain precision across different token decimals
     *      and handle dust amounts without special cases.
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
        // Check per-order cancellation before global pause
        if (cancelled) {
            revert OrderIsCancelled();
        }

        // Global signatures pause handled by Stonks
        if (stonksContract.areSignaturesPaused()) {
            revert SignaturesGloballyPaused();
        }

        uint256 availableBalance = IERC20(tokenFrom).balanceOf(address(this));

        if (!allowPartialFill) {
            if (availableBalance < sellAmount) {
                revert InsufficientSellBalance(sellAmount, availableBalance);
            }
        }

        // Determine the basis sell amount for price validation
        uint256 basisSellAmount = allowPartialFill
            ? (availableBalance < sellAmount ? availableBalance : sellAmount)
            : sellAmount;

        if (basisSellAmount == 0) {
            revert InsufficientSellBalance(1, availableBalance);
        }

        uint256 currentEstimatedBuyAmount = stonksContract.estimateTradeOutput(basisSellAmount);

        if (currentEstimatedBuyAmount == 0) {
            revert ZeroQuotableAmount(basisSellAmount);
        }

        // Pro-rate the original buyAmount to the basis sell amount
        uint256 baselineBuyAmount = Math.mulDiv(buyAmount, basisSellAmount, sellAmount);

        // Fast path: amount match (with tolerance) avoids rounding issues in price ratio comparison
        uint256 amountDiff = currentEstimatedBuyAmount > baselineBuyAmount
            ? currentEstimatedBuyAmount - baselineBuyAmount
            : baselineBuyAmount - currentEstimatedBuyAmount;
        if (amountDiff <= AMOUNT_EQUALITY_TOLERANCE) {
            return ERC1271_MAGIC_VALUE;
        }

        // Compute prices scaled to 1e18 for ratio comparison
        uint256 originalLimitPrice = Math.mulDiv(buyAmount, PRICE_SCALE, sellAmount);
        uint256 currentExecutionPrice = Math.mulDiv(
            currentEstimatedBuyAmount,
            PRICE_SCALE,
            basisSellAmount
        );

        // Guard against division by zero in BPS calculations
        if (originalLimitPrice == 0) {
            revert PriceShortfallExceedsTolerance(baselineBuyAmount, currentEstimatedBuyAmount);
        }

        // Fast path: exact price match (handles cases where amounts differ due to rounding but prices match)
        if (currentExecutionPrice == originalLimitPrice) {
            return ERC1271_MAGIC_VALUE;
        }

        uint256 priceDiff = currentExecutionPrice > originalLimitPrice
            ? currentExecutionPrice - originalLimitPrice
            : originalLimitPrice - currentExecutionPrice;
        if (priceDiff <= AMOUNT_EQUALITY_TOLERANCE) {
            return ERC1271_MAGIC_VALUE;
        }

        if (currentExecutionPrice > originalLimitPrice) {
            uint256 maxImprovementBpsLocal = maxImprovementBps;

            if (maxImprovementBpsLocal == type(uint256).max) {
                return ERC1271_MAGIC_VALUE;
            }

            if (maxImprovementBpsLocal == 0) {
                revert PriceImprovementRejectedInStrictMode(
                    baselineBuyAmount,
                    currentEstimatedBuyAmount
                );
            }

            unchecked {
                // Calculate improvement in basis points: (currentPrice - originalPrice) / originalPrice
                uint256 improvementBps = Math.mulDiv(
                    currentExecutionPrice - originalLimitPrice,
                    MAX_BASIS_POINTS,
                    originalLimitPrice
                );

                if (improvementBps > maxImprovementBpsLocal) {
                    uint256 maxAllowedBuyAmount = Math.mulDiv(
                        baselineBuyAmount,
                        MAX_BASIS_POINTS + maxImprovementBpsLocal,
                        MAX_BASIS_POINTS
                    );

                    if (
                        currentEstimatedBuyAmount > maxAllowedBuyAmount + AMOUNT_EQUALITY_TOLERANCE
                    ) {
                        revert PriceImprovementExceedsLimit(
                            maxAllowedBuyAmount,
                            currentEstimatedBuyAmount
                        );
                    }
                }
            }

            return ERC1271_MAGIC_VALUE;
        } else {
            uint256 priceToleranceBpsLocal = priceToleranceBps;

            if (priceToleranceBpsLocal == 0) {
                revert PriceShortfallExceedsTolerance(baselineBuyAmount, currentEstimatedBuyAmount);
            }

            if (priceToleranceBpsLocal > MAX_BASIS_POINTS) {
                revert PriceShortfallExceedsTolerance(baselineBuyAmount, currentEstimatedBuyAmount);
            }

            unchecked {
                // Calculate shortfall in basis points: (originalPrice - currentPrice) / originalPrice
                uint256 shortfallBps = Math.mulDiv(
                    originalLimitPrice - currentExecutionPrice,
                    MAX_BASIS_POINTS,
                    originalLimitPrice
                );

                if (shortfallBps > priceToleranceBpsLocal) {
                    uint256 maxToleratedShortfall = Math.mulDiv(
                        baselineBuyAmount,
                        priceToleranceBpsLocal,
                        MAX_BASIS_POINTS
                    );
                    uint256 minAcceptableBuyAmount = baselineBuyAmount - maxToleratedShortfall;

                    if (
                        minAcceptableBuyAmount >
                        currentEstimatedBuyAmount + AMOUNT_EQUALITY_TOLERANCE
                    ) {
                        revert PriceShortfallExceedsTolerance(
                            minAcceptableBuyAmount,
                            currentEstimatedBuyAmount
                        );
                    }
                }
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
    function recoverERC20(address token_, uint256 amount_) public override onlyAdminOrManager {
        address tokenFromLocal = tokenFrom;

        if (tokenFromLocal == address(0)) {
            (tokenFromLocal, , ) = IStonks(stonks).getOrderParameters();
        }

        if (token_ == tokenFromLocal) {
            revert CannotRecoverTokenFrom(tokenFromLocal);
        }

        AssetRecoverer.recoverERC20(token_, amount_);
    }

    // ==================== Emergency State & Admin ====================

    /**
     * @notice Cancels this order and returns all `tokenFrom` back to Stonks. Also revokes relayer allowance.
     *         Idempotent: repeated calls have no adverse effect.
     * @dev Restricted to emergency operators (agent, manager, or emergency operator multisig).
     */
    function emergencyCancelAndReturn() external onlyEmergencyOperator {
        _ensureInitialized();
        if (!cancelled) {
            cancelled = true;

            emit OrderCancelled(address(this));
        }

        _revokeRelayerAllowance();
        _returnAllTokenFromToStonks();
    }

    /**
     * @notice Revokes relayer allowance without moving funds.
     *         Idempotent and callable by emergency operators.
     */
    function emergencyRevokeRelayer() external onlyEmergencyOperator {
        _ensureInitialized();
        _revokeRelayerAllowance();
    }

    function _ensureInitialized() private view {
        if (stonks == address(0) || tokenFrom == address(0)) {
            revert NotInitialized();
        }
    }

    function _revokeRelayerAllowance() private {
        IERC20 tokenFromErc = IERC20(tokenFrom);

        uint256 beforeAllowance = tokenFromErc.allowance(address(this), RELAYER);
        tokenFromErc.forceApprove(RELAYER, 0);

        if (beforeAllowance != 0) {
            emit RelayerAllowanceRevokedEvent(address(this));
        }
    }

    function _returnAllTokenFromToStonks() private {
        IERC20 tokenFromErc = IERC20(tokenFrom);
        uint256 balance = tokenFromErc.balanceOf(address(this));

        if (balance > 0) {
            tokenFromErc.safeTransfer(stonks, balance);

            emit OrderFundsReturnedEvent(address(this), balance);
        }
    }
}
