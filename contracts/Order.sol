// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {GPv2Order} from "./lib/GPv2Order.sol";
import {ITokenConverter} from "./interfaces/ITokenConverter.sol";
import {AssetRecoverer} from "./lib/AssetRecoverer.sol";
import {IStonks} from "./interfaces/IStonks.sol";

import {ICoWSwapSettlement} from "./interfaces/ICoWSwapSettlement.sol";
import {ERC1271_MAGIC_VALUE, IERC1271} from "./interfaces/IERC1271.sol";

/**
 * @title CoWswap Trading Order Contract
 * @dev Handles the execution of individual trading orders for the Stonks contract on CoWswap.
 *
 * Features:
 *  - Retrieves trade parameters from Stonks contract, ensuring alignment with the overall trading strategy.
 *  - Manages price-related calculations, including conversion rates and margins, to determine trade amounts.
 *  - Single-use design: Each contract instance is intended for one-time use, providing fresh settings for each trade.
 *  - Complies with ERC1271 for secure order validation.
 *  - Includes asset recovery capabilities for enhanced safety.
 *
 * @notice Serves as an execution module for CoWswap trades, operating under parameters set by the Stonks contract.
 */
contract Order is IERC1271, AssetRecoverer {
    using GPv2Order for *;
    using SafeERC20 for IERC20;

    uint256 private constant MAX_BASIS_POINTS = 10_000;
    bytes32 private constant APP_DATA = keccak256("LIDO_DOES_STONKS");

    bytes32 private immutable domainSeparator;
    address private immutable settlement;
    address private immutable relayer;

    uint256 private sellAmount;
    uint256 private buyAmount;

    address private stonks;

    uint32 private validTo;
    bytes32 private orderHash;
    bool private initialized;

    event OrderCreated(address indexed order, bytes32 orderHash, GPv2Order.Data orderData);

    /// @param agent_ The agent's address with control over the contract.
    /// @param settlement_ The address of the settlement contract.
    /// @param relayer_ The address of the relayer handling orders.
    /// @dev This constructor sets up necessary parameters and state variables to enable the contract's interaction with the CoWswap protocol.
    /// @dev It also marks the contract as initialized to prevent unauthorized re-initialization.
    constructor(address agent_, address settlement_, address relayer_) AssetRecoverer(agent_) {
        // Immutable variables are set at contract deployment and remain unchangeable thereafter.
        // This ensures that even when creating new instances via a minimal proxy,
        // these variables retain their initial values assigned at the time of the original contract deployment.
        settlement = settlement_;
        relayer = relayer_;
        domainSeparator = ICoWSwapSettlement(settlement).domainSeparator();

        // This variable is stored in the contract's storage and will be overwritten
        // when a new instance is created via a minimal proxy. Currently, it is set to true
        // to prevent any initialization of a transaction on 'sample' by unauthorized entities.
        initialized = true;
    }

    /// @notice Initializes the contract for trading by defining order parameters and approving tokens.
    /// @param manager_ The manager's address to be set for the contract.
    /// @dev This function calculates the buy amount considering trade margins, sets the order parameters, and approves the token for trading.
    function initialize(address manager_) external {
        require(!initialized, "order: already initialized");

        initialized = true;
        stonks = msg.sender;
        manager = manager_;

        (
            IERC20 tokenFrom,
            IERC20 tokenTo,
            address conversionRateProvider,
            uint256 orderDurationInSeconds,
            uint256 tradeMarginInBasisPoints,
        ) = IStonks(stonks).getOrderParameters();

        validTo = uint32(block.timestamp + orderDurationInSeconds);
        sellAmount = tokenFrom.balanceOf(address(this));

        uint256 expectedPurchaseAmount =
            ITokenConverter(conversionRateProvider).getExpectedOut(sellAmount, address(tokenFrom), address(tokenTo));
        buyAmount = (expectedPurchaseAmount * (MAX_BASIS_POINTS - tradeMarginInBasisPoints)) / MAX_BASIS_POINTS;

        GPv2Order.Data memory order = GPv2Order.Data({
            sellToken: IERC20Metadata(address(tokenFrom)),
            buyToken: IERC20Metadata(address(tokenTo)),
            receiver: agent,
            sellAmount: sellAmount,
            buyAmount: buyAmount,
            validTo: validTo,
            appData: APP_DATA,
            feeAmount: 0,
            kind: GPv2Order.KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: GPv2Order.BALANCE_ERC20,
            buyTokenBalance: GPv2Order.BALANCE_ERC20
        });
        orderHash = order.hash(domainSeparator);

        // Approval is set to the maximum value of uint256 as the contract is intended for single-use only.
        // This eliminates the need for subsequent approval calls, optimizing for gas efficiency in one-time transactions.
        tokenFrom.approve(relayer, type(uint256).max);

        emit OrderCreated(address(this), orderHash, order);
    }

    /**
     * @notice Validates the order's signature and ensures compliance with price and timing constraints.
     * @param hash The hash of the order for validation.
     * @dev Checks include:
     *      - Matching the provided hash with the stored order hash.
     *      - Confirming order validity within the specified timeframe (`validTo`).
     *      - Computing and comparing expected purchase amounts with set trade margins and price tolerances.
     *      - Reverts if hash mismatch, order expiration, or excessive price deviation occurs.
     */
    function isValidSignature(bytes32 hash, bytes calldata) external view returns (bytes4 magicValue) {
        require(hash == orderHash, "order: invalid hash");
        require(validTo >= block.timestamp, "order: invalid time");

        (
            IERC20 tokenFrom,
            IERC20 tokenTo,
            address conversionRateProvider,
            ,
            uint256 tradeMarginInBasisPoints,
            uint256 priceToleranceInBasisPoints
        ) = IStonks(stonks).getOrderParameters();

        /// The price tolerance mechanism is crucial for ensuring that the order remains valid only within a specific price range.
        /// This is a safeguard against market volatility and drastic price changes, which could otherwise lead to unfavorable trades.
        /// If the price deviates beyond the tolerance level, the order is invalidated to protect against executing a trade at an undesirable rate.

        uint256 expectedPurchaseAmount = ITokenConverter(conversionRateProvider).getExpectedOut(
            IERC20(tokenFrom).balanceOf(address(this)), address(tokenFrom), address(tokenTo)
        );
        uint256 expectedPurchaseAmountWithMargin =
            (expectedPurchaseAmount * (MAX_BASIS_POINTS - tradeMarginInBasisPoints)) / MAX_BASIS_POINTS;

        if (expectedPurchaseAmountWithMargin <= buyAmount) return ERC1271_MAGIC_VALUE;

        uint256 differenceAmount = expectedPurchaseAmountWithMargin - buyAmount;
        uint256 priceToleranceAmount = expectedPurchaseAmountWithMargin * priceToleranceInBasisPoints / MAX_BASIS_POINTS;

        require(differenceAmount <= priceToleranceAmount, "order: invalid price");

        return ERC1271_MAGIC_VALUE;
    }

    /// @notice Retrieves the details of the placed order.
    function getPlacedOrder() external view returns (bytes32, address, address, uint256, uint256, uint32) {
        (IERC20 tokenFrom, IERC20 tokenTo,,,,) = IStonks(stonks).getOrderParameters();
        return (orderHash, address(tokenFrom), address(tokenTo), sellAmount, buyAmount, validTo);
    }

    /// @notice Allows for the cancellation of the order and returns the tokens if the order has expired.
    /// @dev Can only be called if the order's validity period has passed.
    function cancel() external {
        require(validTo < block.timestamp, "order: not expired");
        (IERC20 tokenFrom,,,,,) = IStonks(stonks).getOrderParameters();
        tokenFrom.safeTransfer(stonks, tokenFrom.balanceOf(address(this)));
    }

    /// @notice Facilitates the recovery of ERC20 tokens from the contract, except for the token involved in the order.
    /// @param token_ The address of the token to recover.
    /// @param amount The amount of the token to recover.
    /// @dev Can only be called by the agent or manager of the contract. This is a safety feature to prevent accidental token loss.
    function recoverERC20(address token_, uint256 amount) public override onlyAgentOrManager {
        (IERC20 tokenFrom,,,,,) = IStonks(stonks).getOrderParameters();
        require(token_ != address(tokenFrom), "order: cannot recover tokenFrom");
        AssetRecoverer.recoverERC20(token_, amount);
    }
}
