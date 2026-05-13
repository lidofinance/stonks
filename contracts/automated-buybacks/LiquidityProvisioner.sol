// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import {AssetRecovererACL} from "./AssetRecovererACL.sol";
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
 * @dev    Inherits `AssetRecovererACL` for role-based access and recovery to the Aragon Agent,
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
        address agent;
        address stEth;
        address wstEth;
        address ldo;
        address oracleRouter;
        address nestController;
        address curvePoolAndToken;
        uint256 poolSlippageToleranceBps;
        uint256 poolPriceDivergenceToleranceBps;
    }

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice 100% in basis points.
    uint256 public constant MAX_BASIS_POINTS = 10000;

    /// @notice USD amount precision alignment with `OracleRouter` price output.
    uint256 internal constant PRICE_SCALE = 1e18;

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
    ///         `stonks`, and `lastOrderAddress` used in the excess-wstETH clamp, and the destination
    ///         for unwrapped stETH returned via `unwrapExcessWstEth`.
    /// @dev    Packed with `_liquidityPaused`, `poolSlippageToleranceBps`, and
    ///         `poolPriceDivergenceToleranceBps` into one storage slot.
    address public nestController;

    /// @notice When `true`, `addLiquidity` reverts. `unwrapExcessWstEth` remains callable. Toggled by
    ///         `pauseLiquidity` and `unpauseLiquidity`.
    bool private _liquidityPaused;

    /// @notice Maximum acceptable slippage for the Curve liquidity provision step, in basis points.
    ///         Applied to the `calc_token_amount` estimate to derive `min_mint_amount` for
    ///         `add_liquidity`. Bounded by `MAX_BASIS_POINTS`, stored as `uint16` for slot packing.
    uint16 public poolSlippageToleranceBps;

    /// @notice Maximum acceptable divergence between the Curve pool's internal EMA price and the
    ///         oracle router's LDO/wstETH price, in basis points. Beyond this threshold,
    ///         `addLiquidity` reverts with `PoolPriceDivergenceTooHigh`. Bounded by
    ///         `MAX_BASIS_POINTS`, stored as `uint16` for slot packing.
    uint16 public poolPriceDivergenceToleranceBps;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event LiquidityAdded(
        address indexed caller,
        address indexed pool,
        uint256 ldoAmount,
        uint256 wstEthAmount,
        uint256 lpTokensMinted
    );
    event LiquidityRemoved(
        address indexed caller,
        address indexed pool,
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
    error LiquidityCurrentlyPaused();
    error PoolPriceDivergenceTooHigh(
        uint256 poolPrice,
        uint256 oraclePrice,
        uint256 divergenceBps,
        uint256 toleranceBps
    );
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
    ) AssetRecovererACL(initParams_.admin, initParams_.agent) {
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
            initParams_.poolSlippageToleranceBps > MAX_BASIS_POINTS
        ) {
            revert InvalidPoolSlippageTolerance(initParams_.poolSlippageToleranceBps);
        }
        if (
            initParams_.poolPriceDivergenceToleranceBps == 0 ||
            initParams_.poolPriceDivergenceToleranceBps > MAX_BASIS_POINTS
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
     * @dev    Reverts on pause, zero balances, oracle divergence above tolerance, zero balanced
     *         amounts, or Curve's slippage guard. Surplus on the larger-USD side stays in the
     *         provisioner for the next cycle.
     * @return lpTokensMinted LP tokens minted by the pool.
     */
    function addLiquidity()
        external
        nonReentrant
        whenLiquidityNotPaused
        returns (uint256 lpTokensMinted)
    {
        uint256 ldoBalance = LDO.balanceOf(address(this));
        if (ldoBalance == 0) {
            revert ZeroLdoBalance();
        }

        uint256 wstEthBalance = WSTETH.balanceOf(address(this));
        if (wstEthBalance == 0) {
            revert ZeroWstEthBalance();
        }

        (uint256 ldoUsdPrice, uint256 wstEthUsdPrice) = ORACLE_ROUTER.getUsdPrices(
            address(LDO),
            address(WSTETH)
        );

        // Curve TwoCrypto's `price_oracle()` returns the wstETH price measured in LDO and
        // scaled by 1e18. Match that orientation here. A zero LDO price divbyzero-panics, the
        // intended boundary fail-safe.
        uint256 oracleWstEthInLdoPriceScaled;
        uint256 poolEmaPrice;
        uint256 divergenceBps;
        unchecked {
            // Products stay well below 2^256 at realistic prices. The ternary takes the larger
            // operand so the subtraction cannot underflow. Divbyzero on the denominator panics.
            oracleWstEthInLdoPriceScaled = (wstEthUsdPrice * PRICE_SCALE) / ldoUsdPrice;
            poolEmaPrice = CURVE_POOL_AND_TOKEN.price_oracle();
            uint256 diff = poolEmaPrice >= oracleWstEthInLdoPriceScaled
                ? poolEmaPrice - oracleWstEthInLdoPriceScaled
                : oracleWstEthInLdoPriceScaled - poolEmaPrice;
            divergenceBps = (diff * MAX_BASIS_POINTS) / oracleWstEthInLdoPriceScaled;
        }
        if (divergenceBps > poolPriceDivergenceToleranceBps) {
            revert PoolPriceDivergenceTooHigh(
                poolEmaPrice,
                oracleWstEthInLdoPriceScaled,
                divergenceBps,
                poolPriceDivergenceToleranceBps
            );
        }

        (uint256 ldoAmount, uint256 wstEthAmount) = _computeBalancedAmounts(
            ldoBalance,
            wstEthBalance,
            ldoUsdPrice,
            wstEthUsdPrice
        );
        if (ldoAmount == 0 || wstEthAmount == 0) {
            revert ZeroBalancedDepositAmount(ldoAmount, wstEthAmount);
        }

        lpTokensMinted = _depositToCurve(ldoAmount, wstEthAmount);

        emit LiquidityAdded(
            msg.sender,
            address(CURVE_POOL_AND_TOKEN),
            ldoAmount,
            wstEthAmount,
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
        address controller = nestController;
        (
            uint256 lastOrderTimestamp,
            uint256 orderDurationSeconds,
            address lastOrderAddress,
            address stonksAddress
        ) = INESTController(controller).getOrderState();

        uint256 cooldownEnd;
        unchecked {
            // Both terms fit comfortably in a uint64. The sum cannot approach 2^256.
            cooldownEnd = lastOrderTimestamp + orderDurationSeconds;
        }
        if (block.timestamp < cooldownEnd) {
            revert CooldownNotElapsed(lastOrderTimestamp, cooldownEnd);
        }

        // Short-circuit when there is nothing to unwrap, ahead of the clamp's external reads.
        uint256 wstEthBalance = WSTETH.balanceOf(address(this));
        if (wstEthBalance == 0) {
            revert ZeroExcessWstEth();
        }

        uint256 clampTarget = _computeClampTarget(
            stonksAddress,
            lastOrderAddress,
            LDO.balanceOf(address(this))
        );

        if (wstEthBalance <= clampTarget) {
            revert ZeroExcessWstEth();
        }
        uint256 excessWstEth = wstEthBalance - clampTarget;

        unwrappedStEthAmount = WSTETH.unwrap(excessWstEth);

        emit ExcessWstEthUnwrapped(excessWstEth, unwrappedStEthAmount, controller);

        IERC20(address(STETH)).safeTransfer(controller, unwrappedStEthAmount);
        INESTController(controller).accountForReturnedExcess(unwrappedStEthAmount);
    }

    /**
     * @notice Burns LP tokens for a proportional LDO/wstETH withdrawal from the Curve pool.
     *         Withdrawn tokens stay in the provisioner for redeposit, recovery, or future use.
     * @dev    Minimum-out amounts are the pro-rata entitlements discounted by
     *         `poolSlippageToleranceBps`. Remains callable when liquidity is paused.
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

        uint256 reserveLdo = CURVE_POOL_AND_TOKEN.balances(0);
        uint256 reserveWstEth = CURVE_POOL_AND_TOKEN.balances(1);
        uint256 lpTotalSupply = IERC20(address(CURVE_POOL_AND_TOKEN)).totalSupply();

        uint256 slippageBps = poolSlippageToleranceBps;
        uint256 minLdoAmount = (((lpAmount_ * reserveLdo) / lpTotalSupply) *
            (MAX_BASIS_POINTS - slippageBps)) / MAX_BASIS_POINTS;
        uint256 minWstEthAmount = (((lpAmount_ * reserveWstEth) / lpTotalSupply) *
            (MAX_BASIS_POINTS - slippageBps)) / MAX_BASIS_POINTS;

        uint256[2] memory minAmounts = [minLdoAmount, minWstEthAmount];
        uint256[2] memory withdrawn = CURVE_POOL_AND_TOKEN.remove_liquidity(lpAmount_, minAmounts);
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
     * @dev    Use `recoverERC20` to sweep LP tokens to the Aragon Agent. Remains callable when
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
     * @param  poolSlippageToleranceBps_ New tolerance in basis points. In `(0, MAX_BASIS_POINTS]`.
     */
    function setPoolSlippageToleranceBps(
        uint256 poolSlippageToleranceBps_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (poolSlippageToleranceBps_ == 0 || poolSlippageToleranceBps_ > MAX_BASIS_POINTS) {
            revert InvalidPoolSlippageTolerance(poolSlippageToleranceBps_);
        }

        poolSlippageToleranceBps = uint16(poolSlippageToleranceBps_);

        emit PoolSlippageToleranceBpsSet(poolSlippageToleranceBps_);
    }

    /**
     * @notice Updates the maximum acceptable divergence between the Curve pool's EMA price and the
     *         oracle router's LDO/wstETH price.
     * @param  poolPriceDivergenceToleranceBps_ New tolerance in basis points. In
     *         `(0, MAX_BASIS_POINTS]`.
     */
    function setPoolPriceDivergenceToleranceBps(
        uint256 poolPriceDivergenceToleranceBps_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (
            poolPriceDivergenceToleranceBps_ == 0 ||
            poolPriceDivergenceToleranceBps_ > MAX_BASIS_POINTS
        ) {
            revert InvalidPoolPriceDivergenceTolerance(poolPriceDivergenceToleranceBps_);
        }

        poolPriceDivergenceToleranceBps = uint16(poolPriceDivergenceToleranceBps_);

        emit PoolPriceDivergenceToleranceBpsSet(poolPriceDivergenceToleranceBps_);
    }

    /**
     * @notice Updates the NESTController address. The new controller becomes the source for
     *         pipeline state reads and the destination for unwrapped stETH returns.
     * @param  nestController_ New controller address. Non-zero.
     */
    function setNestController(address nestController_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (nestController_ == address(0)) {
            revert InvalidNestControllerAddress(nestController_);
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
     * @notice Recovers an ERC-20 balance to the Aragon Agent. When recovering wstETH, the
     *         provisioner auto-unwraps to stETH so the treasury always receives stETH.
     * @dev    Overrides `AssetRecovererACL.recoverERC20` to special-case wstETH. Remains callable
     *         when liquidity is paused.
     * @param  token_ ERC-20 token to recover.
     * @param  amount_ Token amount transferred to `AGENT`.
     */
    function recoverERC20(
        address token_,
        uint256 amount_
    ) external override onlyRole(MANAGER_ROLE) {
        if (token_ == address(WSTETH)) {
            uint256 stEthAmount = WSTETH.unwrap(amount_);

            emit WstEthRecoveredAsStEth(amount_, stEthAmount, AGENT);

            IERC20(address(STETH)).safeTransfer(AGENT, stEthAmount);
        } else {
            emit ERC20Recovered(token_, AGENT, amount_);

            IERC20(token_).safeTransfer(AGENT, amount_);
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
     *         revert.
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

        (bool ok, uint256 ldoUsdPrice, uint256 wstEthUsdPrice) = _tryGetUsdPrices(
            address(LDO),
            address(WSTETH)
        );
        if (!ok || ldoUsdPrice == 0 || wstEthUsdPrice == 0) {
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

        (bool ok, uint256 ldoUsdPrice, uint256 wstEthUsdPrice) = _tryGetUsdPrices(
            address(LDO),
            address(WSTETH)
        );
        if (!ok || wstEthUsdPrice == 0) {
            return 0;
        }

        uint256 ldoEquivalentWstEth = (ldoBalance * ldoUsdPrice) / wstEthUsdPrice;
        if (wstEthBalance > ldoEquivalentWstEth) {
            excessWstEthAmount = wstEthBalance - ldoEquivalentWstEth;
        }
    }

    /**
     * @notice wstETH that `unwrapExcessWstEth` would consume at the current block, accounting
     *         for the full clamp: LDO, Stonks stETH, and last Order stETH.
     * @dev    Never reverts. Returns zero on dependency failure or absence of unwrappable excess.
     */
    function getUnwrappableExcessWstEth() external view returns (uint256 unwrappableWstEthAmount) {
        uint256 wstEthBalance = WSTETH.balanceOf(address(this));
        if (wstEthBalance == 0) {
            return 0;
        }

        (bool stateOk, , , address lastOrderAddress, address stonksAddress) = _tryGetOrderState(
            nestController
        );
        if (!stateOk) {
            return 0;
        }

        (bool clampOk, uint256 clampTarget) = _tryClampTarget(
            stonksAddress,
            lastOrderAddress,
            LDO.balanceOf(address(this))
        );
        if (!clampOk) {
            return 0;
        }

        if (wstEthBalance > clampTarget) {
            unwrappableWstEthAmount = wstEthBalance - clampTarget;
        }
    }

    /**
     * @notice Whether `addLiquidity` would succeed at the current block.
     * @dev    Never reverts. Mirrors every `addLiquidity` precondition.
     */
    function canAddLiquidity() external view returns (bool) {
        if (_liquidityPaused) {
            return false;
        }

        uint256 ldoBalance = LDO.balanceOf(address(this));
        if (ldoBalance == 0) {
            return false;
        }
        uint256 wstEthBalance = WSTETH.balanceOf(address(this));
        if (wstEthBalance == 0) {
            return false;
        }

        (bool priceOk, uint256 ldoUsdPrice, uint256 wstEthUsdPrice) = _tryGetUsdPrices(
            address(LDO),
            address(WSTETH)
        );
        if (!priceOk || ldoUsdPrice == 0 || wstEthUsdPrice == 0) {
            return false;
        }

        uint256 oracleWstEthInLdoPriceScaled = (wstEthUsdPrice * PRICE_SCALE) / ldoUsdPrice;

        if (oracleWstEthInLdoPriceScaled == 0) {
            return false;
        }

        (bool poolOk, uint256 poolEmaPrice) = _tryPriceOracle();
        if (!poolOk) {
            return false;
        }

        uint256 divergenceBps;
        unchecked {
            // Ternary takes the larger operand so the subtraction cannot underflow. The
            // denominator is guarded non-zero above.
            uint256 diff = poolEmaPrice >= oracleWstEthInLdoPriceScaled
                ? poolEmaPrice - oracleWstEthInLdoPriceScaled
                : oracleWstEthInLdoPriceScaled - poolEmaPrice;
            divergenceBps = (diff * MAX_BASIS_POINTS) / oracleWstEthInLdoPriceScaled;
        }
        if (divergenceBps > poolPriceDivergenceToleranceBps) {
            return false;
        }

        (uint256 ldoAmount, uint256 wstEthAmount) = _computeBalancedAmounts(
            ldoBalance,
            wstEthBalance,
            ldoUsdPrice,
            wstEthUsdPrice
        );
        return ldoAmount > 0 && wstEthAmount > 0;
    }

    /**
     * @notice Whether `unwrapExcessWstEth` would succeed at the current block. Keeper polling
     *         predicate.
     * @dev    Never reverts. True when the cooldown has elapsed and the clamp leaves a positive
     *         unwrappable excess.
     */
    function canUnwrapExcessWstEth() external view returns (bool) {
        uint256 wstEthBalance = WSTETH.balanceOf(address(this));
        if (wstEthBalance == 0) {
            return false;
        }

        (
            bool stateOk,
            uint256 lastOrderTimestamp,
            uint256 orderDurationSeconds,
            address lastOrderAddress,
            address stonksAddress
        ) = _tryGetOrderState(nestController);
        if (!stateOk || block.timestamp < lastOrderTimestamp + orderDurationSeconds) {
            return false;
        }

        (bool clampOk, uint256 clampTarget) = _tryClampTarget(
            stonksAddress,
            lastOrderAddress,
            LDO.balanceOf(address(this))
        );
        if (!clampOk) {
            return false;
        }

        return wstEthBalance > clampTarget;
    }

    /*//////////////////////////////////////////////////////////////
                    INTERNAL STATE-CHANGING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Approves the Curve pool, derives the slippage-discounted minimum-mint guard, and
     *         calls `add_liquidity`.
     * @dev    `forceApprove` sets the allowance to the exact deposit amount regardless of any
     *         residual. The pool consumes the full approval inside `add_liquidity`.
     * @param  ldoAmount_ LDO amount to deposit.
     * @param  wstEthAmount_ wstETH amount to deposit.
     * @return lpTokensMinted LP tokens received from the Curve pool.
     */
    function _depositToCurve(
        uint256 ldoAmount_,
        uint256 wstEthAmount_
    ) internal returns (uint256 lpTokensMinted) {
        LDO.forceApprove(address(CURVE_POOL_AND_TOKEN), ldoAmount_);
        IERC20(address(WSTETH)).forceApprove(address(CURVE_POOL_AND_TOKEN), wstEthAmount_);

        uint256[2] memory amounts = [ldoAmount_, wstEthAmount_];
        uint256 expectedLpTokens = CURVE_POOL_AND_TOKEN.calc_token_amount(amounts, true);
        uint256 minMintAmount = (expectedLpTokens * (MAX_BASIS_POINTS - poolSlippageToleranceBps)) /
            MAX_BASIS_POINTS;

        lpTokensMinted = CURVE_POOL_AND_TOKEN.add_liquidity(amounts, minMintAmount);
    }

    /*//////////////////////////////////////////////////////////////
                      INTERNAL READ-ONLY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Revert-safe wrapper around `ORACLE_ROUTER.getUsdPrices`. Returns `ok=false` with
     *      zero prices on revert.
     */
    function _tryGetUsdPrices(
        address base_,
        address quote_
    ) internal view returns (bool ok, uint256 basePrice, uint256 quotePrice) {
        try ORACLE_ROUTER.getUsdPrices(base_, quote_) returns (uint256 b, uint256 q) {
            return (true, b, q);
        } catch {}
    }

    /**
     * @dev Revert-safe wrapper around `CURVE_POOL_AND_TOKEN.price_oracle`. Returns `ok=false`
     *      with zero price on revert.
     */
    function _tryPriceOracle() internal view returns (bool ok, uint256 price) {
        try CURVE_POOL_AND_TOKEN.price_oracle() returns (uint256 p) {
            return (true, p);
        } catch {}
    }

    /**
     * @dev Revert-safe wrapper around `INESTController.getOrderState`. Returns `ok=false` with
     *      zeroed fields on revert.
     */
    function _tryGetOrderState(
        address controller_
    )
        internal
        view
        returns (
            bool ok,
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
     * @dev Revert-safe wrapper around `WSTETH.getWstETHByStETH`. Returns `ok=false` with zero
     *      amount on revert.
     */
    function _tryGetWstETHByStETH(
        uint256 stEthAmount_
    ) internal view returns (bool ok, uint256 wstEthAmount) {
        try WSTETH.getWstETHByStETH(stEthAmount_) returns (uint256 v) {
            return (true, v);
        } catch {}
    }

    /**
     * @notice Non-reverting variant of `_computeClampTarget` for the view path.
     * @dev    Returns `(false, 0)` if `getUsdPrices` or `getWstETHByStETH` reverts, or if
     *         `wstEthUsdPrice` is zero.
     * @param  stonksAddress_     Stonks address. Source of the pipeline stETH bucket.
     * @param  lastOrderAddress_  Currently-tracked Order address. Zero skips the Order bucket.
     * @param  ldoBalance_        Pre-fetched LDO balance of the provisioner.
     */
    function _tryClampTarget(
        address stonksAddress_,
        address lastOrderAddress_,
        uint256 ldoBalance_
    ) internal view returns (bool ok, uint256 clampTarget) {
        uint256 ldoEquivalentWstEth;
        // No LDO means an empty LDO bucket. Skip the oracle round-trip.
        if (ldoBalance_ != 0) {
            (bool priceOk, uint256 ldoUsdPrice, uint256 wstEthUsdPrice) = _tryGetUsdPrices(
                address(LDO),
                address(WSTETH)
            );
            if (!priceOk || wstEthUsdPrice == 0) {
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
            (bool wstEthOk, uint256 value) = _tryGetWstETHByStETH(pipelineStEth);
            if (!wstEthOk) {
                return (false, 0);
            }
            stEthEquivalentWstEth = value;
        }

        clampTarget = ldoEquivalentWstEth + stEthEquivalentWstEth;
        return (true, clampTarget);
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
     * @notice wstETH clamp target. Sum of LDO-equivalent wstETH plus Stonks and Order stETH
     *         converted via the wstETH rate.
     * @dev    Stonks and Order stETH are summed before a single `getWstETHByStETH` call to
     *         avoid duplicate truncation. Reverts propagate. Use `_tryClampTarget` for views.
     * @param  stonksAddress_ Stonks address. Source of the pipeline stETH bucket.
     * @param  lastOrderAddress_ Currently-tracked Order address. Zero skips the Order bucket.
     * @param  ldoBalance_ Pre-fetched LDO balance of the provisioner.
     * @return clampTarget Total wstETH that must stay wrapped to back pending settlements.
     */
    function _computeClampTarget(
        address stonksAddress_,
        address lastOrderAddress_,
        uint256 ldoBalance_
    ) internal view returns (uint256 clampTarget) {
        uint256 ldoEquivalentWstEth;
        // No LDO means an empty LDO bucket. Skip the oracle round-trip.
        if (ldoBalance_ != 0) {
            (uint256 ldoUsdPrice, uint256 wstEthUsdPrice) = ORACLE_ROUTER.getUsdPrices(
                address(LDO),
                address(WSTETH)
            );
            ldoEquivalentWstEth = (ldoBalance_ * ldoUsdPrice) / wstEthUsdPrice;
        }

        uint256 pipelineStEth = STETH.balanceOf(stonksAddress_);
        if (lastOrderAddress_ != address(0)) {
            pipelineStEth += STETH.balanceOf(lastOrderAddress_);
        }

        uint256 stEthEquivalentWstEth = pipelineStEth == 0
            ? 0
            : WSTETH.getWstETHByStETH(pipelineStEth);

        clampTarget = ldoEquivalentWstEth + stEthEquivalentWstEth;
    }

}
