// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title BuybackExecutor stubs
 * @notice Test doubles for the external dependencies of `BuybackExecutor`: the Curve LDO/wstETH
 *         pool and LP token, wstETH, the LDO and stETH ERC20s, Stonks, and the order it places.
 *         Each exposes setters so a test scripts a precise branch. The `OracleRouterUsdStub` from
 *         `StakingRevenueSourceStubs.sol` covers the oracle and is reused as-is.
 */

/// @notice Minting surface shared by the ERC20 stubs, used across stubs to settle balances.
interface IMintableERC20 {
    function mint(address to_, uint256 amount_) external;
}

/// @notice `addLiquidity` re-entry probe for the reentrancy guard tests.
interface IReentrantTarget {
    function addLiquidity() external returns (uint256);
}

/**
 * @notice Mintable ERC20 standing in for LDO and stETH. The executor reaches stETH only through
 *         the IERC20 surface, so a plain ERC20 covers both.
 */
contract ERC20Stub is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to_, uint256 amount_) external {
        _mint(to_, amount_);
    }
}

/**
 * @notice wstETH stub. Wraps stETH at a settable share rate, with an optional 1-wei wrap round-down
 *         to exercise the executor's use of the minted amount. Doubles as the wstETH ERC20.
 */
contract WstEthStub is ERC20 {
    uint256 internal constant SHARE_RATE_UNIT = 1e18;

    address public stEthAddress;
    uint256 public stEthPerTokenValue = SHARE_RATE_UNIT;
    bool public roundDownWrap;

    constructor(address stEthAddress_) ERC20("Wrapped stETH stub", "wstETHstub") {
        stEthAddress = stEthAddress_;
    }

    function setStEth(address stEthAddress_) external {
        stEthAddress = stEthAddress_;
    }

    function setStEthPerToken(uint256 stEthPerTokenValue_) external {
        stEthPerTokenValue = stEthPerTokenValue_;
    }

    function setRoundDownWrap(bool roundDownWrap_) external {
        roundDownWrap = roundDownWrap_;
    }

    function mint(address to_, uint256 amount_) external {
        _mint(to_, amount_);
    }

    function stETH() external view returns (address) {
        return stEthAddress;
    }

    function stEthPerToken() external view returns (uint256) {
        return stEthPerTokenValue;
    }

    function getStETHByWstETH(uint256 wstEthAmount_) public view returns (uint256) {
        return (wstEthAmount_ * stEthPerTokenValue) / SHARE_RATE_UNIT;
    }

    function getWstETHByStETH(uint256 stEthAmount_) public view returns (uint256) {
        return (stEthAmount_ * SHARE_RATE_UNIT) / stEthPerTokenValue;
    }

    function wrap(uint256 stEthAmount_) external returns (uint256 wstEthAmount) {
        ERC20(stEthAddress).transferFrom(msg.sender, address(this), stEthAmount_);

        wstEthAmount = getWstETHByStETH(stEthAmount_);
        if (roundDownWrap && wstEthAmount > 0) {
            wstEthAmount -= 1;
        }

        _mint(msg.sender, wstEthAmount);
    }

    function unwrap(uint256 wstEthAmount_) external returns (uint256 stEthAmount) {
        _burn(msg.sender, wstEthAmount_);

        stEthAmount = getStETHByWstETH(wstEthAmount_);
        IMintableERC20(stEthAddress).mint(msg.sender, stEthAmount);
    }
}

/**
 * @notice Curve TwoCrypto LDO/wstETH pool stub. Also the LP ERC20. Reserves reported by `balances`
 *         are settable independently of token `balanceOf`, so a direct token donation does not move
 *         the TVL the executor reads. A reentrancy mode re-enters `addLiquidity` to trip the guard.
 */
