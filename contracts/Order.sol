// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {GPv2Order} from "./lib/GPv2Order.sol";
import {RecoverERC20} from "./lib/RecoverERC20.sol";
import {IPriceChecker} from "./interfaces/IPriceChecker.sol";
import {IStonks} from "./interfaces/IStonks.sol";

import {ICoWSwapSettlement} from "./interfaces/ICoWSwapSettlement.sol";
import {ERC1271_MAGIC_VALUE, IERC1271} from "./interfaces/IERC1271.sol";

contract Order is IERC1271, RecoverERC20 {
    using GPv2Order for *;
    using SafeERC20 for IERC20;

    bytes32 public constant APP_DATA = keccak256("LIDO_DOES_STONKS");
    address public constant SETTLEMENT = 0x9008D19f58AAbD9eD0D60971565AA8510560ab41;
    address public constant VAULT_RELAYER = 0xC92E8bdf79f0507f65a392b0ab4667716BFE0110;

    address public constant TREASURY = 0x7Cd64b87251f793027590c34b206145c3aa362Ae;

    uint8 public constant PRICE_TOLERANCE_IN_PERCENT = 5;

    bytes32 public immutable domainSeparator;

    uint256 internal sellAmount;
    uint256 internal buyAmount;

    address public stonks;

    uint32 public validTo;
    bytes32 public orderHash;

    event OrderCreated(address indexed order, bytes32 orderHash, GPv2Order.Data orderData);

    constructor() {
        domainSeparator = ICoWSwapSettlement(SETTLEMENT).domainSeparator();
    }

    function initialize(address operator_) external {
        stonks = msg.sender;
        operator = operator_;

        (IERC20 tokenFrom, IERC20 tokenTo, address priceChecker) = IStonks(stonks).getOrderParameters();

        validTo = uint32(block.timestamp + 60 minutes);
        sellAmount = tokenFrom.balanceOf(address(this));
        buyAmount =
            IPriceChecker(priceChecker).getExpectedOut(sellAmount, address(tokenFrom), address(tokenTo), new bytes(0));

        GPv2Order.Data memory order = GPv2Order.Data({
            sellToken: IERC20Metadata(address(tokenFrom)),
            buyToken: IERC20Metadata(address(tokenTo)),
            receiver: TREASURY,
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
        tokenFrom.approve(VAULT_RELAYER, type(uint256).max);

        emit OrderCreated(address(this), orderHash, order);
    }

    function isValidSignature(bytes32 hash, bytes calldata) external view returns (bytes4 magicValue) {
        require(hash == orderHash, "Order: invalid order");
        require(block.timestamp <= validTo, "Order: invalid time");

        (IERC20 tokenFrom, IERC20 tokenTo, address priceChecker) = IStonks(stonks).getOrderParameters();

        uint256 currentMarketPrice = IPriceChecker(priceChecker).getExpectedOut(
            IERC20(tokenFrom).balanceOf(address(this)), address(tokenFrom), address(tokenTo), new bytes(0)
        );

        require(isTradePriceWithinTolerance(buyAmount, currentMarketPrice), "Order: invalid price");

        return ERC1271_MAGIC_VALUE;
    }

    function cancel() external {
        require(validTo < block.timestamp, "Order: not expired");
        (IERC20 tokenFrom,,) = IStonks(stonks).getOrderParameters();
        tokenFrom.safeTransfer(stonks, tokenFrom.balanceOf(address(this)));
    }

    function recoverERC20(address token_) external onlyOperator {
        (IERC20 tokenFrom,,) = IStonks(stonks).getOrderParameters();
        require(token_ != address(tokenFrom), "Order: cannot recover tokenFrom");
        uint256 balance = IERC20(token_).balanceOf(address(this));
        require(balance > 0, "Stonks: insufficient balance");
        _recoverERC20(token_, ARAGON_AGENT, balance);
    }

    function isTradePriceWithinTolerance(uint256 a, uint256 b) public pure returns (bool) {
        uint256 scaleFactor = 1e18;
        uint256 scaledA = a * scaleFactor;
        uint256 scaledB = b * scaleFactor;
        uint256 tolerance = (scaledA > scaledB ? scaledA : PRICE_TOLERANCE_IN_PERCENT) * 5 / 100;

        if (scaledA > scaledB) {
            return scaledA - scaledB <= tolerance;
        } else {
            return scaledB - scaledA <= tolerance;
        }
    }
}
