// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {AssetRecovererACL} from "./AssetRecovererACL.sol";
import {MathHelpers} from "../lib/MathHelpers.sol";
import {IStETH} from "../interfaces/IStETH.sol";
import {IWstETH} from "../interfaces/IWstETH.sol";
import {IOracleRouter} from "../interfaces/IOracleRouter.sol";
import {ICurvePool} from "../interfaces/ICurvePool.sol";
import {INESTController} from "../interfaces/INESTController.sol";

/**
 * @title LiquidityProvisioner
 * @author swissarmytowel <info@lido.fi>
 * @notice Receives LDO settled directly from CoW Swap via the Stonks receiver and wstETH from the
 *         NESTController, deposits balanced amounts into the Curve LDO/wstETH pool, retains the
 *         minted LP tokens, and unwraps any wstETH overhang after partial or unfilled orders
 *         back to stETH for return to the controller.
 * @dev    Inherits `AssetRecovererACL` for role-based access and recovery to the treasury,
 *         and `ReentrancyGuard` for `addLiquidity`, `removeLiquidity`, `transferLpTokensTo`, and
 *         `unwrapExcessWstEth`. Provisioner and controller hold no roles on each other. They
 *         communicate via public view functions and the `accountForReturnedExcess` callback.
 */
contract LiquidityProvisioner is AssetRecovererACL, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /// @notice Constructor input parameters for the LiquidityProvisioner.
    struct InitParams {
        address admin;
        address treasury;
        address stEth;
        address wstEth;
        address ldo;
        address oracleRouter;
        address nestController;
        address curvePoolAndToken;
        uint256 poolSlippageToleranceBps;
        uint256 poolPriceDivergenceToleranceBps;
    }

    /// @notice Result of an `addLiquidity` gate evaluation. `Eligible` is the only passing value.
    enum AddLiquidityStatus {
        ZeroLdoBalance,
        ZeroWstEthBalance,
        OraclePriceUnavailable,
        PoolPriceUnavailable,
        PoolPriceDivergenceTooHigh,
        ZeroBalancedDepositAmount,
        Eligible
    }

    /// @notice Output of `_evaluateAddLiquidityGates`. Carries the gate status, the balanced
    ///         deposit amounts, and the prices `addLiquidity` reuses for the mint floor and the
    ///         divergence error.
    struct AddLiquidityEvaluation {
        AddLiquidityStatus status;
        uint256 ldoAmount;
        uint256 wstEthAmount;
        uint256 ldoUsdPrice;
        uint256 wstEthUsdPrice;
        uint256 poolEmaPrice;
        uint256 oraclePriceInLdo;
        uint256 divergenceBps;
    }

    /// @notice Result of an `unwrapExcessWstEth` gate evaluation. `Eligible` is the only passing
    ///         value.
    enum UnwrapStatus {
        ZeroExcessWstEth,
        OrderStateUnavailable,
        ControllerProvisionerMismatch,
        CooldownNotElapsed,
        ReservePriceUnavailable,
        Eligible
    }

    /// @notice Output of `_evaluateUnwrapGates`. Carries the gate status, the controller address,
    ///         the excess wstETH to unwrap, and the cooldown values the revert reuses.
    struct UnwrapEvaluation {
        UnwrapStatus status;
        address controller;
        uint256 excessWstEth;
        uint256 lastOrderTimestamp;
        uint256 cooldownEnd;
    }

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice 100% in basis points.
    uint256 public constant MAX_BASIS_POINTS = 10000;

    /// @notice USD amount precision alignment with `OracleRouter` price output.
    uint256 internal constant PRICE_SCALE = 1e18;

    /// @notice Minimum stETH balance an Order holds while still unsettled. Below it, the balance
    ///         is dust the wstETH reserve computation can ignore.
    uint256 internal constant MIN_POSSIBLE_BALANCE = 10;

    /// @notice Upper bound on `poolSlippageToleranceBps`. Caps how far the deposit slippage guard
    ///         can be loosened so a setter cannot drive `minMintAmount` to zero.
    uint256 public constant MAX_POOL_SLIPPAGE_TOLERANCE_BPS = 1000;

    /// @notice Upper bound on `poolPriceDivergenceToleranceBps`. Caps how far the EMA-vs-oracle
    ///         divergence guard can be loosened so a setter cannot disable it.
    uint256 public constant MAX_POOL_DIVERGENCE_TOLERANCE_BPS = 1000;

    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice stETH token. Destination of unwrapped excess wstETH before transfer to the controller.
    IStETH public immutable STETH;

    /// @notice wstETH token. Sell-side asset of the Curve pool and the token unwrapped on excess.
    IWstETH public immutable WSTETH;

    /// @notice LDO token. Buy-side asset of the Curve pool, settled directly from CoW Swap.
    IERC20 public immutable LDO;

    /// @notice Oracle router for LDO and wstETH USD price resolution.
    IOracleRouter public immutable ORACLE_ROUTER;

    /// @notice Curve TwoCrypto LDO/wstETH pool, which doubles as the LP token contract. Coin
    ///         ordering is enforced in the constructor: `coins[0] == LDO`, `coins[1] == wstETH`.
    ICurvePool public immutable CURVE_POOL_AND_TOKEN;

    /*//////////////////////////////////////////////////////////////
                        CONFIGURABLE STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice NESTController address. Source for `lastOrderTimestamp`, `orderDurationSeconds`,
    ///         `stonks`, and `lastOrderAddress` used in the wstETH reserve computation, and the destination
    ///         for unwrapped stETH returned via `unwrapExcessWstEth`.
    /// @dev    Packed with `_liquidityPaused`, `poolSlippageToleranceBps`, and
    ///         `poolPriceDivergenceToleranceBps` into one storage slot.
    address public nestController;

    /// @notice When `true`, `addLiquidity` reverts. `unwrapExcessWstEth` remains callable. Toggled by
    ///         `pauseLiquidity` and `unpauseLiquidity`.
    bool private _liquidityPaused;

    /// @notice Slippage tolerance for Curve deposits and withdrawals, in basis points. Discounts
    ///         the `add_liquidity` mint floor and the `remove_liquidity` withdrawal floors.
    ///         Bounded by `MAX_POOL_SLIPPAGE_TOLERANCE_BPS`, stored as `uint16` for slot packing.
    uint16 public poolSlippageToleranceBps;

    /// @notice Maximum acceptable divergence between the Curve pool's internal EMA price and the
    ///         oracle router's LDO/wstETH price, in basis points. Beyond this threshold,
    ///         `addLiquidity` reverts with `PoolPriceDivergenceTooHigh`. Bounded by
    ///         `MAX_POOL_DIVERGENCE_TOLERANCE_BPS`, stored as `uint16` for slot packing.
    uint16 public poolPriceDivergenceToleranceBps;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event LiquidityAdded(
        address indexed caller,
        address pool,
        uint256 ldoAmount,
        uint256 wstEthAmount,
        uint256 lpTokensMinted
    );
    event LiquidityRemoved(
        address indexed caller,
        address pool,
        uint256 lpAmount,
        uint256 ldoReceived,
        uint256 wstEthReceived
    );
    event LpTokensTransferred(address indexed recipient, uint256 amount);
    event ExcessWstEthUnwrapped(
        uint256 unwrappedWstEthAmount,
        uint256 returnedStEthAmount,
        address indexed recipient
    );
    event LiquidityPaused(address indexed by);
    event LiquidityUnpaused(address indexed by);
    event PoolSlippageToleranceBpsSet(uint256 poolSlippageToleranceBps);
    event PoolPriceDivergenceToleranceBpsSet(uint256 poolPriceDivergenceToleranceBps);
    event NestControllerSet(address indexed nestController);
    event WstEthRecoveredAsStEth(
        uint256 wstEthAmount,
        uint256 stEthAmount,
        address indexed recipient
    );

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroLdoBalance();
    error ZeroWstEthBalance();
    error ZeroExcessWstEth();
    error ZeroLpAmount();
    error ZeroBalancedDepositAmount(uint256 ldoAmount, uint256 wstEthAmount);
    error InsufficientLpTokenBalance(uint256 requested, uint256 available);
    error InvalidRecipientAddress(address recipient);
    error CooldownNotElapsed(uint256 lastOrderTimestamp, uint256 cooldownEnd);
    error OldControllerOrderUnsettled(address order);
    error LiquidityCurrentlyPaused();
    error PoolPriceDivergenceTooHigh(
        uint256 poolPrice,
        uint256 oraclePrice,
        uint256 divergenceBps,
        uint256 toleranceBps
    );
    error OraclePriceUnavailable();
    error PoolPriceUnavailable();
    error OrderStateUnavailable();
    error ControllerProvisionerMismatch();
    error InvalidStEthAddress(address stEth);
    error InvalidWstEthAddress(address wstEth);
    error InvalidLdoAddress(address ldo);
    error InvalidOracleRouterAddress(address oracleRouter);
    error InvalidNestControllerAddress(address nestController);
    error InvalidCurvePoolAndTokenAddress(address curvePoolAndToken);
    error InvalidPoolSlippageTolerance(uint256 poolSlippageToleranceBps);
    error InvalidPoolPriceDivergenceTolerance(uint256 poolPriceDivergenceToleranceBps);
    error InvalidCurvePoolCoinOrdering();

    /*//////////////////////////////////////////////////////////////
                              MODIFIERS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Reverts if liquidity provisioning is paused. Used by `addLiquidity`. Recovery,
     *      excess-wstETH unwrap, and LP-token management remain callable while paused.
     */
    modifier whenLiquidityNotPaused() {
        if (_liquidityPaused) {
            revert LiquidityCurrentlyPaused();
        }
        _;
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Initializes immutables, configurable parameters, and admin roles. Validates every
     *         address, both bps tolerances, and the Curve pool's coin ordering before any storage
     *         write.
     * @param  initParams_ Packed constructor inputs. See `InitParams`.
     */
    constructor(
        InitParams memory initParams_
    ) AssetRecovererACL(initParams_.admin, initParams_.treasury) {
        if (initParams_.stEth == address(0)) {
            revert InvalidStEthAddress(initParams_.stEth);
        }
        if (initParams_.wstEth == address(0)) {
            revert InvalidWstEthAddress(initParams_.wstEth);
        }
        if (initParams_.ldo == address(0)) {
            revert InvalidLdoAddress(initParams_.ldo);
        }
        if (initParams_.oracleRouter == address(0)) {
            revert InvalidOracleRouterAddress(initParams_.oracleRouter);
        }
        if (initParams_.curvePoolAndToken == address(0)) {
            revert InvalidCurvePoolAndTokenAddress(initParams_.curvePoolAndToken);
        }
        if (initParams_.nestController == address(0)) {
            revert InvalidNestControllerAddress(initParams_.nestController);
        }
        if (
            initParams_.poolSlippageToleranceBps == 0 ||
            initParams_.poolSlippageToleranceBps > MAX_POOL_SLIPPAGE_TOLERANCE_BPS
        ) {
            revert InvalidPoolSlippageTolerance(initParams_.poolSlippageToleranceBps);
        }
        if (
            initParams_.poolPriceDivergenceToleranceBps == 0 ||
            initParams_.poolPriceDivergenceToleranceBps > MAX_POOL_DIVERGENCE_TOLERANCE_BPS
        ) {
            revert InvalidPoolPriceDivergenceTolerance(initParams_.poolPriceDivergenceToleranceBps);
        }

        // Pool coin-ordering check goes last, after the cheaper address checks short-circuit.
        if (
            ICurvePool(initParams_.curvePoolAndToken).coins(0) != initParams_.ldo ||
            ICurvePool(initParams_.curvePoolAndToken).coins(1) != initParams_.wstEth
        ) {
            revert InvalidCurvePoolCoinOrdering();
        }

        STETH = IStETH(initParams_.stEth);
        WSTETH = IWstETH(initParams_.wstEth);
        LDO = IERC20(initParams_.ldo);
        ORACLE_ROUTER = IOracleRouter(initParams_.oracleRouter);
        CURVE_POOL_AND_TOKEN = ICurvePool(initParams_.curvePoolAndToken);

        nestController = initParams_.nestController;
        poolSlippageToleranceBps = uint16(initParams_.poolSlippageToleranceBps);
        poolPriceDivergenceToleranceBps = uint16(initParams_.poolPriceDivergenceToleranceBps);
    }

    /*//////////////////////////////////////////////////////////////
                           EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Deposits balanced amounts of LDO and wstETH into the Curve LDO/wstETH pool. Minted
     *         LP tokens stay in the provisioner.
     * @dev    Reverts on pause, zero balances, an unavailable oracle or pool price, divergence
     *         above tolerance, zero balanced amounts, or Curve's slippage guard. Surplus on the
     *         larger-USD side stays in the provisioner for the next cycle.
     * @return lpTokensMinted LP tokens minted by the pool.
     */
    function addLiquidity()
        external
        nonReentrant
        whenLiquidityNotPaused
        returns (uint256 lpTokensMinted)
    {
        AddLiquidityEvaluation memory evaluation = _evaluateAddLiquidityGates();
        _assertAddLiquidityEligible(evaluation);

        uint256 minMintAmount = _computeMinMintAmount(
            evaluation.ldoAmount,
            evaluation.wstEthAmount,
            evaluation.ldoUsdPrice,
            evaluation.wstEthUsdPrice,
            evaluation.poolEmaPrice
        );

        lpTokensMinted = _depositToCurve(
            evaluation.ldoAmount,
            evaluation.wstEthAmount,
            minMintAmount
        );

        emit LiquidityAdded(
            msg.sender,
            address(CURVE_POOL_AND_TOKEN),
            evaluation.ldoAmount,
            evaluation.wstEthAmount,
            lpTokensMinted
        );
    }

    /**
     * @notice Unwraps the provisioner's excess wstETH back to stETH and returns it to the
     *         NESTController. Excess is the wstETH overhang above three buckets that may still
     *         settle into LDO: LDO already in the provisioner, stETH held by Stonks, and stETH
     *         held by the most recent Order.
     * @dev    Permissionless. `nonReentrant` guards the full flow. Remains callable when
     *         liquidity is paused.
     * @return unwrappedStEthAmount stETH produced by the unwrap, forwarded to the controller.
     */
    function unwrapExcessWstEth() external nonReentrant returns (uint256 unwrappedStEthAmount) {
        UnwrapEvaluation memory evaluation = _evaluateUnwrapGates();
        _assertUnwrapEligible(evaluation);

        address controller = evaluation.controller;
        uint256 excessWstEth = evaluation.excessWstEth;

        unwrappedStEthAmount = WSTETH.unwrap(excessWstEth);

        emit ExcessWstEthUnwrapped(excessWstEth, unwrappedStEthAmount, controller);

        IERC20(address(STETH)).safeTransfer(controller, unwrappedStEthAmount);
        INESTController(controller).accountForReturnedExcess(unwrappedStEthAmount);
    }

    /**
     * @notice Burns LP tokens for a proportional LDO/wstETH withdrawal from the Curve pool.
     *         Withdrawn tokens stay in the provisioner for redeposit, recovery, or future use.
     * @dev    `remove_liquidity` withdraws pro-rata, so the caller gets a fair share regardless of
     *         pool skew. `minAmounts` guards only against a misbehaving pool, derived from
     *         `virtual_price` and `price_oracle` rather than live `balances()`. Remains callable
     *         when liquidity is paused.
     * @param  lpAmount_ LP tokens to burn. Strictly positive and within the provisioner's balance.
     * @return ldoReceived LDO withdrawn from the pool.
     * @return wstEthReceived wstETH withdrawn from the pool.
     */
    function removeLiquidity(
        uint256 lpAmount_
    )
        external
        onlyRole(MANAGER_ROLE)
        nonReentrant
        returns (uint256 ldoReceived, uint256 wstEthReceived)
    {
        if (lpAmount_ == 0) {
            revert ZeroLpAmount();
        }

        uint256 lpBalance = IERC20(address(CURVE_POOL_AND_TOKEN)).balanceOf(address(this));
        if (lpBalance < lpAmount_) {
            revert InsufficientLpTokenBalance(lpAmount_, lpBalance);
        }

        uint256[2] memory withdrawn = CURVE_POOL_AND_TOKEN.remove_liquidity(
            lpAmount_,
            _computeMinWithdrawAmounts(lpAmount_)
        );
        ldoReceived = withdrawn[0];
        wstEthReceived = withdrawn[1];

        emit LiquidityRemoved(
            msg.sender,
            address(CURVE_POOL_AND_TOKEN),
            lpAmount_,
            ldoReceived,
            wstEthReceived
        );
    }

    /**
     * @notice Transfers LP tokens to an arbitrary address. Supports pool migration or
     *         provisioner replacement via DAO vote.
     * @dev    Use `recoverERC20` to sweep LP tokens to the treasury. Remains callable when
     *         liquidity is paused.
     * @param  to_ Recipient address. Non-zero.
     * @param  amount_ LP-token amount. Strictly positive and within the provisioner's balance.
     */
    function transferLpTokensTo(
        address to_,
        uint256 amount_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (amount_ == 0) {
            revert ZeroLpAmount();
        }
        if (to_ == address(0)) {
            revert InvalidRecipientAddress(to_);
        }

        uint256 lpBalance = IERC20(address(CURVE_POOL_AND_TOKEN)).balanceOf(address(this));
        if (lpBalance < amount_) {
            revert InsufficientLpTokenBalance(amount_, lpBalance);
        }

        emit LpTokensTransferred(to_, amount_);

        IERC20(address(CURVE_POOL_AND_TOKEN)).safeTransfer(to_, amount_);
    }

    /**
     * @notice Updates the slippage tolerance applied to Curve pool deposits.
     * @dev    Zero is rejected because it would freeze provisioning. Use `pauseLiquidity` instead.
     * @param  poolSlippageToleranceBps_ New tolerance in basis points. In
     *         `(0, MAX_POOL_SLIPPAGE_TOLERANCE_BPS]`.
     */
    function setPoolSlippageToleranceBps(
        uint256 poolSlippageToleranceBps_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (
            poolSlippageToleranceBps_ == 0 ||
            poolSlippageToleranceBps_ > MAX_POOL_SLIPPAGE_TOLERANCE_BPS
        ) {
            revert InvalidPoolSlippageTolerance(poolSlippageToleranceBps_);
        }

        poolSlippageToleranceBps = uint16(poolSlippageToleranceBps_);

        emit PoolSlippageToleranceBpsSet(poolSlippageToleranceBps_);
    }

    /**
     * @notice Updates the maximum acceptable divergence between the Curve pool's EMA price and the
     *         oracle router's LDO/wstETH price.
     * @param  poolPriceDivergenceToleranceBps_ New tolerance in basis points. In
     *         `(0, MAX_POOL_DIVERGENCE_TOLERANCE_BPS]`.
     */
    function setPoolPriceDivergenceToleranceBps(
        uint256 poolPriceDivergenceToleranceBps_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (
            poolPriceDivergenceToleranceBps_ == 0 ||
            poolPriceDivergenceToleranceBps_ > MAX_POOL_DIVERGENCE_TOLERANCE_BPS
        ) {
            revert InvalidPoolPriceDivergenceTolerance(poolPriceDivergenceToleranceBps_);
        }

        poolPriceDivergenceToleranceBps = uint16(poolPriceDivergenceToleranceBps_);

        emit PoolPriceDivergenceToleranceBpsSet(poolPriceDivergenceToleranceBps_);
    }

    /**
     * @notice Updates the NESTController address. The new controller becomes the source for
     *         pipeline state reads and the destination for unwrapped stETH returns.
     * @dev    Blocked while the old controller has a live or unsettled order. Its in-flight stETH
     *         sits outside the new controller's reserve, so migrating then would unwrap wstETH that
     *         still backs that order. Sequence migration after the old controller's order settles.
     * @param  nestController_ New controller address. Non-zero.
     */
    function setNestController(address nestController_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (nestController_ == address(0)) {
            revert InvalidNestControllerAddress(nestController_);
        }

        (
            uint256 lastOrderTimestamp,
            uint256 orderDurationSeconds,
            address lastOrderAddress,

        ) = INESTController(nestController).getOrderState();

        uint256 cooldownEnd = lastOrderTimestamp + orderDurationSeconds;
        if (block.timestamp <= cooldownEnd) {
            revert CooldownNotElapsed(lastOrderTimestamp, cooldownEnd);
        }
        // Cooldown elapsed is not settlement. An expired-unfilled order still holds its stETH.
        if (
            lastOrderAddress != address(0) &&
            STETH.balanceOf(lastOrderAddress) >= MIN_POSSIBLE_BALANCE
        ) {
            revert OldControllerOrderUnsettled(lastOrderAddress);
        }

        nestController = nestController_;

        emit NestControllerSet(nestController_);
    }

    /**
     * @notice Pauses `addLiquidity`. Assets accumulate in the provisioner until unpaused. Does
     *         not affect `unwrapExcessWstEth`, `removeLiquidity`, `transferLpTokensTo`, or
     *         recovery.
     * @dev    Idempotent.
     */
    function pauseLiquidity() external onlyRole(EMERGENCY_ROLE) {
        _liquidityPaused = true;

        emit LiquidityPaused(msg.sender);
    }

    /**
     * @notice Resumes `addLiquidity`.
     * @dev    Idempotent.
     */
    function unpauseLiquidity() external onlyRole(EMERGENCY_ROLE) {
        _liquidityPaused = false;

        emit LiquidityUnpaused(msg.sender);
    }

    /**
     * @notice Recovers an ERC-20 balance to the treasury. When recovering wstETH, the
     *         provisioner auto-unwraps to stETH so the treasury always receives stETH.
     * @dev    Overrides `AssetRecovererACL.recoverERC20` to special-case wstETH. Remains callable
     *         when liquidity is paused.
     * @param  token_ ERC-20 token to recover.
     * @param  amount_ Token amount transferred to `TREASURY`.
     */
    function recoverERC20(
        address token_,
        uint256 amount_
    ) external override onlyRole(MANAGER_ROLE) {
        if (token_ == address(WSTETH)) {
            uint256 stEthAmount = WSTETH.unwrap(amount_);

            emit WstEthRecoveredAsStEth(amount_, stEthAmount, TREASURY);

            IERC20(address(STETH)).safeTransfer(TREASURY, stEthAmount);
        } else {
            emit ERC20Recovered(token_, TREASURY, amount_);

            IERC20(token_).safeTransfer(TREASURY, amount_);
        }
    }

    /*//////////////////////////////////////////////////////////////
                        EXTERNAL VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Returns whether `addLiquidity` is currently paused.
     */
    function isLiquidityPaused() external view returns (bool) {
        return _liquidityPaused;
    }

    /**
     * @notice Returns the provisioner's current Curve LP-token balance.
     */
    function getLpTokenBalance() external view returns (uint256) {
        return IERC20(address(CURVE_POOL_AND_TOKEN)).balanceOf(address(this));
    }

    /**
     * @notice Balanced LDO and wstETH amounts a subsequent `addLiquidity` would deposit at the
     *         current oracle prices.
     * @dev    Never reverts. Returns `(0, 0)` on zero balances, missing prices, or any dependency
     *         revert. A non-zero result sizes a deposit and does not confirm `addLiquidity` would
     *         succeed. Gate on `canAddLiquidity` first.
     */
    function getAvailableLiquidity()
        external
        view
        returns (uint256 ldoAmount, uint256 wstEthAmount)
    {
        uint256 ldoBalance = LDO.balanceOf(address(this));
        if (ldoBalance == 0) {
            return (0, 0);
        }
        uint256 wstEthBalance = WSTETH.balanceOf(address(this));
        if (wstEthBalance == 0) {
            return (0, 0);
        }

        (bool pricesValid, uint256 ldoUsdPrice, uint256 wstEthUsdPrice) = _tryGetUsdPrices(
            address(LDO),
            address(WSTETH)
        );
        if (!pricesValid || ldoUsdPrice == 0 || wstEthUsdPrice == 0) {
            return (0, 0);
        }

        (ldoAmount, wstEthAmount) = _computeBalancedAmounts(
            ldoBalance,
            wstEthBalance,
            ldoUsdPrice,
            wstEthUsdPrice
        );
    }

    /**
     * @notice wstETH overhang against settled LDO only. Ignores in-flight pipeline stETH. For
     *         the figure that mirrors `unwrapExcessWstEth`, use `getUnwrappableExcessWstEth`.
     * @dev    Never reverts. Returns zero on dependency failure or absence of excess.
     */
    function getExcessWstEth() external view returns (uint256 excessWstEthAmount) {
        uint256 wstEthBalance = WSTETH.balanceOf(address(this));
        if (wstEthBalance == 0) {
            return 0;
        }

        uint256 ldoBalance = LDO.balanceOf(address(this));
        // No LDO settled, so the full wstETH balance is excess. Skip the oracle round-trip.
        if (ldoBalance == 0) {
            return wstEthBalance;
        }

        (bool pricesValid, uint256 ldoUsdPrice, uint256 wstEthUsdPrice) = _tryGetUsdPrices(
            address(LDO),
            address(WSTETH)
        );
        if (!pricesValid || wstEthUsdPrice == 0) {
            return 0;
        }

        uint256 ldoEquivalentWstEth = (ldoBalance * ldoUsdPrice) / wstEthUsdPrice;
        excessWstEthAmount = MathHelpers.saturatedSub(wstEthBalance, ldoEquivalentWstEth);
    }

    /**
     * @notice wstETH that `unwrapExcessWstEth` would consume at the current block, accounting
     *         for the full reserve: LDO, Stonks stETH, and last Order stETH.
     * @dev    Never reverts. Returns zero on dependency failure or absence of unwrappable excess.
     */
    function getUnwrappableExcessWstEth() external view returns (uint256 unwrappableWstEthAmount) {
        uint256 wstEthBalance = WSTETH.balanceOf(address(this));
        if (wstEthBalance == 0) {
            return 0;
        }

        (bool stateValid, , , address lastOrderAddress, address stonksAddress) = _tryGetOrderState(
            nestController
        );
        if (!stateValid) {
            return 0;
        }

        (bool reserveValid, uint256 requiredWstEthReserve) = _tryComputeRequiredWstEthReserve(
            stonksAddress,
            lastOrderAddress,
            LDO.balanceOf(address(this))
        );
        if (!reserveValid) {
            return 0;
        }

        unwrappableWstEthAmount = MathHelpers.saturatedSub(wstEthBalance, requiredWstEthReserve);
    }

    /**
     * @notice Whether `addLiquidity` would succeed at the current block.
     * @dev    Never reverts. Mirrors every `addLiquidity` precondition.
     */
    function canAddLiquidity() external view returns (bool) {
        if (_liquidityPaused) {
            return false;
        }
        return _evaluateAddLiquidityGates().status == AddLiquidityStatus.Eligible;
    }

    /**
     * @notice Whether `unwrapExcessWstEth` would succeed at the current block. Keeper polling
     *         predicate.
     * @dev    Never reverts. Mirrors every `unwrapExcessWstEth` precondition, including the
     *         controller's `accountForReturnedExcess` caller binding.
     */
    function canUnwrapExcessWstEth() external view returns (bool) {
        return _evaluateUnwrapGates().status == UnwrapStatus.Eligible;
    }

    /*//////////////////////////////////////////////////////////////
                    INTERNAL STATE-CHANGING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Approves the Curve pool and deposits via `add_liquidity`.
     * @dev    `forceApprove` sets the allowance to the exact deposit amount. The pool consumes the
     *         full approval inside `add_liquidity`.
     * @param  ldoAmount_ LDO amount to deposit.
     * @param  wstEthAmount_ wstETH amount to deposit.
     * @param  minMintAmount_ Minimum LP tokens to accept from `add_liquidity`.
     * @return lpTokensMinted LP tokens received from the Curve pool.
     */
    function _depositToCurve(
        uint256 ldoAmount_,
        uint256 wstEthAmount_,
        uint256 minMintAmount_
    ) internal returns (uint256 lpTokensMinted) {
        LDO.forceApprove(address(CURVE_POOL_AND_TOKEN), ldoAmount_);
        IERC20(address(WSTETH)).forceApprove(address(CURVE_POOL_AND_TOKEN), wstEthAmount_);

        uint256[2] memory amounts = [ldoAmount_, wstEthAmount_];
        lpTokensMinted = CURVE_POOL_AND_TOKEN.add_liquidity(amounts, minMintAmount_);
    }

    /*//////////////////////////////////////////////////////////////
                      INTERNAL READ-ONLY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Revert-safe wrapper around `ORACLE_ROUTER.getUsdPrices`. Returns `pricesValid=false`
     *      with zero prices on revert.
     */
    function _tryGetUsdPrices(
        address base_,
        address quote_
    ) internal view returns (bool pricesValid, uint256 basePrice, uint256 quotePrice) {
        try ORACLE_ROUTER.getUsdPrices(base_, quote_) returns (uint256 b, uint256 q) {
            return (true, b, q);
        } catch {}
    }

    /**
     * @dev Revert-safe wrapper around `CURVE_POOL_AND_TOKEN.price_oracle`. Returns
     *      `poolPriceValid=false` with zero price on revert.
     */
    function _tryPriceOracle() internal view returns (bool poolPriceValid, uint256 price) {
        try CURVE_POOL_AND_TOKEN.price_oracle() returns (uint256 p) {
            return (true, p);
        } catch {}
    }

    /**
     * @dev Revert-safe wrapper around `INESTController.getOrderState`. Returns
     *      `stateValid=false` with zeroed fields on revert.
     */
    function _tryGetOrderState(
        address controller_
    )
        internal
        view
        returns (
            bool stateValid,
            uint256 lastOrderTimestamp,
            uint256 orderDurationSeconds,
            address lastOrderAddress,
            address stonksAddress
        )
    {
        try INESTController(controller_).getOrderState() returns (
            uint256 t,
            uint256 d,
            address a,
            address s
        ) {
            return (true, t, d, a, s);
        } catch {}
    }

    /**
     * @dev Revert-safe wrapper around `WSTETH.getWstETHByStETH`. Returns `conversionValid=false`
     *      with zero amount on revert.
     */
    function _tryGetWstETHByStETH(
        uint256 stEthAmount_
    ) internal view returns (bool conversionValid, uint256 wstEthAmount) {
        try WSTETH.getWstETHByStETH(stEthAmount_) returns (uint256 v) {
            return (true, v);
        } catch {}
    }

    /**
     * @dev Revert-safe wrapper around `INESTController.liquidityProvisioner`. Returns
     *      `bindingValid=false` with the zero address on revert.
     */
    function _tryLiquidityProvisioner(
        address controller_
    ) internal view returns (bool bindingValid, address provisioner) {
        try INESTController(controller_).liquidityProvisioner() returns (address p) {
            return (true, p);
        } catch {}
    }

    /**
     * @notice wstETH that must stay wrapped to back pending settlements. Sum of LDO-equivalent
     *         wstETH plus Stonks and Order stETH converted via the wstETH rate.
     * @dev    Returns `reserveValid=false` with a zero reserve if `getUsdPrices` or
     *         `getWstETHByStETH` reverts, or if `wstEthUsdPrice` is zero.
     * @param  stonksAddress_     Stonks address. Source of the pipeline stETH bucket.
     * @param  lastOrderAddress_  Currently-tracked Order address. Zero skips the Order bucket.
     * @param  ldoBalance_        Pre-fetched LDO balance of the provisioner.
     */
    function _tryComputeRequiredWstEthReserve(
        address stonksAddress_,
        address lastOrderAddress_,
        uint256 ldoBalance_
    ) internal view returns (bool reserveValid, uint256 requiredWstEthReserve) {
        uint256 ldoEquivalentWstEth;
        // No LDO means an empty LDO bucket. Skip the oracle round-trip.
        if (ldoBalance_ != 0) {
            (bool pricesValid, uint256 ldoUsdPrice, uint256 wstEthUsdPrice) = _tryGetUsdPrices(
                address(LDO),
                address(WSTETH)
            );
            if (!pricesValid || wstEthUsdPrice == 0) {
                return (false, 0);
            }
            ldoEquivalentWstEth = (ldoBalance_ * ldoUsdPrice) / wstEthUsdPrice;
        }

        uint256 pipelineStEth = STETH.balanceOf(stonksAddress_);
        if (lastOrderAddress_ != address(0)) {
            pipelineStEth += STETH.balanceOf(lastOrderAddress_);
        }

        uint256 stEthEquivalentWstEth;
        if (pipelineStEth != 0) {
            (bool conversionValid, uint256 value) = _tryGetWstETHByStETH(pipelineStEth);
            if (!conversionValid) {
                return (false, 0);
            }
            stEthEquivalentWstEth = value;
        }

        requiredWstEthReserve = ldoEquivalentWstEth + stEthEquivalentWstEth;
        return (true, requiredWstEthReserve);
    }

    /**
     * @notice Runs every shared `addLiquidity` gate and computes the balanced deposit pair.
     * @dev    Non-reverting. A router or pool revert maps to `OraclePriceUnavailable` or
     *         `PoolPriceUnavailable`. `addLiquidity` reverts on a non-`Eligible` status,
     *         `canAddLiquidity` returns whether the status is `Eligible`.
     * @return evaluation Gate status, balanced deposit amounts, prices, and divergence values.
     */
    function _evaluateAddLiquidityGates()
        internal
        view
        returns (AddLiquidityEvaluation memory evaluation)
    {
        uint256 ldoBalance = LDO.balanceOf(address(this));
        if (ldoBalance == 0) {
            evaluation.status = AddLiquidityStatus.ZeroLdoBalance;
            return evaluation;
        }

        uint256 wstEthBalance = WSTETH.balanceOf(address(this));
        if (wstEthBalance == 0) {
            evaluation.status = AddLiquidityStatus.ZeroWstEthBalance;
            return evaluation;
        }

        (bool pricesValid, uint256 ldoUsdPrice, uint256 wstEthUsdPrice) = _tryGetUsdPrices(
            address(LDO),
            address(WSTETH)
        );
        if (!pricesValid || ldoUsdPrice == 0 || wstEthUsdPrice == 0) {
            evaluation.status = AddLiquidityStatus.OraclePriceUnavailable;
            return evaluation;
        }

        // Curve `price_oracle()` is the wstETH price in LDO scaled by 1e18. Match that
        // orientation. `ldoUsdPrice` is guarded non-zero above.
        uint256 oraclePriceInLdo = (wstEthUsdPrice * PRICE_SCALE) / ldoUsdPrice;
        if (oraclePriceInLdo == 0) {
            evaluation.status = AddLiquidityStatus.OraclePriceUnavailable;
            return evaluation;
        }

        (bool poolPriceValid, uint256 poolEmaPrice) = _tryPriceOracle();
        if (!poolPriceValid) {
            evaluation.status = AddLiquidityStatus.PoolPriceUnavailable;
            return evaluation;
        }

        uint256 divergenceBps;
        uint256 diff = poolEmaPrice >= oraclePriceInLdo
            ? poolEmaPrice - oraclePriceInLdo
            : oraclePriceInLdo - poolEmaPrice;
        divergenceBps = (diff * MAX_BASIS_POINTS) / oraclePriceInLdo;

        evaluation.ldoUsdPrice = ldoUsdPrice;
        evaluation.wstEthUsdPrice = wstEthUsdPrice;
        evaluation.poolEmaPrice = poolEmaPrice;
        evaluation.oraclePriceInLdo = oraclePriceInLdo;
        evaluation.divergenceBps = divergenceBps;

        if (divergenceBps > poolPriceDivergenceToleranceBps) {
            evaluation.status = AddLiquidityStatus.PoolPriceDivergenceTooHigh;
            return evaluation;
        }

        (uint256 ldoAmount, uint256 wstEthAmount) = _computeBalancedAmounts(
            ldoBalance,
            wstEthBalance,
            ldoUsdPrice,
            wstEthUsdPrice
        );
        evaluation.ldoAmount = ldoAmount;
        evaluation.wstEthAmount = wstEthAmount;

        if (ldoAmount == 0 || wstEthAmount == 0) {
            evaluation.status = AddLiquidityStatus.ZeroBalancedDepositAmount;
            return evaluation;
        }

        evaluation.status = AddLiquidityStatus.Eligible;
    }

    /**
     * @notice Reverts with the error matching a non-`Eligible` add-liquidity evaluation.
     * @param  evaluation_ Result of `_evaluateAddLiquidityGates`.
     */
    function _assertAddLiquidityEligible(AddLiquidityEvaluation memory evaluation_) internal view {
        AddLiquidityStatus status = evaluation_.status;
        if (status == AddLiquidityStatus.Eligible) {
            return;
        }
        if (status == AddLiquidityStatus.ZeroLdoBalance) {
            revert ZeroLdoBalance();
        }
        if (status == AddLiquidityStatus.ZeroWstEthBalance) {
            revert ZeroWstEthBalance();
        }
        if (status == AddLiquidityStatus.OraclePriceUnavailable) {
            revert OraclePriceUnavailable();
        }
        if (status == AddLiquidityStatus.PoolPriceUnavailable) {
            revert PoolPriceUnavailable();
        }
        if (status == AddLiquidityStatus.PoolPriceDivergenceTooHigh) {
            revert PoolPriceDivergenceTooHigh(
                evaluation_.poolEmaPrice,
                evaluation_.oraclePriceInLdo,
                evaluation_.divergenceBps,
                poolPriceDivergenceToleranceBps
            );
        }
        revert ZeroBalancedDepositAmount(evaluation_.ldoAmount, evaluation_.wstEthAmount);
    }

    /**
     * @notice Runs every shared `unwrapExcessWstEth` gate and computes the excess to unwrap.
     * @dev    Non-reverting. An order-state or reserve dependency revert maps to a named status.
     *         `unwrapExcessWstEth` reverts on a non-`Eligible` status, `canUnwrapExcessWstEth`
     *         returns whether the status is `Eligible`. The binding gate mirrors the controller's
     *         `accountForReturnedExcess` caller check.
     * @return evaluation Gate status, controller address, excess amount, and cooldown values.
     */
    function _evaluateUnwrapGates() internal view returns (UnwrapEvaluation memory evaluation) {
        address controller = nestController;
        evaluation.controller = controller;

        uint256 wstEthBalance = WSTETH.balanceOf(address(this));
        if (wstEthBalance == 0) {
            evaluation.status = UnwrapStatus.ZeroExcessWstEth;
            return evaluation;
        }

        (
            bool stateValid,
            uint256 lastOrderTimestamp,
            uint256 orderDurationSeconds,
            address lastOrderAddress,
            address stonksAddress
        ) = _tryGetOrderState(controller);
        if (!stateValid) {
            evaluation.status = UnwrapStatus.OrderStateUnavailable;
            return evaluation;
        }

        // The unwrap path ends in `accountForReturnedExcess`, which the controller restricts to
        // its bound provisioner. An orphaned old provisioner fails that callback.
        (bool bindingValid, address boundProvisioner) = _tryLiquidityProvisioner(controller);
        if (!bindingValid || boundProvisioner != address(this)) {
            evaluation.status = UnwrapStatus.ControllerProvisionerMismatch;
            return evaluation;
        }

        uint256 cooldownEnd;
        cooldownEnd = lastOrderTimestamp + orderDurationSeconds;

        evaluation.lastOrderTimestamp = lastOrderTimestamp;
        evaluation.cooldownEnd = cooldownEnd;
        if (block.timestamp <= cooldownEnd) {
            evaluation.status = UnwrapStatus.CooldownNotElapsed;
            return evaluation;
        }

        (bool reserveValid, uint256 requiredWstEthReserve) = _tryComputeRequiredWstEthReserve(
            stonksAddress,
            lastOrderAddress,
            LDO.balanceOf(address(this))
        );
        if (!reserveValid) {
            evaluation.status = UnwrapStatus.ReservePriceUnavailable;
            return evaluation;
        }

        if (wstEthBalance <= requiredWstEthReserve) {
            evaluation.status = UnwrapStatus.ZeroExcessWstEth;
            return evaluation;
        }
        evaluation.excessWstEth = wstEthBalance - requiredWstEthReserve;

        evaluation.status = UnwrapStatus.Eligible;
    }

    /**
     * @notice Reverts with the error matching a non-`Eligible` unwrap evaluation.
     * @param  evaluation_ Result of `_evaluateUnwrapGates`.
     */
    function _assertUnwrapEligible(UnwrapEvaluation memory evaluation_) internal pure {
        UnwrapStatus status = evaluation_.status;
        if (status == UnwrapStatus.Eligible) {
            return;
        }
        if (status == UnwrapStatus.ZeroExcessWstEth) {
            revert ZeroExcessWstEth();
        }
        if (status == UnwrapStatus.OrderStateUnavailable) {
            revert OrderStateUnavailable();
        }
        if (status == UnwrapStatus.ControllerProvisionerMismatch) {
            revert ControllerProvisionerMismatch();
        }
        if (status == UnwrapStatus.CooldownNotElapsed) {
            revert CooldownNotElapsed(evaluation_.lastOrderTimestamp, evaluation_.cooldownEnd);
        }
        revert OraclePriceUnavailable();
    }

    /**
     * @notice Balanced LDO and wstETH deposit pair, anchored on the smaller-USD side.
     * @dev    Pure math. Shared by `addLiquidity` and `getAvailableLiquidity` for identical reads.
     * @param  ldoBalance_ Current LDO balance of the provisioner.
     * @param  wstEthBalance_ Current wstETH balance of the provisioner.
     * @param  ldoUsdPrice_ LDO/USD price scaled by `PRICE_SCALE`.
     * @param  wstEthUsdPrice_ wstETH/USD price scaled by `PRICE_SCALE`.
     * @return ldoAmount Balanced LDO amount to deposit.
     * @return wstEthAmount Balanced wstETH amount to deposit.
     */
    function _computeBalancedAmounts(
        uint256 ldoBalance_,
        uint256 wstEthBalance_,
        uint256 ldoUsdPrice_,
        uint256 wstEthUsdPrice_
    ) internal pure returns (uint256 ldoAmount, uint256 wstEthAmount) {
        uint256 ldoUsdValue = (ldoBalance_ * ldoUsdPrice_) / PRICE_SCALE;
        uint256 wstEthUsdValue = (wstEthBalance_ * wstEthUsdPrice_) / PRICE_SCALE;

        if (ldoUsdValue <= wstEthUsdValue) {
            ldoAmount = ldoBalance_;
            wstEthAmount = (ldoUsdValue * PRICE_SCALE) / wstEthUsdPrice_;
        } else {
            wstEthAmount = wstEthBalance_;
            ldoAmount = (wstEthUsdValue * PRICE_SCALE) / ldoUsdPrice_;
        }
    }

    /**
     * @notice Minimum LP tokens `addLiquidity` accepts from `add_liquidity`.
     * @dev    A guard built on `calc_token_amount` cannot fire, since it reads the same reserves
     *         `add_liquidity` mints from. This values the deposit and one LP token in USD instead,
     *         the LP token via `lp_price = 2 * virtual_price * sqrt(price_oracle)` in LDO.
     *         `price_oracle` is the EMA divergence-checked against the oracle in `addLiquidity`.
     * @param  ldoAmount_ Balanced LDO amount being deposited.
     * @param  wstEthAmount_ Balanced wstETH amount being deposited.
     * @param  ldoUsdPrice_ LDO/USD price scaled by `PRICE_SCALE`.
     * @param  wstEthUsdPrice_ wstETH/USD price scaled by `PRICE_SCALE`.
     * @param  poolEmaPrice_ Curve `price_oracle()`, wstETH price in LDO scaled by `PRICE_SCALE`.
     * @return minMintAmount Minimum LP tokens to accept from `add_liquidity`.
     */
    function _computeMinMintAmount(
        uint256 ldoAmount_,
        uint256 wstEthAmount_,
        uint256 ldoUsdPrice_,
        uint256 wstEthUsdPrice_,
        uint256 poolEmaPrice_
    ) internal view returns (uint256 minMintAmount) {
        uint256 depositUsdValue = (ldoAmount_ * ldoUsdPrice_ + wstEthAmount_ * wstEthUsdPrice_) /
            PRICE_SCALE;

        uint256 virtualPrice = CURVE_POOL_AND_TOKEN.get_virtual_price();
        // lp_price in LDO. sqrt(po * PRICE_SCALE) keeps the root PRICE_SCALE-scaled.
        uint256 lpPriceInLdo = (2 * virtualPrice * Math.sqrt(poolEmaPrice_ * PRICE_SCALE)) /
            PRICE_SCALE;
        uint256 lpUsdValue = (lpPriceInLdo * ldoUsdPrice_) / PRICE_SCALE;

        minMintAmount =
            (depositUsdValue * (MAX_BASIS_POINTS - poolSlippageToleranceBps)) /
            (lpUsdValue * MAX_BASIS_POINTS);
    }

    /**
     * @notice Minimum `[LDO, wstETH]` amounts `removeLiquidity` accepts from `remove_liquidity`.
     * @dev    A balanced cryptoswap pool holds `virtual_price * sqrt(price_oracle)` LDO and
     *         `virtual_price / sqrt(price_oracle)` wstETH per LP token, discounted by
     *         `poolSlippageToleranceBps`.
     * @param  lpAmount_ LP tokens being burned.
     * @return minAmounts Minimum `[LDO, wstETH]` to accept from `remove_liquidity`.
     */
    function _computeMinWithdrawAmounts(
        uint256 lpAmount_
    ) internal view returns (uint256[2] memory minAmounts) {
        uint256 virtualPrice = CURVE_POOL_AND_TOKEN.get_virtual_price();
        uint256 sqrtPoolPrice = Math.sqrt(CURVE_POOL_AND_TOKEN.price_oracle() * PRICE_SCALE);
        uint256 keptBps = MAX_BASIS_POINTS - poolSlippageToleranceBps;

        minAmounts[0] =
            (lpAmount_ * virtualPrice * sqrtPoolPrice * keptBps) /
            (PRICE_SCALE * PRICE_SCALE * MAX_BASIS_POINTS);
        minAmounts[1] = (lpAmount_ * virtualPrice * keptBps) / (sqrtPoolPrice * MAX_BASIS_POINTS);
    }
}