contract CurvePoolStub is ERC20 {
    error CurveAddLiquidityReverted();
    error CurveWithdrawalBelowFloor();

    address public coin0;
    address public coin1;

    uint256 public priceOracleValue;
    uint256 public reserve0;
    uint256 public reserve1;

    /// @notice LP minted by the next `add_liquidity`. Zero falls back to the sum of the deposit legs.
    uint256 public nextLpMint;
    uint256 public nextWithdrawnLdo;
    uint256 public nextWithdrawnWstEth;

    bool public revertOnAddLiquidity;

    address public reentrantTarget;
    bool public reentrancyArmed;

    uint256 public lastAddLiquidityLdo;
    uint256 public lastAddLiquidityWstEth;
    uint256 public lastMinMint;

    constructor(address coin0_, address coin1_) ERC20("Curve LP stub", "crvLPstub") {
        coin0 = coin0_;
        coin1 = coin1_;
    }

    function setCoins(address coin0_, address coin1_) external {
        coin0 = coin0_;
        coin1 = coin1_;
    }

    function setPriceOracle(uint256 priceOracleValue_) external {
        priceOracleValue = priceOracleValue_;
    }

    function setBalances(uint256 reserve0_, uint256 reserve1_) external {
        reserve0 = reserve0_;
        reserve1 = reserve1_;
    }

    function setNextLpMint(uint256 nextLpMint_) external {
        nextLpMint = nextLpMint_;
    }

    function setNextWithdrawn(uint256 nextWithdrawnLdo_, uint256 nextWithdrawnWstEth_) external {
        nextWithdrawnLdo = nextWithdrawnLdo_;
        nextWithdrawnWstEth = nextWithdrawnWstEth_;
    }

    function setRevertOnAddLiquidity(bool revertOnAddLiquidity_) external {
        revertOnAddLiquidity = revertOnAddLiquidity_;
    }

    function armReentrancy(address reentrantTarget_, bool reentrancyArmed_) external {
        reentrantTarget = reentrantTarget_;
        reentrancyArmed = reentrancyArmed_;
    }

    function mint(address to_, uint256 amount_) external {
        _mint(to_, amount_);
    }

    function coins(uint256 index_) external view returns (address) {
        return index_ == 0 ? coin0 : coin1;
    }

    function price_oracle() external view returns (uint256) {
        return priceOracleValue;
    }

    function balances(uint256 index_) external view returns (uint256) {
        return index_ == 0 ? reserve0 : reserve1;
    }

    function add_liquidity(
        uint256[2] calldata amounts_,
        uint256 minMintAmount_
    ) external returns (uint256 lpAmount) {
        if (reentrancyArmed) {
            IReentrantTarget(reentrantTarget).addLiquidity();
        }

        if (revertOnAddLiquidity) {
            revert CurveAddLiquidityReverted();
        }

        lastAddLiquidityLdo = amounts_[0];
        lastAddLiquidityWstEth = amounts_[1];
        lastMinMint = minMintAmount_;

        ERC20(coin0).transferFrom(msg.sender, address(this), amounts_[0]);
        ERC20(coin1).transferFrom(msg.sender, address(this), amounts_[1]);

        lpAmount = nextLpMint == 0 ? amounts_[0] + amounts_[1] : nextLpMint;
        _mint(msg.sender, lpAmount);
    }

    function remove_liquidity(
        uint256 amount_,
        uint256[2] calldata minAmounts_
    ) external returns (uint256[2] memory withdrawn) {
        if (reentrancyArmed) {
            IReentrantTarget(reentrantTarget).addLiquidity();
        }

        _burn(msg.sender, amount_);

        if (nextWithdrawnLdo < minAmounts_[0] || nextWithdrawnWstEth < minAmounts_[1]) {
            revert CurveWithdrawalBelowFloor();
        }

        IMintableERC20(coin0).mint(msg.sender, nextWithdrawnLdo);
        IMintableERC20(coin1).mint(msg.sender, nextWithdrawnWstEth);

        withdrawn[0] = nextWithdrawnLdo;
        withdrawn[1] = nextWithdrawnWstEth;
    }
}

/**
 * @notice Order stub. Records `recoverTokenFrom` calls. Its residual stETH is the stETH stub
 *         balance minted to this address.
 */
contract OrderStub {
    event RecoverTokenFromCalled();

    uint256 public recoverTokenFromCalls;

    function recoverTokenFrom() external {
        recoverTokenFromCalls += 1;
        emit RecoverTokenFromCalled();
    }
}

/**
 * @notice Stonks stub. The receiver drives the executor's operating mode. `placeOrderWithAmount`
 *         deploys a fresh `OrderStub` and records the sizing. Estimate and the pause forwards carry
 *         revert modes for the failure-path tests.
 */
contract StonksStub {
    error EstimateReverted();
    error MissingStonksRights();

    address public receiver;
    uint256 public orderDurationSeconds;
    uint256 public estimatedOutput;
    bool public revertEstimate;
    bool public creationPaused;
    bool public killed;
    bool public revertOnRightsCall;

    address public lastOrder;
    uint256 public lastSellAmount;
    uint256 public lastMinBuyAmount;
    uint256 public pauseCreationCalls;
    uint256 public unpauseCreationCalls;
    uint256 public pauseSignaturesCalls;
    uint256 public unpauseSignaturesCalls;

    function setReceiver(address receiver_) external {
        receiver = receiver_;
    }

    function setOrderDuration(uint256 orderDurationSeconds_) external {
        orderDurationSeconds = orderDurationSeconds_;
    }

    function setEstimatedOutput(uint256 estimatedOutput_) external {
        estimatedOutput = estimatedOutput_;
    }

    function setRevertEstimate(bool revertEstimate_) external {
        revertEstimate = revertEstimate_;
    }

    function setCreationPaused(bool creationPaused_) external {
        creationPaused = creationPaused_;
    }

    function setKilled(bool killed_) external {
        killed = killed_;
    }

    function setRevertOnRightsCall(bool revertOnRightsCall_) external {
        revertOnRightsCall = revertOnRightsCall_;
    }

    function RECEIVER() external view returns (address) {
        return receiver;
    }

    function ORDER_DURATION_IN_SECONDS() external view returns (uint256) {
        return orderDurationSeconds;
    }

    function isCreationPaused() external view returns (bool) {
        return creationPaused;
    }

    function isKilled() external view returns (bool) {
        return killed;
    }

    function estimateTradeOutput(uint256) external view returns (uint256) {
        if (revertEstimate) {
            revert EstimateReverted();
        }
        return estimatedOutput;
    }

    function placeOrderWithAmount(
        uint256 sellAmount_,
        uint256 minBuyAmount_
    ) external returns (address) {
        lastSellAmount = sellAmount_;
        lastMinBuyAmount = minBuyAmount_;

        OrderStub order = new OrderStub();
        lastOrder = address(order);

        return lastOrder;
    }

    function pauseCreation() external {
        if (revertOnRightsCall) {
            revert MissingStonksRights();
        }
        pauseCreationCalls += 1;
    }

    function unpauseCreation() external {
        if (revertOnRightsCall) {
            revert MissingStonksRights();
        }
        unpauseCreationCalls += 1;
    }

    function pauseSignatures() external {
        if (revertOnRightsCall) {
            revert MissingStonksRights();
        }
        pauseSignaturesCalls += 1;
    }

    function unpauseSignatures() external {
        if (revertOnRightsCall) {
            revert MissingStonksRights();
        }
        unpauseSignaturesCalls += 1;
    }
}
