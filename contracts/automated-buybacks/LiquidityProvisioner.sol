// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";

import {AssetRecovererACL} from "./AssetRecovererACL.sol";
import {MathHelpers} from "../lib/MathHelpers.sol";
import {IStETH} from "../interfaces/IStETH.sol";
import {IWstETH} from "../interfaces/IWstETH.sol";
import {IOracleRouter} from "../interfaces/IOracleRouter.sol";
import {ICurvePool} from "../interfaces/ICurvePool.sol";
import {IStonks} from "../interfaces/IStonks.sol";
import {IOrder} from "../interfaces/IOrder.sol";

/**
 * @title LiquidityProvisioner
 * @author swissarmytowel <info@lido.fi>
 * @notice Receives stETH from the NESTController and LDO from Stonks settlements.
 *         In LP mode deposits balanced LDO/wstETH into the Curve LDO/wstETH pool.
 *         In treasury mode forwards all stETH to Stonks and lets LDO settle to the treasury.
 */
contract LiquidityProvisioner is AssetRecovererACL, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /// @notice Constructor inputs.
    struct InitParams {
        address admin;
        address treasury;
        address stEth;
        address wstEth;
        address ldo;
        address oracleRouter;
        address curvePoolAndToken;
        uint16 poolSlippageToleranceBps;
        uint16 poolPriceDivergenceToleranceBps;
        bool lpModeEnabled;
        address stonks;
    }

    /// @notice `addLiquidity` precondition result. Only `Eligible` permits the deposit.
    enum AddLiquidityStatus {
        ZeroLdoBalance,
        ZeroStEthBalance,
        OraclePriceUnavailable,
        PoolPriceDivergenceTooHigh,
        ZeroBalancedDepositAmount,
        Eligible
    }

    /// @notice `_evaluateAddLiquidityGates` output: status, balanced deposit amounts, and
    ///         prices reused by `addLiquidity` for the divergence error.
    struct AddLiquidityEvaluation {
        AddLiquidityStatus status;
        uint256 ldoAmount;
        uint256 wstEthAmount;
        uint256 poolEmaPrice;
        uint256 oraclePriceInLdo;
        uint256 divergenceBps;
    }

    /// @notice `getPlacementStatus` return: placement preconditions and the next sell sizing.
    struct PlacementStatus {
        bool canPlace;
        uint256 sellAmount;
        uint256 estimatedBuyAmount;
        address activeOrder;
        uint256 activeOrderValidTo;
        bool isStonksCreationPaused;
        bool isStonksKilled;
    }

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Gates `onStEthAllocated`. Held by the NESTController.
    bytes32 public constant ALLOCATOR_ROLE = keccak256("NEST.ALLOCATOR_ROLE");

    /// @notice 100% in basis points.
    uint256 public constant MAX_BASIS_POINTS = 10000;

    /// @notice Upper bound on `poolSlippageToleranceBps`.
    uint256 public constant MAX_POOL_SLIPPAGE_TOLERANCE_BPS = 1000;

    /// @notice Upper bound on `poolPriceDivergenceToleranceBps`.
    uint256 public constant MAX_POOL_DIVERGENCE_TOLERANCE_BPS = 1000;

    /// @notice USD price scale used by `ORACLE_ROUTER`.
    uint256 internal constant PRICE_SCALE = 1e18;

    /// @notice Minimum stETH amount considered non-dust by placement and recovery.
    uint256 internal constant MIN_POSSIBLE_ORDER_BALANCE = 10;

    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice stETH token.
    IStETH public immutable STETH;

    /// @notice wstETH token. Curve pool's sell-side asset.
    IWstETH public immutable WSTETH;

    /// @notice LDO token. Buy-side asset of the Curve pool, settled directly from CoW Swap.
    IERC20 public immutable LDO;

    /// @notice USD oracle for LDO, wstETH, and stETH.
    IOracleRouter public immutable ORACLE_ROUTER;

    /// @notice Curve TwoCrypto LDO/wstETH pool, also the LP token. Coin order: `[LDO, wstETH]`.
    ICurvePool public immutable CURVE_POOL_AND_TOKEN;

    /*//////////////////////////////////////////////////////////////
                        CONFIGURABLE STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Curve deposit and withdrawal slippage tolerance, in basis points.
    uint16 public poolSlippageToleranceBps;

    /// @notice Maximum divergence between pool EMA and oracle LDO/wstETH price, in basis points.
    uint16 public poolPriceDivergenceToleranceBps;

    /// @notice True when Stonks settles LDO to this contract for LP deposits. False when it
    ///         settles to the treasury.
    bool public lpModeEnabled;

    /// @notice Cached `ORDER_DURATION_IN_SECONDS` of the active Stonks. Refreshed by
    ///         `_setOperatingMode` so order placement skips the per-call external read.
    uint32 public stonksOrderDurationSeconds;

    /// @notice Active Stonks instance. Replaced via `setOperatingMode`.
    IStonks public stonks;

    /// @notice Most recent order placed by this contract, or zero when none is tracked.
    address public lastOrderAddress;

    /// @notice `validTo` of `lastOrderAddress`. Only meaningful when `lastOrderAddress != address(0)`.
    uint32 public lastOrderValidTo;

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
        uint256 ldoAmount,
        uint256 stEthAmount
    );
    event PoolSlippageToleranceBpsSet(uint256 poolSlippageToleranceBps);
    event PoolPriceDivergenceToleranceBpsSet(uint256 poolPriceDivergenceToleranceBps);
    event WstEthRecoveredAsStEth(
        uint256 wstEthAmount,
        uint256 stEthAmount,
        address indexed recipient
    );
    event OperatingModeSet(bool lpModeEnabled, address stonks);
    event OrderPlaced(address indexed order, uint256 sellAmount, uint256 minBuyAmount);
    event AllocationProcessed(uint256 freeStEth, uint256 forwardedToStonks);
    event StaleOrderRecovered(address indexed order);
    event RetryFromStonksExecuted(address indexed order, uint256 sellAmount);

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroLdoBalance();
    error ZeroStEthBalance();
    error ZeroLpAmount();
    error ZeroBalancedDepositAmount(uint256 ldoAmount, uint256 wstEthAmount);
    error InsufficientLpTokenBalance(uint256 requested, uint256 available);
    error PoolPriceDivergenceTooHigh(
        uint256 poolPrice,
        uint256 oraclePrice,
        uint256 divergenceBps,
        uint256 toleranceBps
    );
    error OraclePriceUnavailable();
    error InvalidStEthAddress();
    error InvalidWstEthAddress();
    error InvalidLdoAddress();
    error InvalidOracleRouterAddress();
    error InvalidCurvePoolAndTokenAddress();
    error InvalidPoolSlippageTolerance(uint256 poolSlippageToleranceBps);
    error InvalidPoolPriceDivergenceTolerance(uint256 poolPriceDivergenceToleranceBps);
    error InvalidCurvePoolCoinOrdering();
    error LiveOrderInPlace(address order, uint256 validTo);
    error InsufficientStonksBalance(uint256 balance);
    error SellAmountTooSmall(uint256 sellAmount);
    error SellAmountExceedsBalance(uint256 sellAmount, uint256 balance);
    error InvalidStonksAddress();
    error StonksReceiverMismatch(address stonks, address expectedReceiver, address actualReceiver);
    error PendingOrderOnSwitch(address order);
    error StonksHoldsResidualStEth(uint256 amount);
    error InvalidOrderAddress();
    error NoOrderToRetry();

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Initializes immutables, tolerances, roles, and operating mode.
     * @param  initParams_ See `InitParams`.
     */
    constructor(
        InitParams memory initParams_
    ) AssetRecovererACL(initParams_.admin, initParams_.treasury) {
        if (initParams_.stEth == address(0)) {
            revert InvalidStEthAddress();
        }

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

        _setPoolSlippageToleranceBps(initParams_.poolSlippageToleranceBps);
        _setPoolPriceDivergenceToleranceBps(initParams_.poolPriceDivergenceToleranceBps);
        _setOperatingMode(initParams_.lpModeEnabled, initParams_.stonks);

        IERC20(address(STETH)).approve(address(WSTETH), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                           EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Wraps a balanced share of held stETH and deposits it with LDO into the Curve pool.
     *         Surplus on the larger-USD side carries over to the next cycle.
     * @return lpTokensMinted LP tokens minted by the pool.
     */
    function addLiquidity() external nonReentrant whenNotPaused returns (uint256 lpTokensMinted) {
        AddLiquidityEvaluation memory evaluation = _evaluateAddLiquidityGates();
        AddLiquidityStatus status = evaluation.status;

        if (status == AddLiquidityStatus.ZeroLdoBalance) {
            revert ZeroLdoBalance();
        }

        if (status == AddLiquidityStatus.ZeroStEthBalance) {
            revert ZeroStEthBalance();
        }

        if (status == AddLiquidityStatus.OraclePriceUnavailable) {
            revert OraclePriceUnavailable();
        }

        if (status == AddLiquidityStatus.PoolPriceDivergenceTooHigh) {
            revert PoolPriceDivergenceTooHigh(
                evaluation.poolEmaPrice,
                evaluation.oraclePriceInLdo,
                evaluation.divergenceBps,
                poolPriceDivergenceToleranceBps
            );
        }

        if (status == AddLiquidityStatus.ZeroBalancedDepositAmount) {
            revert ZeroBalancedDepositAmount(evaluation.ldoAmount, evaluation.wstEthAmount);
        }

        // `wrap` rounds down by up to 1 wei. Use the minted amount for sizing.
        uint256 stEthToWrap = WSTETH.getStETHByWstETH(evaluation.wstEthAmount);
        uint256 actualWstEthMinted = WSTETH.wrap(stEthToWrap);

        uint256 minMintAmount = _computeMinMintAmount(evaluation.ldoAmount, actualWstEthMinted);

        lpTokensMinted = _depositToCurve(evaluation.ldoAmount, actualWstEthMinted, minMintAmount);

        emit LiquidityAdded(
            msg.sender,
            address(CURVE_POOL_AND_TOKEN),
            evaluation.ldoAmount,
            actualWstEthMinted,
            lpTokensMinted
        );
    }

    /**
     * @notice Burns LP tokens, unwraps the wstETH, and sends LDO and stETH to the treasury.
     * @dev    Callable while paused. Reverts when the pool's EMA price diverges from the oracle
     *         beyond `poolPriceDivergenceToleranceBps`.
     * @param  lpAmount_ LP tokens to burn. Non-zero and at most the held balance.
     * @return ldoAmount LDO withdrawn from the pool.
     * @return stEthAmount stETH withdrawn after unwrap.
     */
    function removeLiquidityAndRecoverToTreasury(
        uint256 lpAmount_
    )
        external
        nonReentrant
        onlyRole(MANAGER_ROLE)
        returns (uint256 ldoAmount, uint256 stEthAmount)
    {
        if (lpAmount_ == 0) {
            revert ZeroLpAmount();
        }

        uint256 lpBalance = IERC20(address(CURVE_POOL_AND_TOKEN)).balanceOf(address(this));
        if (lpBalance < lpAmount_) {
            revert InsufficientLpTokenBalance(lpAmount_, lpBalance);
        }

        _assertPoolPriceWithinDivergence();

        uint256[2] memory withdrawn = CURVE_POOL_AND_TOKEN.remove_liquidity(
            lpAmount_,
            _computeMinWithdrawAmounts(lpAmount_)
        );

        ldoAmount = withdrawn[0];
        uint256 wstEthReceived = withdrawn[1];

        stEthAmount = WSTETH.unwrap(wstEthReceived);

        emit WstEthRecoveredAsStEth(wstEthReceived, stEthAmount, TREASURY);

        IERC20(address(LDO)).safeTransfer(TREASURY, ldoAmount);
        IERC20(address(STETH)).safeTransfer(TREASURY, stEthAmount);

        emit LiquidityRemoved(
            msg.sender,
            address(CURVE_POOL_AND_TOKEN),
            lpAmount_,
            ldoAmount,
            stEthAmount
        );
    }

    /**
     * @notice NESTController hook invoked after a stETH push. Sweeps an expired tracked order,
     *         then forwards a share of free stETH to Stonks.
     * @dev    Callable while paused. Does not revert on missing oracle prices or sub-threshold
     *         forward amounts.
     */
    function onStEthAllocated() external nonReentrant onlyRole(ALLOCATOR_ROLE) {
        _sweepExpiredOrder();

        uint256 freeStEth = _computeFreeStEth();
        uint256 stEthAmountToSell = lpModeEnabled ? freeStEth / 2 : freeStEth;

        if (stEthAmountToSell < MIN_POSSIBLE_ORDER_BALANCE) {
            emit AllocationProcessed(freeStEth, 0);

            return;
        }

        IERC20(address(STETH)).safeTransfer(address(stonks), stEthAmountToSell);

        emit AllocationProcessed(freeStEth, stEthAmountToSell);
    }

    /**
     * @notice Places an order selling the Stonks stETH balance.
     * @param  minBuyAmount_ Minimum LDO amount the order must buy.
     * @return newOrder Address of the new order.
     */
    function placeOrder(
        uint256 minBuyAmount_
    ) external nonReentrant whenNotPaused returns (address newOrder) {
        _sweepExpiredOrder();
        _assertNoLiveOrderAndReset();

        IStonks currentStonks = stonks;
        uint256 stonksBalance = STETH.balanceOf(address(currentStonks));

        if (stonksBalance < MIN_POSSIBLE_ORDER_BALANCE) {
            revert InsufficientStonksBalance(stonksBalance);
        }

        newOrder = _executePlacement(currentStonks, stonksBalance, minBuyAmount_);
    }

    /**
     * @notice Places an order with an explicit sell amount.
     * @param  sellAmount_ stETH amount to sell. In `[MIN_POSSIBLE_ORDER_BALANCE, stonksBalance]`.
     * @param  minBuyAmount_ Minimum LDO amount the order must buy.
     * @return newOrder Address of the new order.
     */
    function placeOrderWithAmount(
        uint256 sellAmount_,
        uint256 minBuyAmount_
    ) external nonReentrant onlyRole(MANAGER_ROLE) whenNotPaused returns (address newOrder) {
        if (sellAmount_ < MIN_POSSIBLE_ORDER_BALANCE) {
            revert SellAmountTooSmall(sellAmount_);
        }

        _sweepExpiredOrder();
        _assertNoLiveOrderAndReset();

        IStonks currentStonks = stonks;
        uint256 stonksBalance = STETH.balanceOf(address(currentStonks));

        if (sellAmount_ > stonksBalance) {
            revert SellAmountExceedsBalance(sellAmount_, stonksBalance);
        }

        newOrder = _executePlacement(currentStonks, sellAmount_, minBuyAmount_);
    }

    /**
     * @notice Recovers a tracked expired Order and immediately places a fresh Order using the
     *         current Stonks stETH balance. `minBuyAmount` is derived from
     *         `Stonks.estimateTradeOutput`, so the caller does not need to compute it off-chain.
     * @return newOrder Address of the freshly placed Order.
     */
    function retryFromStonks() external nonReentrant whenNotPaused returns (address newOrder) {
        if (lastOrderAddress == address(0)) {
            revert NoOrderToRetry();
        }

        _sweepExpiredOrder();
        _assertNoLiveOrderAndReset();

        IStonks currentStonks = stonks;
        uint256 stonksBalance = STETH.balanceOf(address(currentStonks));
        if (stonksBalance < MIN_POSSIBLE_ORDER_BALANCE) {
            revert NoOrderToRetry();
        }

        uint256 minBuyAmount = currentStonks.estimateTradeOutput(stonksBalance);
        newOrder = _executePlacement(currentStonks, stonksBalance, minBuyAmount);

        emit RetryFromStonksExecuted(newOrder, stonksBalance);
    }

    /**
     * @notice Switches the operating mode and the active Stonks in one call.
     * @param  lpModeEnabled_ True for LP mode, false for treasury mode.
     * @param  stonks_ New Stonks address.
     */
    function setOperatingMode(
        bool lpModeEnabled_,
        address stonks_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setOperatingMode(lpModeEnabled_, stonks_);
    }

    /**
     * @notice Recovers an expired order's stETH residual to Stonks.
     * @dev    Permissionless. Nulls `lastOrderAddress` when the order is the tracked one and is
     *         drained after the call.
     * @param  order_ Order address to recover from.
     */
    function recoverStaleOrder(address order_) external nonReentrant {
        if (order_ == address(0)) {
            revert InvalidOrderAddress();
        }

        // Already drained: skip the Order recovery call to avoid a revert on dust residue,
        // and still clear the tracked pointer so the placement pipeline isn't stranded.
        if (STETH.balanceOf(order_) < MIN_POSSIBLE_ORDER_BALANCE) {
            if (order_ == lastOrderAddress) {
                lastOrderAddress = address(0);
            }

            emit StaleOrderRecovered(order_);

            return;
        }

        IOrder(order_).recoverTokenFrom();

        if (order_ == lastOrderAddress && STETH.balanceOf(order_) < MIN_POSSIBLE_ORDER_BALANCE) {
            lastOrderAddress = address(0);
        }

        emit StaleOrderRecovered(order_);
    }

    /**
     * @notice Pauses `addLiquidity` and order placement. Idempotent.
     */
    function pause() external onlyRole(EMERGENCY_ROLE) {
        _pause();
    }

    /**
     * @notice Unpauses `addLiquidity` and order placement. Idempotent.
     */
    function unpause() external onlyRole(EMERGENCY_ROLE) {
        _unpause();
    }

    /**
     * @notice Forwards `pauseCreation` to the active Stonks.
     */
    function pauseStonksCreation() external onlyRole(EMERGENCY_ROLE) {
        stonks.pauseCreation();
    }

    /**
     * @notice Forwards `unpauseCreation` to the active Stonks.
     */
    function unpauseStonksCreation() external onlyRole(EMERGENCY_ROLE) {
        stonks.unpauseCreation();
    }

    /**
     * @notice Forwards `pauseSignatures` to the active Stonks.
     */
    function pauseStonksSignatures() external onlyRole(EMERGENCY_ROLE) {
        stonks.pauseSignatures();
    }

    /**
     * @notice Forwards `unpauseSignatures` to the active Stonks.
     */
    function unpauseStonksSignatures() external onlyRole(EMERGENCY_ROLE) {
        stonks.unpauseSignatures();
    }

    /**
     * @notice Updates the Curve deposit and withdrawal slippage tolerance.
     * @param  poolSlippageToleranceBps_ New tolerance in basis points.
     *         In `(0, MAX_POOL_SLIPPAGE_TOLERANCE_BPS]`.
     */
    function setPoolSlippageToleranceBps(
        uint256 poolSlippageToleranceBps_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setPoolSlippageToleranceBps(poolSlippageToleranceBps_);
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
     * @notice Recovers an ERC-20 balance to the treasury. wstETH is unwrapped to stETH first.
     * @dev    Callable while paused.
     * @param  token_ ERC-20 token to recover.
     * @param  amount_ Amount transferred to `TREASURY`.
     */
    function recoverERC20(
        address token_,
        uint256 amount_
    ) external override onlyRole(MANAGER_ROLE) {
        // In case of provisioner holding wstETH, unwrap to stETH and transfer to treasury. Otherwise, transfer the token as is.
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
     * @notice Current Curve LP-token balance.
     */
    function getLpTokenBalance() external view returns (uint256) {
        return IERC20(address(CURVE_POOL_AND_TOKEN)).balanceOf(address(this));
    }

    /**
     * @notice Balanced LDO and wstETH amounts the next `addLiquidity` would deposit at current
     *         oracle prices. Does not guarantee `addLiquidity` would succeed; gate on
     *         `canAddLiquidity` first.
     * @dev    Returns `(0, 0)` on zero balances, missing prices, or any dependency revert.
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

        uint256 stEthBalance = STETH.balanceOf(address(this));
        if (stEthBalance == 0) {
            return (0, 0);
        }

        uint256 wstEthBalance = WSTETH.getWstETHByStETH(stEthBalance);

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
     * @notice True when `addLiquidity` would succeed at the current block.
     */
    function canAddLiquidity() external view returns (bool) {
        return !paused() && _evaluateAddLiquidityGates().status == AddLiquidityStatus.Eligible;
    }

    /**
     * @notice Placement preconditions and next sell sizing for keepers.
     * @dev    `estimatedBuyAmount` falls back to zero on oracle revert. An expired tracked order
     *         is reported as `activeOrder == address(0)`.
     */
    function getPlacementStatus() external view returns (PlacementStatus memory status) {
        IStonks currentStonks = stonks;

        status.isStonksCreationPaused = currentStonks.isCreationPaused();
        status.isStonksKilled = currentStonks.isKilled();

        if (lastOrderAddress != address(0) && block.timestamp <= lastOrderValidTo) {
            status.activeOrder = lastOrderAddress;
            status.activeOrderValidTo = lastOrderValidTo;
        }

        status.sellAmount = STETH.balanceOf(address(currentStonks));
        if (status.sellAmount >= MIN_POSSIBLE_ORDER_BALANCE) {
            try currentStonks.estimateTradeOutput(status.sellAmount) returns (uint256 estimate) {
                status.estimatedBuyAmount = estimate;
            } catch {}
        }

        // Default to false if paused or Stonks is not accepting creations, or if there's an active order.
        if (
            paused() ||
            status.isStonksCreationPaused ||
            status.isStonksKilled ||
            status.activeOrder != address(0)
        ) {
            return status;
        }

        status.canPlace = status.estimatedBuyAmount > MIN_POSSIBLE_ORDER_BALANCE;
    }

    /**
     * @notice Returns whether `retryFromStonks` is callable in the current state.
     * @dev    Mirrors `retryFromStonks` preconditions: not paused, a tracked Order exists, the
     *         tracked Order has expired, Stonks is not creation-paused or killed, the projected
     *         post-sweep Stonks balance clears `MIN_POSSIBLE_ORDER_BALANCE`, and Stonks's oracle
     *         quotes a non-zero buy estimate. Safe for off-chain keepers to pre-screen.
     */
    function canRetryFromStonks() external view returns (bool canRetry) {
        if (paused()) {
            return false;
        }

        address tracked = lastOrderAddress;
        if (tracked == address(0)) {
            return false;
        }

        if (block.timestamp <= lastOrderValidTo) {
            return false;
        }

        IStonks currentStonks = stonks;
        if (currentStonks.isCreationPaused() || currentStonks.isKilled()) {
            return false;
        }

        uint256 projectedBalance = STETH.balanceOf(tracked) +
            STETH.balanceOf(address(currentStonks));
        if (projectedBalance < MIN_POSSIBLE_ORDER_BALANCE) {
            return false;
        }

        try currentStonks.estimateTradeOutput(projectedBalance) returns (uint256 estimated) {
            canRetry = estimated > 0;
        } catch {
            canRetry = false;
        }
    }

    /*//////////////////////////////////////////////////////////////
                    INTERNAL STATE-CHANGING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Internal slippage tolerance setter shared by the constructor and external setter.
     * @param  poolSlippageToleranceBps_ New tolerance in basis points.
     *         In `(0, MAX_POOL_SLIPPAGE_TOLERANCE_BPS]`.
     */
    function _setPoolSlippageToleranceBps(uint256 poolSlippageToleranceBps_) internal {
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

        poolPriceDivergenceToleranceBps = uint16(poolPriceDivergenceToleranceBps_);

        emit PoolPriceDivergenceToleranceBpsSet(poolPriceDivergenceToleranceBps_);
    }

    /**
     * @notice Internal mode swap shared by the constructor and the external setter.
     * @dev    If prior Stonks holds a tracked order or non-dust stETH balance, the function reverts to avoid stranded assets.
     *.        Before migration Stonks should be drained and any tracked order should be recovered or manually swept after expiration.
     * @param  lpModeEnabled_ True for LP mode, false for treasury mode.
     * @param  stonks_ New Stonks address.
     */
    function _setOperatingMode(bool lpModeEnabled_, address stonks_) internal {
        if (stonks_ == address(0)) {
            revert InvalidStonksAddress();
        }

        _sweepExpiredOrder();

        if (lastOrderAddress != address(0)) {
            revert PendingOrderOnSwitch(lastOrderAddress);
        }

        // Revert if the prior Stonks holds a non-dust stETH balance, which would be stranded after the switch.
        IStonks oldStonks = stonks;
        if (address(oldStonks) != address(0)) {
            uint256 residual = STETH.balanceOf(address(oldStonks));

            if (residual >= MIN_POSSIBLE_ORDER_BALANCE) {
                revert StonksHoldsResidualStEth(residual);
            }
        }

        address expectedReceiver = lpModeEnabled_ ? address(this) : TREASURY;
        address actualReceiver = IStonks(stonks_).RECEIVER();

        // Sanity-check the new Stonks's receiver to avoid misconfiguration.
        if (actualReceiver != expectedReceiver) {
            revert StonksReceiverMismatch(stonks_, expectedReceiver, actualReceiver);
        }

        lpModeEnabled = lpModeEnabled_;
        stonks = IStonks(stonks_);
        stonksOrderDurationSeconds = IStonks(stonks_).ORDER_DURATION_IN_SECONDS().toUint32();

        emit OperatingModeSet(lpModeEnabled_, stonks_);
    }

    /**
     * @notice Recovers the tracked order's residual stETH if expired, nulls `lastOrderAddress`
     *         on success. Emits `StaleOrderRecovered` for every sweep that clears the pointer.
     */
    function _sweepExpiredOrder() internal {
        address trackedOrderAddress = lastOrderAddress;
        if (trackedOrderAddress == address(0)) {
            return;
        }

        if (block.timestamp <= lastOrderValidTo) {
            return;
        }

        if (STETH.balanceOf(trackedOrderAddress) < MIN_POSSIBLE_ORDER_BALANCE) {
            lastOrderAddress = address(0);

            emit StaleOrderRecovered(trackedOrderAddress);

            return;
        }

        try IOrder(trackedOrderAddress).recoverTokenFrom() {
            lastOrderAddress = address(0);

            emit StaleOrderRecovered(trackedOrderAddress);
        } catch {}
    }

    /**
     * @notice Reverts if `lastOrderAddress` points to a non-expired order. Nulls an expired
     *         pointer in place.
     */
    function _assertNoLiveOrderAndReset() internal {
        address trackedOrderAddress = lastOrderAddress;
        if (trackedOrderAddress == address(0)) {
            return;
        }

        if (block.timestamp <= lastOrderValidTo) {
            revert LiveOrderInPlace(trackedOrderAddress, lastOrderValidTo);
        }

        lastOrderAddress = address(0);
    }

    /**
     * @notice Places an order via `currentStonks_` and records its tracking metadata.
     * @param  currentStonks_ Active Stonks instance.
     * @param  sellAmount_ stETH amount to sell.
     * @param  minBuyAmount_ Minimum LDO amount the order must buy.
     * @return newOrder Address of the new order.
     */
    function _executePlacement(
        IStonks currentStonks_,
        uint256 sellAmount_,
        uint256 minBuyAmount_
    ) internal returns (address newOrder) {
        newOrder = currentStonks_.placeOrderWithAmount(sellAmount_, minBuyAmount_);

        lastOrderAddress = newOrder;
        lastOrderValidTo = (block.timestamp + stonksOrderDurationSeconds).toUint32();

        emit OrderPlaced(newOrder, sellAmount_, minBuyAmount_);
    }

    /**
     * @notice Approves the Curve pool for the exact deposit amounts and calls `add_liquidity`.
     * @param  ldoAmount_ LDO amount to deposit.
     * @param  wstEthAmount_ wstETH amount to deposit.
     * @param  minMintAmount_ Minimum LP tokens to accept.
     * @return lpTokensMinted LP tokens received.
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
     * @dev Revert-safe `ORACLE_ROUTER.getUsdPrices`. Returns `pricesValid=false` on revert.
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
     * @notice Free stETH available for forwarding to Stonks. Subtracts the stETH value of held
     *         LDO, the stETH on Stonks, and the residual on the tracked order.
     * @dev    Returns 0 on missing oracle prices. Treasury mode short-circuits the oracle path
     *         since LDO settles to `TREASURY`.
     */
    function _computeFreeStEth() internal view returns (uint256) {
        uint256 ldoInStEth;

        // Reserve the stETH equivalent of held LDO so the next Curve deposit stays balanced.
        // Treasury mode settles LDO to TREASURY directly; any residual LDO here has no claim on stETH.
        if (lpModeEnabled) {
            uint256 ldoBalance = LDO.balanceOf(address(this));

            if (ldoBalance > 0) {
                (bool pricesValid, uint256 ldoUsdPrice, uint256 stEthUsdPrice) = _tryGetUsdPrices(
                    address(LDO),
                    address(STETH)
                );

                if (!pricesValid || ldoUsdPrice == 0 || stEthUsdPrice == 0) {
                    return 0;
                }

                ldoInStEth = Math.mulDiv(ldoBalance, ldoUsdPrice, stEthUsdPrice);
            }
        }

        uint256 orderBalance = lastOrderAddress == address(0)
            ? 0
            : STETH.balanceOf(lastOrderAddress);

        uint256 freeAfterLdo = MathHelpers.saturatedSub(STETH.balanceOf(address(this)), ldoInStEth);
        uint256 freeAfterStonks = MathHelpers.saturatedSub(
            freeAfterLdo,
            STETH.balanceOf(address(stonks))
        );

        return MathHelpers.saturatedSub(freeAfterStonks, orderBalance);
    }

    /**
     * @notice Runs every `addLiquidity` precondition and computes the balanced deposit pair.
     * @dev    Does not revert on missing oracle prices; pool reverts bubble up.
     * @return evaluation Status, balanced deposit amounts, prices, and divergence values.
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

        uint256 stEthBalance = STETH.balanceOf(address(this));
        if (stEthBalance == 0) {
            evaluation.status = AddLiquidityStatus.ZeroStEthBalance;
            return evaluation;
        }

        uint256 wstEthBalance = WSTETH.getWstETHByStETH(stEthBalance);
        (bool pricesValid, uint256 ldoUsdPrice, uint256 wstEthUsdPrice) = _tryGetUsdPrices(
            address(LDO),
            address(WSTETH)
        );

        if (!pricesValid || ldoUsdPrice == 0 || wstEthUsdPrice == 0) {
            evaluation.status = AddLiquidityStatus.OraclePriceUnavailable;
            return evaluation;
        }

        uint256 oraclePriceInLdo = Math.mulDiv(wstEthUsdPrice, PRICE_SCALE, ldoUsdPrice);
        if (oraclePriceInLdo == 0) {
            evaluation.status = AddLiquidityStatus.OraclePriceUnavailable;
            return evaluation;
        }

        evaluation.oraclePriceInLdo = oraclePriceInLdo;

        uint256 poolEmaPrice = CURVE_POOL_AND_TOKEN.price_oracle();
        evaluation.poolEmaPrice = poolEmaPrice;

        uint256 divergenceBps = _computeDivergenceBps(poolEmaPrice, oraclePriceInLdo);
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
     * @notice Absolute divergence between two `PRICE_SCALE` prices, in basis points of `reference_`.
     * @param  observed_ Price under check.
     * @param  reference_ Reference price the divergence is normalized against. Must be non-zero.
     */
    function _computeDivergenceBps(
        uint256 observed_,
        uint256 reference_
    ) internal pure returns (uint256) {
        uint256 diff = observed_ >= reference_ ? observed_ - reference_ : reference_ - observed_;
        return Math.mulDiv(diff, MAX_BASIS_POINTS, reference_);
    }

    /**
     * @notice Reverts when oracle prices are unavailable or the Curve pool's EMA diverges from
     *         the oracle LDO/wstETH ratio beyond `poolPriceDivergenceToleranceBps`.
     * @dev    Guards both deposit and withdrawal sizing: minAmounts on either side derive from
     *         `price_oracle()` and `get_virtual_price()`, which are pool-internal and can be
     *         skewed by a sandwich. The oracle cross-check rejects operations when off-peg.
     */
    function _assertPoolPriceWithinDivergence() internal view {
        (bool pricesValid, uint256 ldoUsdPrice, uint256 wstEthUsdPrice) = _tryGetUsdPrices(
            address(LDO),
            address(WSTETH)
        );

        if (!pricesValid || ldoUsdPrice == 0 || wstEthUsdPrice == 0) {
            revert OraclePriceUnavailable();
        }

        uint256 oraclePriceInLdo = Math.mulDiv(wstEthUsdPrice, PRICE_SCALE, ldoUsdPrice);

        if (oraclePriceInLdo == 0) {
            revert OraclePriceUnavailable();
        }

        uint256 poolEmaPrice = CURVE_POOL_AND_TOKEN.price_oracle();
        uint256 divergenceBps = _computeDivergenceBps(poolEmaPrice, oraclePriceInLdo);

        if (divergenceBps > poolPriceDivergenceToleranceBps) {
            revert PoolPriceDivergenceTooHigh(
                poolEmaPrice,
                oraclePriceInLdo,
                divergenceBps,
                poolPriceDivergenceToleranceBps
            );
        }
    }

    /**
     * @notice Balanced LDO/wstETH deposit pair sized by the smaller-USD side.
     * @param  ldoBalance_ Current LDO balance.
     * @param  wstEthBalance_ Notional wstETH balance.
     * @param  ldoUsdPrice_ LDO/USD price scaled by `PRICE_SCALE`.
     * @param  wstEthUsdPrice_ wstETH/USD price scaled by `PRICE_SCALE`.
     * @return ldoAmount Balanced LDO amount.
     * @return wstEthAmount Balanced wstETH amount.
     */
    function _computeBalancedAmounts(
        uint256 ldoBalance_,
        uint256 wstEthBalance_,
        uint256 ldoUsdPrice_,
        uint256 wstEthUsdPrice_
    ) internal pure returns (uint256 ldoAmount, uint256 wstEthAmount) {
        // Compute the USD value of each side to find the smaller one.
        uint256 ldoUsdValue = Math.mulDiv(ldoBalance_, ldoUsdPrice_, PRICE_SCALE);
        uint256 wstEthUsdValue = Math.mulDiv(wstEthBalance_, wstEthUsdPrice_, PRICE_SCALE);

        // Size by the smaller-USD side. The larger side's surplus carries over to the next cycle.
        if (ldoUsdValue <= wstEthUsdValue) {
            ldoAmount = ldoBalance_;
            wstEthAmount = Math.mulDiv(ldoUsdValue, PRICE_SCALE, wstEthUsdPrice_);
        } else {
            wstEthAmount = wstEthBalance_;
            ldoAmount = Math.mulDiv(wstEthUsdValue, PRICE_SCALE, ldoUsdPrice_);
        }
    }

    /**
     * @notice Minimum LP tokens accepted from `add_liquidity`. Sources the expected mint from
     *         Curve's own `calc_token_amount` and applies `poolSlippageToleranceBps`.
     * @dev    Pool-spot manipulation is bounded by `_assertPoolPriceWithinDivergence` upstream.
     * @param  ldoAmount_ LDO deposit amount.
     * @param  wstEthAmount_ wstETH deposit amount.
     * @return minMintAmount Minimum LP tokens to accept.
     */
    function _computeMinMintAmount(
        uint256 ldoAmount_,
        uint256 wstEthAmount_
    ) internal view returns (uint256 minMintAmount) {
        uint256 expectedMint = CURVE_POOL_AND_TOKEN.calc_token_amount(
            [ldoAmount_, wstEthAmount_],
            true
        );
        uint256 keptBps = MAX_BASIS_POINTS - poolSlippageToleranceBps;
        minMintAmount = Math.mulDiv(expectedMint, keptBps, MAX_BASIS_POINTS);
    }

    /**
     * @notice Minimum `[LDO, wstETH]` amounts accepted from `remove_liquidity`. `remove_liquidity`
     *         is proportional, so each leg is `balances[i] * lpAmount / totalSupply` discounted by
     *         `poolSlippageToleranceBps`.
     * @dev    Pool-spot manipulation is bounded by `_assertPoolPriceWithinDivergence` upstream.
     * @param  lpAmount_ LP tokens being burned.
     * @return minAmounts Minimum `[LDO, wstETH]` to accept.
     */
    function _computeMinWithdrawAmounts(
        uint256 lpAmount_
    ) internal view returns (uint256[2] memory minAmounts) {
        uint256 totalSupply = IERC20(address(CURVE_POOL_AND_TOKEN)).totalSupply();
        uint256 keptBps = MAX_BASIS_POINTS - poolSlippageToleranceBps;

        uint256 expectedLdo = Math.mulDiv(CURVE_POOL_AND_TOKEN.balances(0), lpAmount_, totalSupply);
        uint256 expectedWstEth = Math.mulDiv(
            CURVE_POOL_AND_TOKEN.balances(1),
            lpAmount_,
            totalSupply
        );

        minAmounts[0] = Math.mulDiv(expectedLdo, keptBps, MAX_BASIS_POINTS);
        minAmounts[1] = Math.mulDiv(expectedWstEth, keptBps, MAX_BASIS_POINTS);
    }
}
