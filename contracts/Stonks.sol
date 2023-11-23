// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {AssetRecoverer} from "./lib/AssetRecoverer.sol";
import {Order} from "./Order.sol";

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
contract Stonks is AssetRecoverer {
    using SafeERC20 for IERC20;

    uint256 private constant MAX_BASIS_POINTS = 10_000;

    address public immutable orderSample;
    address public immutable tokenConverter;
    address public immutable tokenFrom;
    address public immutable tokenTo;

    uint256 public immutable marginInBasisPoints;
    uint256 public immutable priceToleranceInBasisPoints;
    uint256 public immutable orderDurationInSeconds;

    /**
     * @notice Initializes the Stonks contract with key trading parameters.
     * @dev Stores essential parameters for trade execution in immutable variables, ensuring consistency and security of trades.
     */
    constructor(
        address agent_,
        address manager_,
        address tokenFrom_,
        address tokenTo_,
        address tokenConverter_,
        address orderSample_,
        uint256 orderDurationInSeconds_,
        uint256 marginInBasisPoints_,
        uint256 priceToleranceInBasisPoints_
    ) AssetRecoverer(agent_) {
        require(manager_ != address(0), "stonks: invalid manager address");
        require(tokenFrom_ != address(0), "stonks: invalid tokenFrom_ address");
        require(tokenTo_ != address(0), "stonks: invalid tokenTo_ address");
        require(tokenFrom_ != tokenTo_, "stonks: tokenFrom_ and tokenTo_ cannot be the same");
        require(tokenConverter_ != address(0), "stonks: invalid price checker address");
        require(orderSample_ != address(0), "stonks: invalid order address");
        require(orderDurationInSeconds_ > 0, "stonks: invalid order duration");
        require(marginInBasisPoints_ <= MAX_BASIS_POINTS, "stonks: margin overflow");
        require(priceToleranceInBasisPoints_ <= MAX_BASIS_POINTS, "stonks: price tolerance overflow");

        manager = manager_;
        tokenFrom = tokenFrom_;
        tokenTo = tokenTo_;
        tokenConverter = tokenConverter_;
        orderSample = orderSample_;
        orderDurationInSeconds = orderDurationInSeconds_;
        marginInBasisPoints = marginInBasisPoints_;
        priceToleranceInBasisPoints = priceToleranceInBasisPoints_;
    }

    /**
    * @notice Initiates a new trading order by creating an Order contract clone with the current token balance.
    * @dev Transfers the tokenFrom balance to the new Order instance and initializes it with the Stonks' manager settings for execution.
    */
    function placeOrder() external {
        uint256 balance = IERC20(tokenFrom).balanceOf(address(this));

        // Contract needs to hold at least 10 wei to cover steth shares issue
        require(balance > 10, "stonks: insufficient balance");

        Order orderCopy = Order(createOrderCopy());
        IERC20(tokenFrom).safeTransfer(address(orderCopy), balance);
        orderCopy.initialize(manager);
    }

    /**
    * @notice Returns trading parameters from Stonks for use in the Order contract.
    * @dev Facilitates gas efficiency by allowing Order to access existing parameters in Stonks without redundant storage.
    * @return Tuple of tokenFrom, tokenTo, tokenConverter, orderDuration, margin, and price tolerance values.
    */
    function getOrderParameters() external view returns (address, address, address, uint256, uint256, uint256) {
        return (
            tokenFrom, tokenTo, tokenConverter, orderDurationInSeconds, marginInBasisPoints, priceToleranceInBasisPoints
        );
    }

    function createOrderCopy() internal returns (address orderContract) {
        bytes20 addressBytes = bytes20(orderSample);
        assembly {
            let clone_code := mload(0x40)
            mstore(clone_code, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(clone_code, 0x14), addressBytes)
            mstore(add(clone_code, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            orderContract := create(0, clone_code, 0x37)
        }
    }
}
