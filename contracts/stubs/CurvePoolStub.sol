// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {IMintableERC20} from "./IMintableERC20.sol";

/// @notice `addLiquidity` re-entry probe for the reentrancy guard tests.
interface IReentrantTarget {
    function addLiquidity() external returns (uint256);
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
