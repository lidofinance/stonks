// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";

import {AssetRecovererACL} from "./AssetRecovererACL.sol";
import {MathHelpers} from "../lib/MathHelpers.sol";
import {IBuybackExecutor} from "../interfaces/IBuybackExecutor.sol";
import {IStETH} from "../interfaces/IStETH.sol";
import {IWstETH} from "../interfaces/IWstETH.sol";
import {IOracleRouter} from "../interfaces/IOracleRouter.sol";
import {ICurvePool} from "../interfaces/ICurvePool.sol";
import {IStonks} from "../interfaces/IStonks.sol";
import {IOwnable} from "../interfaces/IOwnable.sol";
import {IOrder} from "../interfaces/IOrder.sol";

/**
 * @title BuybackExecutor
 * @author swissarmytowel <info@lido.fi>
 * @notice Receives stETH from the BuybackAllocator and LDO from Stonks settlements.
 *         In LP mode deposits balanced LDO/wstETH into the Curve LDO/wstETH pool.
 *         In treasury mode forwards all stETH to Stonks and lets LDO settle to the treasury.
 */
contract BuybackExecutor is IBuybackExecutor, AssetRecovererACL, Pausable {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /// @notice Constructor inputs.
    struct InitParams {
        // Initial admin role holder
        address admin;
        // Destination for recovered assets
        address treasury;
        // The wstETH token, the pool's sell-side asset
        address wstEth;
        // LDO token, the pool's buy-side asset
        address ldo;
        // Prices LDO and stETH in USD
        address oracleRouter;
        // Curve LDO/wstETH pool, also the LP token
        address curvePoolAndToken;
        // Max pool-EMA vs oracle divergence
        uint16 poolPriceDivergenceToleranceBps;
        // Smallest valid stETH order
        uint128 minAllowedOrderAmount;
        // Largest valid stETH order
        uint128 maxAllowedOrderAmount;
        // Smallest valid deposit value per call
        uint128 minDepositValueUsd;
        // Largest valid deposit value per call
        uint128 maxDepositValueUsd;
        // TVL at or above which divergence gate is enforced
        uint128 poolBootstrapMinTvlUsd;
    }

    /// @notice `addLiquidity` precondition result. Only `Eligible` permits the deposit.
    enum AddLiquidityStatus {
        // No LDO to deposit
        ZeroLdoBalance,
        // No stETH to deposit
        ZeroStEthBalance,
        // The oracle returned no price or is unreachable
        OraclePriceUnavailable,
        // The derived LDO/stETH ratio truncates to zero
        InvalidOraclePrice,
        // Pool EMA past tolerance on a deep pool
        PoolPriceDivergenceTooHigh,
        // Balanced value to deposit is below the per-call floor
        DepositValueBelowMinimum,
        // Contract is in the treasury mode, no pool deposits
        NotInLpMode,
        // The deposit can proceed
        Eligible
    }

    /// @notice `_evaluateAddLiquidityGates` output, containing status, capped balanced deposit
    ///         amounts, the deposit USD value, and prices reused by `addLiquidity` for its errors.
    struct AddLiquidityEvaluation {
        // Precondition result
        AddLiquidityStatus status;
        // Capped balanced LDO to deposit
        uint256 ldoAmount;
        // Capped balanced stETH to deposit
        uint256 stEthAmount;
        // Total deposit value in USD
        uint256 depositValueUsd;
        // Pool EMA in LDO/stETH
        uint256 poolEmaLdoPerStEth;
        // Oracle LDO/stETH ratio
        uint256 ldoPerStEth;
        // Pool EMA vs oracle divergence
        uint256 divergenceBps;
    }

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Gates `onStEthAllocated`. Held by the BuybackAllocator.
    bytes32 public constant ALLOCATOR_ROLE = keccak256("NEST.BuybackExecutor.ALLOCATOR_ROLE");

    /// @notice Gates pausing and unpausing this contract and the active Stonks.
    bytes32 public constant EMERGENCY_ROLE = keccak256("NEST.BuybackExecutor.EMERGENCY_ROLE");

    /// @notice 100% in basis points.
    uint256 public constant MAX_BASIS_POINTS = 10000;

    /// @notice Upper bound on `poolPriceDivergenceToleranceBps`.
    uint256 public constant MAX_POOL_DIVERGENCE_TOLERANCE_BPS = 1000;

    /// @notice Upper bound on `poolBootstrapMinTvlUsd` to prevent excessive TVL requirements.
    ///         1,000,000 USD of pool TVL scaled to 1e18.
    uint256 public constant MAX_POOL_BOOTSTRAP_MIN_TVL_USD = 1_000_000 * 1e18;

    /// @notice Minimum residual stETH on a swept order worth recovering.
    uint256 public constant MIN_ORDER_RESIDUAL_TO_RECOVER = 10;

    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice stETH token.
    IStETH public immutable STETH;

    /// @notice wstETH token. Curve pool's sell-side asset.
    IWstETH public immutable WSTETH;

    /// @notice LDO token. Buy-side asset of the Curve pool, settled directly from CoW Swap.
    IERC20 public immutable LDO;

    /// @notice USD oracle for LDO and stETH.
    IOracleRouter public immutable ORACLE_ROUTER;

    /// @notice Price scale of `ORACLE_ROUTER`, read from it at deployment.
    uint256 public immutable PRICE_UNIT;

    /// @notice Curve TwoCrypto LDO/wstETH pool, also the LP token.
    ICurvePool public immutable CURVE_POOL_AND_TOKEN;

    /*//////////////////////////////////////////////////////////////
                        CONFIGURABLE STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Maximum divergence between pool EMA and oracle LDO/stETH price, in basis points.
    uint16 public poolPriceDivergenceToleranceBps;

    /// @notice Operating mode, derived from the active Stonks receiver.
    ///         When true (LP mode), Stonks settles bought LDO to this contract for pool deposits.
    ///         When false (treasury mode), Stonks settles bought LDO to the treasury.
    bool public lpModeEnabled;

    /// @notice Cached `ORDER_DURATION_IN_SECONDS` of the active Stonks. Refreshed by
    ///         `_setStonks` so order placement skips the per-call external read.
    uint32 public stonksOrderDurationSeconds;

    /// @notice Active Stonks instance. Replaced via `setStonks`.
    IStonks public stonks;

    /// @notice Most recent order placed by this contract, or zero when none is tracked.
    address public lastOrderAddress;

    /// @notice `validTo` of `lastOrderAddress`. Only meaningful when `lastOrderAddress != address(0)`.
    uint32 public lastOrderValidTo;

    /// @notice Minimum stETH amount per order.
    uint128 public minAllowedOrderAmount;

    /// @notice Maximum stETH amount per order. `placeOrder` clamps its sell amount to this ceiling.
    uint128 public maxAllowedOrderAmount;

    /// @notice Minimum total USD notional (LDO + wstETH, scaled to 1e18) for an `addLiquidity`
    ///         deposit. Smaller balanced amounts are rejected and carry to the next call.
    uint128 public minDepositValueUsd;

    /// @notice Maximum total USD notional (LDO + wstETH, scaled to 1e18) per `addLiquidity` call.
    ///         Larger balanced amounts scale down to this, adding the balance over successive calls.
    uint128 public maxDepositValueUsd;

    /// @notice Pool TVL (LDO + wstETH valued at the oracle, scaled to 1e18) at or above which the
    ///         divergence gate is enforced. Below it the gate is bypassed so deposits can build a
    ///         shallow pool whose EMA has not yet converged to the oracle.
    uint128 public poolBootstrapMinTvlUsd;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event LiquidityAdded(
        address indexed caller,
        uint256 ldoAmount,
        uint256 wstEthAmount,
        uint256 lpTokensMinted
    );
    event LiquidityRemoved(
        address indexed caller,
        uint256 lpAmount,
        uint256 ldoAmount,
        uint256 stEthAmount
    );
    event PoolPriceDivergenceToleranceBpsSet(
        uint256 previousPoolPriceDivergenceToleranceBps,
        uint256 newPoolPriceDivergenceToleranceBps
    );
    event MinAllowedOrderAmountSet(
        uint256 previousMinAllowedOrderAmount,
        uint256 newMinAllowedOrderAmount
    );
    event MaxAllowedOrderAmountSet(
        uint256 previousMaxAllowedOrderAmount,
        uint256 newMaxAllowedOrderAmount
    );
    event MinDepositValueUsdSet(uint256 previousMinDepositValueUsd, uint256 newMinDepositValueUsd);
    event MaxDepositValueUsdSet(uint256 previousMaxDepositValueUsd, uint256 newMaxDepositValueUsd);
    event PoolBootstrapMinTvlUsdSet(
        uint256 previousPoolBootstrapMinTvlUsd,
        uint256 newPoolBootstrapMinTvlUsd
    );
    event StonksAndOperatingModeSet(
        address indexed previousStonks,
        address indexed newStonks,
        bool previousLpModeEnabled,
        bool newLpModeEnabled
    );
    event OrderPlaced(address indexed order, uint256 sellAmount, uint256 minBuyAmount);
    event AllocationProcessed(address indexed stonks, uint256 freeStEth, uint256 forwardedToStonks);
    event StaleOrderCleared(address indexed order);
    event OrderAbandoned(address indexed order, uint256 validTo);

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroLdoBalance();
    error ZeroStEthBalance();
    error ZeroLpAmount();
    error InsufficientLpTokenBalance(uint256 requested, uint256 available);
    error PoolPriceDivergenceTooHigh(
        uint256 poolPrice,
        uint256 oraclePrice,
        uint256 divergenceBps,
        uint256 toleranceBps
    );
    error NotInLpMode();
    error OraclePriceUnavailable();
    error InvalidOraclePrice();
    error InvalidStEthAddress();
    error InvalidWstEthAddress();
    error InvalidLdoAddress();
    error InvalidOracleRouterAddress();
    error InvalidCurvePoolAndTokenAddress();
    error InvalidPoolPriceDivergenceTolerance(uint256 poolPriceDivergenceToleranceBps);
    error InvalidOrderAmountLimits(uint256 minAllowedOrderAmount, uint256 maxAllowedOrderAmount);
    error InvalidDepositValueLimits(uint256 minDepositValueUsd, uint256 maxDepositValueUsd);
    error InvalidPoolBootstrapMinTvlUsd(uint256 poolBootstrapMinTvlUsd);
    error DepositValueBelowMinimum(uint256 depositValueUsd, uint256 minDepositValueUsd);
    error InvalidCurvePool(address coin0, address coin1);
    error InvalidCurvePoolPriceOracle();
    error LiveOrderInPlace(address order, uint256 validTo);
    error InsufficientStonksBalance(uint256 balance, uint256 minAllowedOrderAmount);
    error InvalidStonksAddress();
    error InvalidStonksReceiver(address stonks, address receiver);
    error InvalidStonksTokenPair(address tokenFrom, address tokenTo);
    error InvalidStonksManager(address manager);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Initializes immutables, tolerances, roles, and operating mode.
     * @dev    Stonks and operating mode should be set as a separate call during governance procedures to avoid circular dependencies.
     * @param  initParams_ See `InitParams`.
     */
    constructor(
        InitParams memory initParams_
    ) AssetRecovererACL(initParams_.admin, initParams_.treasury) {
        if (initParams_.wstEth == address(0)) {
            revert InvalidWstEthAddress();
        }
        if (initParams_.ldo == address(0)) {
            revert InvalidLdoAddress();
        }
        if (initParams_.oracleRouter == address(0)) {
            revert InvalidOracleRouterAddress();
        }
        if (initParams_.curvePoolAndToken == address(0)) {
            revert InvalidCurvePoolAndTokenAddress();
        }

        address coin0 = ICurvePool(initParams_.curvePoolAndToken).coins(0);
        address coin1 = ICurvePool(initParams_.curvePoolAndToken).coins(1);
        if (coin0 != initParams_.ldo || coin1 != initParams_.wstEth) {
            revert InvalidCurvePool(coin0, coin1);
        }

        ICurvePool pool = ICurvePool(initParams_.curvePoolAndToken);

        // Confirm the pool is initialized and exposes the correct `price_oracle` signature.
        // This confirms that the pool used is the intended TwocryptoNG pool, which has the correct price oracle and token order:
        //          https://docs.curve.finance/developer/amm/twocrypto-ng/pools/oracles#price_oracle
        // The TricryptoNG and the StableSwapNG pool have a different signature for their `price_oracle`:
        //          https://docs.curve.finance/developer/amm/tricrypto-ng/pools/oracles#price_oracle
        //          https://docs.curve.finance/developer/amm/stableswap-ng/pools/oracles#price_oracle
        try pool.price_oracle() returns (uint256 poolPrice) {
            // Check if the pool price is non-zero, which indicates that the pool is initialized and has a valid price oracle.
            if (poolPrice == 0) {
                revert InvalidCurvePoolPriceOracle();
            }
        } catch {
            // If the call to `price_oracle` reverts, it indicates that the pool does not have the expected signature, which means it is not the intended TwocryptoNG pool.
            revert InvalidCurvePoolPriceOracle();
        }
        WSTETH = IWstETH(initParams_.wstEth);

        address stEthAddress = WSTETH.stETH();
        if (stEthAddress == address(0)) {
            revert InvalidStEthAddress();
        }

        STETH = IStETH(stEthAddress);
        LDO = IERC20(initParams_.ldo);
        ORACLE_ROUTER = IOracleRouter(initParams_.oracleRouter);
        PRICE_UNIT = IOracleRouter(initParams_.oracleRouter).PRICE_UNIT();
        CURVE_POOL_AND_TOKEN = pool;

        _setPoolPriceDivergenceToleranceBps(initParams_.poolPriceDivergenceToleranceBps);
        // Max first, then min: each setter validates against the other, and storage starts at zero.
        _setMaxAllowedOrderAmount(initParams_.maxAllowedOrderAmount);
        _setMinAllowedOrderAmount(initParams_.minAllowedOrderAmount);
        _setMaxDepositValueUsd(initParams_.maxDepositValueUsd);
        _setMinDepositValueUsd(initParams_.minDepositValueUsd);
        _setPoolBootstrapMinTvlUsd(initParams_.poolBootstrapMinTvlUsd);

        // `wrap` pulls stETH through wstETH, so grant a one-time max approval here.
        IERC20(address(STETH)).forceApprove(address(WSTETH), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                           EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Deposits held LDO and stETH into the Curve pool, balanced to equal USD value.
     *         The stETH portion is wrapped to wstETH before deposit.
     * @dev    Permissionless. `_evaluateAddLiquidityGates` enforces eligibility and the value bounds.
     *         To avoid large deposits, at most `maxDepositValueUsd` can be  deposited in one call
     *         and it reverts below `minDepositValueUsd` to prevent dust deposits.
     *         So a large balance is split and added over several calls.
     *         Asset that holds more USD value keeps its surplus for the deposit on the next call.
     *         Pool to Market price divergence is enforced only when the pool TVL is at or above `poolBootstrapMinTvlUsd`.
     *         This allows a shallow pool to bootstrap its EMA. Otherwise the first deposits into a shallow pool are deadlocked.
     * @return lpTokensMinted LP tokens minted by the pool.
     */
    function addLiquidity() external nonReentrant whenNotPaused returns (uint256 lpTokensMinted) {
        AddLiquidityEvaluation memory evaluation = _evaluateAddLiquidityGates();
        AddLiquidityStatus status = evaluation.status;

        if (status == AddLiquidityStatus.NotInLpMode) {
            revert NotInLpMode();
        }
        if (status == AddLiquidityStatus.ZeroLdoBalance) {
            revert ZeroLdoBalance();
        }
        if (status == AddLiquidityStatus.ZeroStEthBalance) {
            revert ZeroStEthBalance();
        }
        if (status == AddLiquidityStatus.OraclePriceUnavailable) {
            revert OraclePriceUnavailable();
        }
        if (status == AddLiquidityStatus.InvalidOraclePrice) {
            revert InvalidOraclePrice();
        }
        if (status == AddLiquidityStatus.PoolPriceDivergenceTooHigh) {
            revert PoolPriceDivergenceTooHigh(
                evaluation.poolEmaLdoPerStEth,
                evaluation.ldoPerStEth,
                evaluation.divergenceBps,
                poolPriceDivergenceToleranceBps
            );
        }
        if (status == AddLiquidityStatus.DepositValueBelowMinimum) {
            revert DepositValueBelowMinimum(evaluation.depositValueUsd, minDepositValueUsd);
        }

        assert(status == AddLiquidityStatus.Eligible);

        // `wrap` rounds down by up to 1 wei. Use the minted amount for the Curve deposit.
        uint256 actualWstEthMinted = WSTETH.wrap(evaluation.stEthAmount);

        lpTokensMinted = _depositToCurve(evaluation.ldoAmount, actualWstEthMinted);

        emit LiquidityAdded(msg.sender, evaluation.ldoAmount, actualWstEthMinted, lpTokensMinted);
    }

    /**
     * @notice Burns LP tokens, unwraps the wstETH, and sends LDO and stETH to the treasury.
     * @dev    Callable while paused. Balanced removal returns both pool coins in proportion to
     *         reserves. The caller-supplied floors guard against an unfavorable mix when the pool
     *         is imbalanced or sandwiched, set by the committee from the current pool state.
     * @param  lpAmount_ LP tokens to burn. Non-zero and at most the held balance.
     * @param  minLdoAmount_ Minimum LDO to withdraw. The pool reverts below this floor.
     * @param  minWstEthAmount_ Minimum wstETH to withdraw before unwrap. The pool reverts below this floor.
     * @return ldoAmount LDO withdrawn from the pool.
     * @return stEthAmount stETH withdrawn after unwrap.
     */
    function removeLiquidityAndRecoverToTreasury(
        uint256 lpAmount_,
        uint256 minLdoAmount_,
        uint256 minWstEthAmount_
    )
        external
        nonReentrant
        onlyRole(MANAGER_ROLE)
        returns (uint256 ldoAmount, uint256 stEthAmount)
    {
        if (lpAmount_ == 0) {
            revert ZeroLpAmount();
        }

        uint256 lpBalance = getLpTokenBalance();
        if (lpBalance < lpAmount_) {
            revert InsufficientLpTokenBalance(lpAmount_, lpBalance);
        }

        uint256[2] memory withdrawn = CURVE_POOL_AND_TOKEN.remove_liquidity(
            lpAmount_,
            [minLdoAmount_, minWstEthAmount_]
        );

        ldoAmount = withdrawn[0];
        uint256 wstEthReceived = withdrawn[1];

        stEthAmount = WSTETH.unwrap(wstEthReceived);

        emit LiquidityRemoved(msg.sender, lpAmount_, ldoAmount, stEthAmount);

        LDO.safeTransfer(TREASURY, ldoAmount);
        IERC20(address(STETH)).safeTransfer(TREASURY, stEthAmount);
    }

    /**
     * @notice BuybackAllocator hook invoked after a stETH push. Sweeps an expired tracked order,
     *         then forwards free stETH to Stonks, half in LP mode and all in treasury mode.
     * @dev    Does not revert on missing oracle prices or sub-threshold forward amounts.
     */
    function onStEthAllocated() external nonReentrant whenNotPaused onlyRole(ALLOCATOR_ROLE) {
        _sweepExpiredOrder();

        bool lpMode = lpModeEnabled;
        uint256 freeStEth = lpMode ? _computeLpModeFreeStEth() : STETH.balanceOf(address(this));
        uint256 stEthAmountToSell = lpMode ? freeStEth / 2 : freeStEth;

        address stonksAddress = address(stonks);

        if (stEthAmountToSell < minAllowedOrderAmount) {
            emit AllocationProcessed(stonksAddress, freeStEth, 0);

            return;
        }

        emit AllocationProcessed(stonksAddress, freeStEth, stEthAmountToSell);

        IERC20(address(STETH)).safeTransfer(stonksAddress, stEthAmountToSell);
    }

    /**
     * @notice Places an order selling the Stonks stETH balance. `minBuyAmount` is derived from
     *         `Stonks.estimateTradeOutput`, so the caller does not need to compute it off-chain.
     * @dev    Permissionless. Sells up to `maxAllowedOrderAmount` and reverts with
     *         `InsufficientStonksBalance` below `minAllowedOrderAmount`.
     * @return newOrder Address of the new order.
     */
    function placeOrder() external nonReentrant whenNotPaused returns (address newOrder) {
        _sweepExpiredOrder();

        // A pointer surviving the sweep is a live order. Revert to avoid placing overlapping orders
        address trackedOrderAddress = lastOrderAddress;
        if (trackedOrderAddress != address(0)) {
            revert LiveOrderInPlace(trackedOrderAddress, lastOrderValidTo);
        }

        IStonks currentStonks = stonks;
        uint256 stonksBalance = STETH.balanceOf(address(currentStonks));
        uint256 sellAmount = Math.min(stonksBalance, maxAllowedOrderAmount);

        if (sellAmount < minAllowedOrderAmount) {
            revert InsufficientStonksBalance(stonksBalance, minAllowedOrderAmount);
        }

        // estimateTradeOutput applies the Stonks margin to the oracle estimate, so minBuyAmount
        // already accounts for slippage and CoW fees.
        uint256 minBuyAmount = currentStonks.estimateTradeOutput(sellAmount);

        newOrder = currentStonks.placeOrderWithAmount(sellAmount, minBuyAmount);
        _setLastOrderTrackingData(newOrder, block.timestamp + stonksOrderDurationSeconds);

        emit OrderPlaced(newOrder, sellAmount, minBuyAmount);
    }

    /**
     * @notice Sets the active Stonks and derives the operating mode from its receiver.
     * @param  stonks_ New Stonks address. LP mode when its receiver is this contract, treasury
     *         mode when it is `TREASURY`.
     */
    function setStonks(address stonks_) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
        _setStonks(stonks_);
    }

    /**
     * @notice Pauses `addLiquidity`, `onStEthAllocated` and order placement. Reverts if already paused.
     */
    function pause() external onlyRole(EMERGENCY_ROLE) {
        _pause();
    }

    /**
     * @notice Unpauses `addLiquidity`, `onStEthAllocated`, and order placement. Reverts if not paused.
     */
    function unpause() external onlyRole(EMERGENCY_ROLE) {
        _unpause();
    }

    /**
     * @notice Forwards `pauseCreation` to the active Stonks.
     * @dev    Requires this contract to be the active Stonks `manager` or `emergencyOperator`.
     */
    function pauseStonksCreation() external onlyRole(EMERGENCY_ROLE) {
        stonks.pauseCreation();
    }

    /**
     * @notice Forwards `unpauseCreation` to the active Stonks.
     * @dev    Requires this contract to be the active Stonks `manager` or `emergencyOperator`.
     */
    function unpauseStonksCreation() external onlyRole(EMERGENCY_ROLE) {
        stonks.unpauseCreation();
    }

    /**
     * @notice Forwards `pauseSignatures` to the active Stonks.
     * @dev    Requires this contract to be the active Stonks `manager` or `emergencyOperator`.
     */
    function pauseStonksSignatures() external onlyRole(EMERGENCY_ROLE) {
        stonks.pauseSignatures();
    }

    /**
     * @notice Forwards `unpauseSignatures` to the active Stonks.
     * @dev    Requires this contract to be the active Stonks `manager` or `emergencyOperator`.
     */
    function unpauseStonksSignatures() external onlyRole(EMERGENCY_ROLE) {
        stonks.unpauseSignatures();
    }

    /**
     * @notice Updates the maximum allowed pool-EMA vs oracle divergence.
     * @param  poolPriceDivergenceToleranceBps_ New tolerance in basis points.
     *         In `(0, MAX_POOL_DIVERGENCE_TOLERANCE_BPS]`.
     */
    function setPoolPriceDivergenceToleranceBps(
        uint256 poolPriceDivergenceToleranceBps_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setPoolPriceDivergenceToleranceBps(poolPriceDivergenceToleranceBps_);
    }

    /**
     * @notice Updates the minimum stETH order size.
     * @param  minAllowedOrderAmount_ New minimum. Must be non-zero and strictly below `maxAllowedOrderAmount`.
     */
    function setMinAllowedOrderAmount(
        uint128 minAllowedOrderAmount_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setMinAllowedOrderAmount(minAllowedOrderAmount_);
    }

    /**
     * @notice Updates the maximum stETH order size.
     * @param  maxAllowedOrderAmount_ New maximum. Must be strictly above `minAllowedOrderAmount`.
     */
    function setMaxAllowedOrderAmount(
        uint128 maxAllowedOrderAmount_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setMaxAllowedOrderAmount(maxAllowedOrderAmount_);
    }

    /**
     * @notice Updates the minimum deposit value.
     * @param  minDepositValueUsd_ New floor in total USD notional scaled to 1e18. Must be non-zero
     *         and strictly below `maxDepositValueUsd`.
     */
    function setMinDepositValueUsd(
        uint128 minDepositValueUsd_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setMinDepositValueUsd(minDepositValueUsd_);
    }

    /**
     * @notice Updates the maximum deposit value.
     * @param  maxDepositValueUsd_ New cap in total USD notional scaled to 1e18. Must be strictly
     *         above `minDepositValueUsd`.
     */
    function setMaxDepositValueUsd(
        uint128 maxDepositValueUsd_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setMaxDepositValueUsd(maxDepositValueUsd_);
    }

    /**
     * @notice Updates the pool TVL target at or above which the divergence gate is enforced.
     * @param  poolBootstrapMinTvlUsd_ New minimum pool TVL (bootstrap threshold) in USD scaled to 1e18
     *         In `(0, MAX_POOL_BOOTSTRAP_MIN_TVL_USD]`.
     */
    function setPoolBootstrapMinTvlUsd(
        uint128 poolBootstrapMinTvlUsd_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setPoolBootstrapMinTvlUsd(poolBootstrapMinTvlUsd_);
    }

    /*//////////////////////////////////////////////////////////////
                        EXTERNAL VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Total uncapped balanced LDO and stETH available to deposit at current oracle prices.
     *         A single `addLiquidity` call deposits at most `maxDepositValueUsd` of this and nothing
     *         below `minDepositValueUsd`, so the full amount is added over successive calls. Gate on
     *         `canAddLiquidity` for eligibility.
     * @dev    Returns `(0, 0)` on zero balances or when the oracle is unavailable.
     * @return ldoAmount Balanced LDO amount available to deposit.
     * @return stEthAmount Balanced stETH amount available to deposit.
     */
    function getAvailableLiquidity()
        external
        view
        returns (uint256 ldoAmount, uint256 stEthAmount)
    {
        uint256 ldoBalance = LDO.balanceOf(address(this));
        if (ldoBalance == 0) {
            return (0, 0);
        }

        uint256 stEthBalance = STETH.balanceOf(address(this));
        if (stEthBalance == 0) {
            return (0, 0);
        }

        (bool pricesValid, uint256 ldoUsdPrice, uint256 stEthUsdPrice) = _tryGetLdoStEthUsdPrices();
        if (!pricesValid) {
            return (0, 0);
        }

        (ldoAmount, stEthAmount, ) = _computeBalancedAmounts(
            ldoBalance,
            stEthBalance,
            ldoUsdPrice,
            stEthUsdPrice
        );
    }

    /**
     * @notice True when `addLiquidity` succeeds at the current block.
     */
    function canAddLiquidity() external view returns (bool) {
        return !paused() && _evaluateAddLiquidityGates().status == AddLiquidityStatus.Eligible;
    }

    /**
     * @notice Placement preconditions and next sell sizing for keepers.
     * @dev    `estimatedBuyAmount` falls back to zero on oracle revert. An expired tracked order is
     *         reported as `activeOrder == address(0)`, with its recoverable residual folded into `sellAmount`.
     * @return status Placement preconditions and the next sell sizing.
     */
    function getPlacementStatus() external view returns (PlacementStatus memory status) {
        IStonks currentStonks = stonks;

        status.isStonksCreationPaused = currentStonks.isCreationPaused();
        status.isStonksKilled = currentStonks.isKilled();

        address trackedOrderAddress = lastOrderAddress;
        uint256 recoverableResidual;

        if (trackedOrderAddress != address(0)) {
            if (block.timestamp <= lastOrderValidTo) {
                status.activeOrder = trackedOrderAddress;
                status.activeOrderValidTo = lastOrderValidTo;
            } else {
                // placeOrder sweeps an expired order's residual stETH back to Stonks before sizing,
                // so include it in the balance the next sale draws from.
                uint256 residual = STETH.balanceOf(trackedOrderAddress);
                if (residual >= MIN_ORDER_RESIDUAL_TO_RECOVER) {
                    recoverableResidual = residual;
                }
            }
        }

        uint256 stonksBalance = STETH.balanceOf(address(currentStonks)) + recoverableResidual;

        status.sellAmount = Math.min(stonksBalance, maxAllowedOrderAmount);
        if (status.sellAmount >= minAllowedOrderAmount) {
            try currentStonks.estimateTradeOutput(status.sellAmount) returns (uint256 estimate) {
                status.estimatedBuyAmount = estimate;
            } catch {}
        }

        // A non-zero estimate implies the minimum was met, since the estimate only runs above it.
        status.canPlace =
            status.estimatedBuyAmount > 0 &&
            !paused() &&
            !status.isStonksCreationPaused &&
            !status.isStonksKilled &&
            status.activeOrder == address(0);
    }

    /**
     * @notice Current Curve LP-token balance.
     * @return balance LP tokens held by this contract.
     */
    function getLpTokenBalance() public view returns (uint256 balance) {
        balance = IERC20(address(CURVE_POOL_AND_TOKEN)).balanceOf(address(this));
    }

    /*//////////////////////////////////////////////////////////////
                           INTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Internal divergence tolerance setter shared by the constructor and external setter.
     * @param  poolPriceDivergenceToleranceBps_ New tolerance in basis points.
     *         In `(0, MAX_POOL_DIVERGENCE_TOLERANCE_BPS]`.
     */
    function _setPoolPriceDivergenceToleranceBps(
        uint256 poolPriceDivergenceToleranceBps_
    ) internal {
        if (
            poolPriceDivergenceToleranceBps_ == 0 ||
            poolPriceDivergenceToleranceBps_ > MAX_POOL_DIVERGENCE_TOLERANCE_BPS
        ) {
            revert InvalidPoolPriceDivergenceTolerance(poolPriceDivergenceToleranceBps_);
        }

        uint256 previousPoolPriceDivergenceToleranceBps = poolPriceDivergenceToleranceBps;
        poolPriceDivergenceToleranceBps = poolPriceDivergenceToleranceBps_.toUint16();

        emit PoolPriceDivergenceToleranceBpsSet(
            previousPoolPriceDivergenceToleranceBps,
            poolPriceDivergenceToleranceBps_
        );
    }

    /**
     * @notice Validates and sets the minimum order size against the current maximum.
     * @param  minAllowedOrderAmount_ New minimum. Non-zero and strictly below `maxAllowedOrderAmount`.
     */
    function _setMinAllowedOrderAmount(uint128 minAllowedOrderAmount_) internal {
        if (minAllowedOrderAmount_ == 0 || minAllowedOrderAmount_ >= maxAllowedOrderAmount) {
            revert InvalidOrderAmountLimits(minAllowedOrderAmount_, maxAllowedOrderAmount);
        }

        uint128 previousMinAllowedOrderAmount = minAllowedOrderAmount;
        minAllowedOrderAmount = minAllowedOrderAmount_;

        emit MinAllowedOrderAmountSet(previousMinAllowedOrderAmount, minAllowedOrderAmount_);
    }

    /**
     * @notice Validates and sets the maximum order size against the current minimum.
     * @param  maxAllowedOrderAmount_ New maximum. Strictly above `minAllowedOrderAmount`.
     */
    function _setMaxAllowedOrderAmount(uint128 maxAllowedOrderAmount_) internal {
        if (maxAllowedOrderAmount_ == 0 || maxAllowedOrderAmount_ <= minAllowedOrderAmount) {
            revert InvalidOrderAmountLimits(minAllowedOrderAmount, maxAllowedOrderAmount_);
        }

        uint128 previousMaxAllowedOrderAmount = maxAllowedOrderAmount;
        maxAllowedOrderAmount = maxAllowedOrderAmount_;

        emit MaxAllowedOrderAmountSet(previousMaxAllowedOrderAmount, maxAllowedOrderAmount_);
    }

    /**
     * @notice Validates and sets the minimum deposit value against the current maximum.
     * @param  minDepositValueUsd_ New floor in total USD notional scaled to 1e18. Non-zero and
     *         strictly below `maxDepositValueUsd`.
     */
    function _setMinDepositValueUsd(uint128 minDepositValueUsd_) internal {
        if (minDepositValueUsd_ == 0 || minDepositValueUsd_ >= maxDepositValueUsd) {
            revert InvalidDepositValueLimits(minDepositValueUsd_, maxDepositValueUsd);
        }

        uint128 previousMinDepositValueUsd = minDepositValueUsd;
        minDepositValueUsd = minDepositValueUsd_;

        emit MinDepositValueUsdSet(previousMinDepositValueUsd, minDepositValueUsd_);
    }

    /**
     * @notice Validates and sets the maximum deposit value against the current minimum.
     * @param  maxDepositValueUsd_ New cap in total USD notional scaled to 1e18. Strictly above
     *         `minDepositValueUsd`.
     */
    function _setMaxDepositValueUsd(uint128 maxDepositValueUsd_) internal {
        if (maxDepositValueUsd_ == 0 || maxDepositValueUsd_ <= minDepositValueUsd) {
            revert InvalidDepositValueLimits(minDepositValueUsd, maxDepositValueUsd_);
        }

        uint128 previousMaxDepositValueUsd = maxDepositValueUsd;
        maxDepositValueUsd = maxDepositValueUsd_;

        emit MaxDepositValueUsdSet(previousMaxDepositValueUsd, maxDepositValueUsd_);
    }

    /**
     * @notice Validates and sets the pool TVL bootstrap target.
     * @param  poolBootstrapMinTvlUsd_ New target in total USD notional scaled to 1e18.
     *         In `(0, MAX_POOL_BOOTSTRAP_MIN_TVL_USD]`.
     */
    function _setPoolBootstrapMinTvlUsd(uint128 poolBootstrapMinTvlUsd_) internal {
        if (
            poolBootstrapMinTvlUsd_ == 0 || poolBootstrapMinTvlUsd_ > MAX_POOL_BOOTSTRAP_MIN_TVL_USD
        ) {
            revert InvalidPoolBootstrapMinTvlUsd(poolBootstrapMinTvlUsd_);
        }

        uint128 previousPoolBootstrapMinTvlUsd = poolBootstrapMinTvlUsd;
        poolBootstrapMinTvlUsd = poolBootstrapMinTvlUsd_;

        emit PoolBootstrapMinTvlUsdSet(previousPoolBootstrapMinTvlUsd, poolBootstrapMinTvlUsd_);
    }

    /**
     * @notice Internal mode swap shared by the constructor and the external setter. Derives the
     *         operating mode from the new Stonks's receiver.
     * @dev    The new Stonks must sell stETH for LDO with this contract as its manager. Switching
     *         disconnects this contract from the previous Stonks. An expired tracked order is swept
     *         and its residual recovered to the previous Stonks. A live order survives the sweep and
     *         is abandoned, recorded by `OrderAbandoned`; anyone can call its `recoverTokenFrom`
     *         after expiry to return the stETH to the previous Stonks. In LP mode an abandoned order
     *         no longer reserves stETH against new allocations, so pause allocations and recover it
     *         before switching.
     * @param  stonks_ New Stonks address. LP mode when its receiver is this contract, treasury
     *         mode when it is `TREASURY`. Any other receiver reverts.
     */
    function _setStonks(address stonks_) internal {
        if (stonks_ == address(0)) {
            revert InvalidStonksAddress();
        }
        if (stonks_ == address(stonks)) {
            return;
        }

        address receiver = IStonks(stonks_).RECEIVER();

        bool lpModeEnabled_;
        if (receiver == address(this)) {
            lpModeEnabled_ = true;
        } else if (receiver != TREASURY) {
            revert InvalidStonksReceiver(stonks_, receiver);
        }

        (address tokenFrom, address tokenTo, ) = IStonks(stonks_).getOrderParameters();
        if (tokenFrom != address(STETH) || tokenTo != address(LDO)) {
            revert InvalidStonksTokenPair(tokenFrom, tokenTo);
        }

        address stonksManager = IOwnable(stonks_).manager();
        if (stonksManager != address(this)) {
            revert InvalidStonksManager(stonksManager);
        }

        bool previousLpModeEnabled = lpModeEnabled;
        address previousStonks = address(stonks);

        lpModeEnabled = lpModeEnabled_;
        stonks = IStonks(stonks_);
        stonksOrderDurationSeconds = IStonks(stonks_).ORDER_DURATION_IN_SECONDS().toUint32();

        // Sweep recovers an expired order's residual stETH. A live order survives the sweep and is
        // abandoned here, recorded by OrderAbandoned so it stays discoverable for later recovery.
        _sweepExpiredOrder();

        if (lastOrderAddress != address(0)) {
            emit OrderAbandoned(lastOrderAddress, lastOrderValidTo);
        }

        _setLastOrderTrackingData(address(0), 0);

        emit StonksAndOperatingModeSet(
            previousStonks,
            stonks_,
            previousLpModeEnabled,
            lpModeEnabled_
        );
    }

    /**
     * @notice Clears `lastOrderAddress` if expired and recovers any residual stETH on the order.
     */
    function _sweepExpiredOrder() internal {
        address trackedOrderAddress = lastOrderAddress;

        if (trackedOrderAddress == address(0)) {
            return;
        }
        if (block.timestamp <= lastOrderValidTo) {
            return;
        }

        _setLastOrderTrackingData(address(0), 0);

        emit StaleOrderCleared(trackedOrderAddress);

        if (STETH.balanceOf(trackedOrderAddress) >= MIN_ORDER_RESIDUAL_TO_RECOVER) {
            // Recover the residual stETH from the expired order.
            IOrder(trackedOrderAddress).recoverTokenFrom();
        }
    }

    /**
     * @notice Writes the tracked order pointer and its `validTo`.
     * @param  newOrder_ Order address, or zero to clear the pointer.
     * @param  validTo_ Order expiry timestamp.
     */
    function _setLastOrderTrackingData(address newOrder_, uint256 validTo_) internal {
        lastOrderAddress = newOrder_;
        lastOrderValidTo = validTo_.toUint32();
    }

    /**
     * @notice Approves the Curve pool for the exact deposit amounts and calls `add_liquidity`.
     * @param  ldoAmount_ LDO amount to deposit.
     * @param  wstEthAmount_ wstETH amount to deposit.
     * @return lpTokensMinted LP tokens received.
     */
    function _depositToCurve(
        uint256 ldoAmount_,
        uint256 wstEthAmount_
    ) internal returns (uint256 lpTokensMinted) {
        LDO.forceApprove(address(CURVE_POOL_AND_TOKEN), ldoAmount_);
        IERC20(address(WSTETH)).forceApprove(address(CURVE_POOL_AND_TOKEN), wstEthAmount_);

        uint256[2] memory amounts = [ldoAmount_, wstEthAmount_];

        // min_mint_amount is set to 1 for gas savings.
        // An estimate for the floor would be derived from the pool state in this same transaction,
        // therefore it will always use the state the deposit mints against.
        // So it will always pass internally regardless of the estimation and setting it to the
        // trivial value of 1 is cheaper and has the same effect.
        lpTokensMinted = CURVE_POOL_AND_TOKEN.add_liquidity(amounts, 1);
    }

    /*//////////////////////////////////////////////////////////////
                         INTERNAL VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Revert-safe LDO and stETH USD prices. Returns `pricesValid = false` on revert or a
     *         zero price.
     */
    function _tryGetLdoStEthUsdPrices()
        internal
        view
        returns (bool pricesValid, uint256 ldoUsdPrice, uint256 stEthUsdPrice)
    {
        try ORACLE_ROUTER.getUsdPrices(address(LDO), address(STETH)) returns (
            uint256 ldoPrice,
            uint256 stEthPrice
        ) {
            if (ldoPrice != 0 && stEthPrice != 0) {
                return (true, ldoPrice, stEthPrice);
            }
        } catch {}
    }

    /**
     * @notice LP-mode-only stETH available for forwarding to Stonks. Subtracts the stETH value of
     *         held LDO, the stETH on Stonks, and the residual on the tracked order. Held LDO is
     *         reserved to pair with the next Curve deposit. Returns 0 on missing oracle prices.
     * @dev    Caller must gate on `lpModeEnabled`. In treasury mode LDO settles to `TREASURY`, so
     *         there is nothing to reserve against and the caller uses the raw stETH balance.
     */
    function _computeLpModeFreeStEth() internal view returns (uint256) {
        uint256 ldoInStEth;
        uint256 ldoBalance = LDO.balanceOf(address(this));

        if (ldoBalance > 0) {
            (
                bool pricesValid,
                uint256 ldoUsdPrice,
                uint256 stEthUsdPrice
            ) = _tryGetLdoStEthUsdPrices();

            if (!pricesValid) {
                return 0;
            }

            ldoInStEth = Math.mulDiv(ldoBalance, ldoUsdPrice, stEthUsdPrice);
        }

        uint256 orderBalance = lastOrderAddress == address(0)
            ? 0
            : STETH.balanceOf(lastOrderAddress);
        uint256 freeAfterLdo = MathHelpers.saturatingSub(
            STETH.balanceOf(address(this)),
            ldoInStEth
        );
        uint256 freeAfterStonks = MathHelpers.saturatingSub(
            freeAfterLdo,
            STETH.balanceOf(address(stonks))
        );

        return MathHelpers.saturatingSub(freeAfterStonks, orderBalance);
    }

    /**
     * @notice Oracle-price and pool-EMA divergence gate for the `addLiquidity` path. Converts the
     *         pool EMA from LDO/wstETH to LDO/stETH via the wstETH share rate and compares it
     *         against the oracle ratio.
     * @dev    Does not revert. Returns respective status on error:
     *         `OraclePriceUnavailable` on a missing price, `InvalidOraclePrice` when the
     *         derived LDO/stETH ratio truncates to zero, `PoolPriceDivergenceTooHigh` past
     *         tolerance when the pool TVL is at or above `poolBootstrapMinTvlUsd`, otherwise
     *         `Eligible`. Below that TVL divergence is bypassed. Prices are scaled by `PRICE_UNIT`
     *         and zero when unavailable.
     * @return status Divergence status the caller maps to an evaluation status.
     * @return ldoUsdPrice LDO/USD price.
     * @return stEthUsdPrice stETH/USD price.
     * @return oracleLdoPerStEth Oracle LDO/stETH ratio.
     * @return poolEmaLdoPerStEth Pool EMA in LDO/stETH.
     * @return divergenceBps Divergence between the pool EMA and the oracle ratio in basis points.
     */
    function _evaluatePoolPriceDivergence()
        internal
        view
        returns (
            AddLiquidityStatus status,
            uint256 ldoUsdPrice,
            uint256 stEthUsdPrice,
            uint256 oracleLdoPerStEth,
            uint256 poolEmaLdoPerStEth,
            uint256 divergenceBps
        )
    {
        bool pricesValid;
        (pricesValid, ldoUsdPrice, stEthUsdPrice) = _tryGetLdoStEthUsdPrices();

        if (!pricesValid) {
            return (AddLiquidityStatus.OraclePriceUnavailable, 0, 0, 0, 0, 0);
        }

        // LDO per stETH price from the OracleRouter
        oracleLdoPerStEth = Math.mulDiv(stEthUsdPrice, PRICE_UNIT, ldoUsdPrice);
        // A truncated ratio is unusable for the divergence division below
        if (oracleLdoPerStEth == 0) {
            return (AddLiquidityStatus.InvalidOraclePrice, ldoUsdPrice, stEthUsdPrice, 0, 0, 0);
        }

        /*
         * Curve price_oracle returns coin[1] priced in coin[0]. That is how many LDO one wstETH
         * is worth, so the units are LDO per wstETH. Divide by the wstETH share rate to get
         * LDO per stETH.
         *
         *     LDO       stETH       LDO
         *   ------  /  ------  =  -----
         *   wstETH     wstETH     stETH
         */
        poolEmaLdoPerStEth = Math.mulDiv(
            CURVE_POOL_AND_TOKEN.price_oracle(),
            PRICE_UNIT,
            WSTETH.stEthPerToken()
        );

        // Absolute divergence of the pool EMA from the oracle ratio, in basis points, rounded up.
        // A zero pool EMA scores as max divergence against the non-zero oracle ratio.
        uint256 diff = poolEmaLdoPerStEth >= oracleLdoPerStEth
            ? poolEmaLdoPerStEth - oracleLdoPerStEth
            : oracleLdoPerStEth - poolEmaLdoPerStEth;

        divergenceBps = Math.mulDiv(diff, MAX_BASIS_POINTS, oracleLdoPerStEth, Math.Rounding.Up);

        // The gate blocks only a deep pool past tolerance. Within tolerance the deposit is eligible
        // at any depth, and short-circuiting skips the pool TVL reads. A shallow pool bypasses the
        // gate, since a stale EMA cannot converge without the deposits it would otherwise block.
        status = divergenceBps > poolPriceDivergenceToleranceBps &&
            _poolTvlUsd(ldoUsdPrice, stEthUsdPrice) >= poolBootstrapMinTvlUsd
            ? AddLiquidityStatus.PoolPriceDivergenceTooHigh
            : AddLiquidityStatus.Eligible;
    }

    /**
     * @notice Runs every `addLiquidity` precondition and computes the balanced pair bounded by the
     *         `minDepositValueUsd` floor and the `maxDepositValueUsd` cap.
     * @dev    Does not revert on missing oracle prices. Pool reverts bubble up.
     * @return evaluation Status, bounded balanced deposit amounts, prices, and divergence values.
     */
    function _evaluateAddLiquidityGates()
        internal
        view
        returns (AddLiquidityEvaluation memory evaluation)
    {
        if (!lpModeEnabled) {
            evaluation.status = AddLiquidityStatus.NotInLpMode;
            return evaluation;
        }

        uint256 ldoBalance = LDO.balanceOf(address(this));
        if (ldoBalance == 0) {
            evaluation.status = AddLiquidityStatus.ZeroLdoBalance;
            return evaluation;
        }

        uint256 stEthBalance = STETH.balanceOf(address(this));
        if (stEthBalance == 0) {
            evaluation.status = AddLiquidityStatus.ZeroStEthBalance;
            return evaluation;
        }

        (
            AddLiquidityStatus priceStatus,
            uint256 ldoUsdPrice,
            uint256 stEthUsdPrice,
            uint256 ldoPerStEth,
            uint256 poolEmaLdoPerStEth,
            uint256 divergenceBps
        ) = _evaluatePoolPriceDivergence();

        evaluation.ldoPerStEth = ldoPerStEth;
        evaluation.poolEmaLdoPerStEth = poolEmaLdoPerStEth;
        evaluation.divergenceBps = divergenceBps;

        if (priceStatus != AddLiquidityStatus.Eligible) {
            evaluation.status = priceStatus;
            return evaluation;
        }

        (uint256 ldoAmount, uint256 stEthAmount, uint256 depositValueUsd) = _computeBalancedAmounts(
            ldoBalance,
            stEthBalance,
            ldoUsdPrice,
            stEthUsdPrice
        );
        evaluation.depositValueUsd = depositValueUsd;

        if (depositValueUsd < minDepositValueUsd) {
            evaluation.status = AddLiquidityStatus.DepositValueBelowMinimum;
            return evaluation;
        }

        // Scale both sides by the same factor to respect the per-call cap, preserving the balance.
        uint256 cap = maxDepositValueUsd;
        if (depositValueUsd > cap) {
            ldoAmount = Math.mulDiv(ldoAmount, cap, depositValueUsd);
            stEthAmount = Math.mulDiv(stEthAmount, cap, depositValueUsd);
        }

        evaluation.ldoAmount = ldoAmount;
        evaluation.stEthAmount = stEthAmount;
        evaluation.status = AddLiquidityStatus.Eligible;
    }

    /**
     * @notice Balanced LDO/stETH deposit pair sized by the smaller-USD side.
     * @param  ldoBalance_ Current LDO balance.
     * @param  stEthBalance_ Current stETH balance.
     * @param  ldoUsdPrice_ LDO/USD price scaled by `PRICE_UNIT`.
     * @param  stEthUsdPrice_ stETH/USD price scaled by `PRICE_UNIT`.
     * @return ldoAmount Balanced LDO amount.
     * @return stEthAmount Balanced stETH amount.
     * @return depositValueUsd Total notional of the balanced pair, twice the smaller-USD side.
     */
    function _computeBalancedAmounts(
        uint256 ldoBalance_,
        uint256 stEthBalance_,
        uint256 ldoUsdPrice_,
        uint256 stEthUsdPrice_
    ) internal view returns (uint256 ldoAmount, uint256 stEthAmount, uint256 depositValueUsd) {
        uint256 ldoUsdValue = Math.mulDiv(ldoBalance_, ldoUsdPrice_, PRICE_UNIT);
        uint256 stEthUsdValue = Math.mulDiv(stEthBalance_, stEthUsdPrice_, PRICE_UNIT);

        // Size by the smaller-USD side. The larger side's surplus carries over to the next cycle.
        if (ldoUsdValue <= stEthUsdValue) {
            ldoAmount = ldoBalance_;
            stEthAmount = Math.mulDiv(ldoBalance_, ldoUsdPrice_, stEthUsdPrice_);
            depositValueUsd = ldoUsdValue * 2;
        } else {
            stEthAmount = stEthBalance_;
            ldoAmount = Math.mulDiv(stEthBalance_, stEthUsdPrice_, ldoUsdPrice_);
            depositValueUsd = stEthUsdValue * 2;
        }
    }

    /**
     * @notice Pool TVL valued at the oracle, scaled to 1e18. Reads the pool's internal `balances`, so
     *         token donations to the pool do not inflate it.
     * @param  ldoUsdPrice_ LDO/USD price scaled by `PRICE_UNIT`.
     * @param  stEthUsdPrice_ stETH/USD price scaled by `PRICE_UNIT`.
     * @return poolTvlUsd Total pool value in USD scaled to 1e18.
     */
    function _poolTvlUsd(
        uint256 ldoUsdPrice_,
        uint256 stEthUsdPrice_
    ) internal view returns (uint256 poolTvlUsd) {
        uint256 ldoReserve = CURVE_POOL_AND_TOKEN.balances(0);
        uint256 stEthReserve = WSTETH.getStETHByWstETH(CURVE_POOL_AND_TOKEN.balances(1));

        uint256 ldoUsdValue = Math.mulDiv(ldoReserve, ldoUsdPrice_, PRICE_UNIT);
        uint256 stEthUsdValue = Math.mulDiv(stEthReserve, stEthUsdPrice_, PRICE_UNIT);

        poolTvlUsd = ldoUsdValue + stEthUsdValue;
    }
}
