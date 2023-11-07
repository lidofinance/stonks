// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {GPv2Order} from "./lib/GPv2Order.sol";
import {IPriceChecker} from "./interfaces/IPriceChecker.sol";

import {ICoWSwapSettlement} from "./interfaces/ICoWSwapSettlement.sol";
import {ERC1271_MAGIC_VALUE, IERC1271} from "./interfaces/IERC1271.sol";

import {RecoverERC20} from "./RecoverERC20.sol";

contract Order is IERC1271, RecoverERC20 {
    using GPv2Order for *;
    using SafeERC20 for IERC20;

    bytes32 public constant APP_DATA = keccak256("LIDO_DOES_STONKS");
    address public constant SETTLEMENT = 0x9008D19f58AAbD9eD0D60971565AA8510560ab41;
    address public constant VAULT_RELAYER = 0xC92E8bdf79f0507f65a392b0ab4667716BFE0110;

    address public constant TREASURY = 0x7Cd64b87251f793027590c34b206145c3aa362Ae;
    address public constant ARAGON_AGENT = 0x7Cd64b87251f793027590c34b206145c3aa362Ae;

    address public immutable stonks;
    address public immutable operator;

    IPriceChecker public immutable priceChecker;

    IERC20 public immutable tokenFrom;
    IERC20 public immutable tokenTo;

    bytes32 public immutable domainSeparator;

    uint32 public validTo;
    bytes32 public orderHash;

    event OrderCreated(address indexed order, bytes32 orderHash, GPv2Order.Data orderData);

    constructor(address tokenFrom_, address tokenTo_, address operator_, address priceChecker_) {
        stonks = msg.sender;
        operator = operator_;
        priceChecker = IPriceChecker(priceChecker_);
        tokenFrom = IERC20(tokenFrom_);
        tokenTo = IERC20(tokenTo_);
        domainSeparator = ICoWSwapSettlement(SETTLEMENT).domainSeparator();
    }

    function initialize() external {
        uint256 balance = tokenFrom.balanceOf(address(this));
        uint256 buyAmount = priceChecker.getExpectedOut(balance, address(tokenFrom), address(tokenTo));

        validTo = uint32(block.timestamp + 60 minutes);

        GPv2Order.Data memory order = GPv2Order.Data({
            sellToken: IERC20Metadata(address(tokenFrom)),
            buyToken: IERC20Metadata(address(tokenTo)),
            receiver: TREASURY,
            sellAmount: balance,
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

        // uint256 expectedOut = IPriceChecker(priceChecker).getExpectedOut(
        //     IERC20(tokenFrom).balanceOf(address(this)),
        //     address(tokenFrom),
        //     address(tokenTo),
        //     new bytes(0)
        // );

        // TODO: check if price is much higher than suggested

        return ERC1271_MAGIC_VALUE;
    }

    function cancel() external {
        require(validTo < block.timestamp, "Order: not expired");
        tokenFrom.safeTransfer(stonks, tokenFrom.balanceOf(address(this)));
    }

    function recoverERC20(address token_) external onlyOperator {
        require(token_ != address(tokenFrom), "Order: cannot recover tokenFrom");
        uint256 balance = IERC20(token_).balanceOf(address(this));
        require(balance > 0, "Stonks: insufficient balance");
        _recoverERC20(token_, ARAGON_AGENT, balance);
    }

    modifier onlyOperator() {
        require(msg.sender == operator || msg.sender == ARAGON_AGENT, "Order: not operator");
        _;
    }
}
