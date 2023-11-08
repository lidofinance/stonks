// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {RecoverERC20} from "./lib/RecoverERC20.sol";
import {Order} from "./Order.sol";

contract Stonks is RecoverERC20 {
    using SafeERC20 for IERC20;

    uint256 private constant MAX_BASIS_POINTS = 10_000;

    address public priceChecker;

    Order public immutable orderInstance;

    address public immutable tokenFrom;
    address public immutable tokenTo;

    uint256 public immutable marginBasisPoints;

    constructor(
        address tokenFrom_,
        address tokenTo_,
        address operator_,
        address priceChecker_,
        address order_,
        uint256 marginBasisPoints_
    ) {
        require(tokenFrom_ != address(0), "Stonks: invalid tokenFrom_ address");
        require(tokenTo_ != address(0), "Stonks: invalid tokenTo_ address");
        require(
            tokenFrom_ != tokenTo_,
            "Stonks: tokenFrom_ and tokenTo_ cannot be the same"
        );
        require(
            priceChecker_ != address(0),
            "Stonks: invalid price checker address"
        );
        require(operator_ != address(0), "Stonks: invalid operator address");
        require(order_ != address(0), "Stonks: invalid order address");
        require(
            marginBasisPoints_ <= MAX_BASIS_POINTS,
            "Stonks: margin overflow"
        );

        operator = operator_;
        tokenFrom = tokenFrom_;
        tokenTo = tokenTo_;
        priceChecker = priceChecker_;
        orderInstance = Order(order_);
        marginBasisPoints = marginBasisPoints_;
    }

    function placeOrder() external {
        uint256 balance = IERC20(tokenFrom).balanceOf(address(this));

        require(balance > 0, "Stonks: insufficient balance");

        Order orderCopy = Order(createOrderCopy());
        IERC20(tokenFrom).safeTransfer(address(orderCopy), balance);
        orderCopy.initialize(operator);
    }

    function recoverERC20(address token_) external onlyOperator {
        uint256 balance = IERC20(token_).balanceOf(address(this));
        require(balance > 0, "Stonks: insufficient balance");
        _recoverERC20(token_, ARAGON_AGENT, balance);
    }

    function getOrderParameters()
        external
        view
        returns (address, address, address, uint256)
    {
        return (tokenFrom, tokenTo, priceChecker, marginBasisPoints);
    }

    function createOrderCopy() internal returns (address orderContract) {
        bytes20 addressBytes = bytes20(address(orderInstance));
        assembly {
            let clone_code := mload(0x40)
            mstore(
                clone_code,
                0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000
            )
            mstore(add(clone_code, 0x14), addressBytes)
            mstore(
                add(clone_code, 0x28),
                0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000
            )
            orderContract := create(0, clone_code, 0x37)
        }
    }
}
