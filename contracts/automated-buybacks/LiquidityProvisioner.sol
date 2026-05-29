// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
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
        uint16 poolPriceDivergenceToleranceBps;
        uint128 minAllowedOrderAmount;
        uint128 maxAllowedOrderAmount;
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
        uint256 stEthAmount;
        uint256 poolEmaPrice;
        uint256 stEthPriceInLdo;
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
    bytes32 public constant ALLOCATOR_ROLE = keccak256("NEST.LiquidityProvisioner.ALLOCATOR_ROLE");

    /// @notice 100% in basis points.
    uint256 public constant MAX_BASIS_POINTS = 10000;

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

    /// @notice USD oracle for LDO and stETH.
    IOracleRouter public immutable ORACLE_ROUTER;

    /// @notice Curve TwoCrypto LDO/wstETH pool, also the LP token. Coin order: `[LDO, wstETH]`.
    ICurvePool public immutable CURVE_POOL_AND_TOKEN;

    /*//////////////////////////////////////////////////////////////
                        CONFIGURABLE STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Maximum divergence between pool EMA and oracle LDO/stETH price, in basis points.
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

    /// @notice Minimum stETH amount per order.
    uint128 public minAllowedOrderAmount;

    /// @notice Maximum stETH amount per order. `placeOrder` clamps its sell amount to this ceiling.
    uint128 public maxAllowedOrderAmount;

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
    event LdoWithdrawnToTreasury(address indexed caller, uint256 ldoAmount);
    event StEthWithdrawnToTreasury(address indexed caller, uint256 stEthAmount);
    event PoolPriceDivergenceToleranceBpsSet(uint256 poolPriceDivergenceToleranceBps);
    event MinAllowedOrderAmountSet(uint256 minAllowedOrderAmount);
    event MaxAllowedOrderAmountSet(uint256 maxAllowedOrderAmount);
    event OperatingModeSet(bool lpModeEnabled, address stonks);
    event OrderPlaced(address indexed order, uint256 sellAmount, uint256 minBuyAmount);
    event AllocationProcessed(uint256 freeStEth, uint256 forwardedToStonks);
    event StaleOrderRecovered(address indexed order);

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroLdoBalance();
    error ZeroStEthBalance();
    error ZeroLpAmount();
    error ZeroBalancedDepositAmount(uint256 ldoAmount, uint256 stEthAmount);
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
    error InvalidPoolPriceDivergenceTolerance(uint256 poolPriceDivergenceToleranceBps);
    error InvalidOrderAmountLimits(uint256 minAllowedOrderAmount, uint256 maxAllowedOrderAmount);
    error InvalidCurvePoolCoinOrdering();
    error WstEthStEthMismatch(address declaredStEth, address boundStEth);
    error InvalidTokenDecimals(address token, uint8 decimals);
    error LiveOrderInPlace(address order, uint256 validTo);
    error InsufficientStonksBalance(uint256 balance);
    error InvalidStonksAddress();
    error StonksReceiverMismatch(address stonks, address expectedReceiver, address actualReceiver);

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

        address boundStEth = IWstETH(initParams_.wstEth).stETH();
        if (boundStEth != initParams_.stEth) {
            revert WstEthStEthMismatch(initParams_.stEth, boundStEth);
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

        _setPoolPriceDivergenceToleranceBps(initParams_.poolPriceDivergenceToleranceBps);
        _setOrderAmountLimits(initParams_.minAllowedOrderAmount, initParams_.maxAllowedOrderAmount);
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
                evaluation.stEthPriceInLdo,
                evaluation.divergenceBps,
                poolPriceDivergenceToleranceBps
            );
        }

        if (status == AddLiquidityStatus.ZeroBalancedDepositAmount) {
            revert ZeroBalancedDepositAmount(evaluation.ldoAmount, evaluation.stEthAmount);
        }

        assert(status == AddLiquidityStatus.Eligible);

        // `wrap` rounds down by up to 1 wei. Use the minted amount for the Curve deposit.
        uint256 actualWstEthMinted = WSTETH.wrap(evaluation.stEthAmount);

        lpTokensMinted = _depositToCurve(evaluation.ldoAmount, actualWstEthMinted);

        emit LiquidityAdded(msg.sender, evaluation.ldoAmount, actualWstEthMinted, lpTokensMinted);
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
            [uint256(0), uint256(0)]
        );

        ldoAmount = withdrawn[0];
        uint256 wstEthReceived = withdrawn[1];

        stEthAmount = WSTETH.unwrap(wstEthReceived);

        emit LdoWithdrawnToTreasury(msg.sender, ldoAmount);
        emit StEthWithdrawnToTreasury(msg.sender, stEthAmount);
        emit LiquidityRemoved(msg.sender, lpAmount_, ldoAmount, stEthAmount);

        IERC20(address(LDO)).safeTransfer(TREASURY, ldoAmount);
        IERC20(address(STETH)).safeTransfer(TREASURY, stEthAmount);
    }

    /**
     * @notice NESTController hook invoked after a stETH push. Sweeps an expired tracked order,
     *         then forwards a share of free stETH to Stonks.
     * @dev    Does not revert on missing oracle prices or sub-threshold forward amounts.
     */
    function onStEthAllocated() external nonReentrant whenNotPaused onlyRole(ALLOCATOR_ROLE) {
        _sweepExpiredOrder();

        uint256 freeStEth = lpModeEnabled
            ? _computeLpModeFreeStEth()
            : STETH.balanceOf(address(this));
        uint256 stEthAmountToSell = lpModeEnabled ? freeStEth / 2 : freeStEth;

        if (stEthAmountToSell < minAllowedOrderAmount) {
            emit AllocationProcessed(freeStEth, 0);

            return;
        }

        emit AllocationProcessed(freeStEth, stEthAmountToSell);

        IERC20(address(STETH)).safeTransfer(address(stonks), stEthAmountToSell);
    }

    /**
     * @notice Places an order selling the Stonks stETH balance. `minBuyAmount` is derived from
     *         `Stonks.estimateTradeOutput`, so the caller does not need to compute it off-chain.
     * @return newOrder Address of the new order.
     */
    function placeOrder() external nonReentrant whenNotPaused returns (address newOrder) {
        _sweepExpiredOrder();
        _assertNoLiveOrder();

        IStonks currentStonks = stonks;
        uint256 stonksBalance = STETH.balanceOf(address(currentStonks));
        uint256 cachedMax = maxAllowedOrderAmount;
        uint256 sellAmount = stonksBalance < cachedMax ? stonksBalance : cachedMax;

        if (sellAmount < minAllowedOrderAmount) {
            revert InsufficientStonksBalance(stonksBalance);
        }

        uint256 minBuyAmount = currentStonks.estimateTradeOutput(sellAmount);
        newOrder = _executePlacement(currentStonks, sellAmount, minBuyAmount);
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
     * @notice Pauses `addLiquidity` and order placement. Reverts if already paused.
     */
    function pause() external onlyRole(EMERGENCY_ROLE) {
        _pause();
    }

    /**
     * @notice Unpauses `addLiquidity` and order placement. Reverts if not paused.
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
        if (minAllowedOrderAmount_ == 0 || minAllowedOrderAmount_ >= maxAllowedOrderAmount) {
            revert InvalidOrderAmountLimits(minAllowedOrderAmount_, maxAllowedOrderAmount);
        }

        minAllowedOrderAmount = minAllowedOrderAmount_;

        emit MinAllowedOrderAmountSet(minAllowedOrderAmount_);
    }

    /**
     * @notice Updates the maximum stETH order size.
     * @param  maxAllowedOrderAmount_ New maximum. Must be strictly above `minAllowedOrderAmount`.
     */
    function setMaxAllowedOrderAmount(
        uint128 maxAllowedOrderAmount_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (maxAllowedOrderAmount_ == 0 || maxAllowedOrderAmount_ <= minAllowedOrderAmount) {
            revert InvalidOrderAmountLimits(minAllowedOrderAmount, maxAllowedOrderAmount_);
        }

        maxAllowedOrderAmount = maxAllowedOrderAmount_;

        emit MaxAllowedOrderAmountSet(maxAllowedOrderAmount_);
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
     * @notice Balanced LDO and stETH amounts for the next `addLiquidity` deposit at current
     *         oracle prices. Gate on `canAddLiquidity` for full eligibility.
     * @dev    Returns `(0, 0)` on zero balances. Reverts when the oracle is unavailable.
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

        (uint256 ldoUsdPrice, uint256 stEthUsdPrice) = ORACLE_ROUTER.getUsdPrices(
            address(LDO),
            address(STETH)
        );

        if (ldoUsdPrice == 0 || stEthUsdPrice == 0) {
            revert OraclePriceUnavailable();
        }

        (ldoAmount, stEthAmount) = _computeBalancedAmounts(
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

        uint256 stonksBalance = STETH.balanceOf(address(currentStonks));
        uint256 cachedMax = maxAllowedOrderAmount;

        status.sellAmount = stonksBalance < cachedMax ? stonksBalance : cachedMax;

        if (status.sellAmount >= minAllowedOrderAmount) {
            try currentStonks.estimateTradeOutput(status.sellAmount) returns (uint256 estimate) {
                status.estimatedBuyAmount = estimate;
            } catch {}
        }

        if (
            paused() ||
            status.isStonksCreationPaused ||
            status.isStonksKilled ||
            status.activeOrder != address(0)
        ) {
            return status;
        }

        status.canPlace =
            status.sellAmount >= minAllowedOrderAmount &&
            status.estimatedBuyAmount > 0;
    }

    /*//////////////////////////////////////////////////////////////
                    INTERNAL STATE-CHANGING FUNCTIONS
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

        poolPriceDivergenceToleranceBps = uint16(poolPriceDivergenceToleranceBps_);

        emit PoolPriceDivergenceToleranceBpsSet(poolPriceDivergenceToleranceBps_);
    }

    /**
     * @notice Internal pair setter used by the constructor to set both limits atomically.
     * @param  minAllowedOrderAmount_ New minimum. Non-zero and strictly below the maximum.
     * @param  maxAllowedOrderAmount_ New maximum. Strictly above the minimum.
     */
    function _setOrderAmountLimits(
        uint128 minAllowedOrderAmount_,
        uint128 maxAllowedOrderAmount_
    ) internal {
        if (minAllowedOrderAmount_ == 0 || minAllowedOrderAmount_ >= maxAllowedOrderAmount_) {
            revert InvalidOrderAmountLimits(minAllowedOrderAmount_, maxAllowedOrderAmount_);
        }

        minAllowedOrderAmount = minAllowedOrderAmount_;
        maxAllowedOrderAmount = maxAllowedOrderAmount_;

        emit MinAllowedOrderAmountSet(minAllowedOrderAmount_);
        emit MaxAllowedOrderAmountSet(maxAllowedOrderAmount_);
    }

    /**
     * @notice Internal mode swap shared by the constructor and the external setter.
     * @dev    Switching disconnects this contract from the previous Stonks. Drain it and sweep
     *         any tracked order before switching, or recover via governance afterwards.
     * @param  lpModeEnabled_ True for LP mode, false for treasury mode.
     * @param  stonks_ New Stonks address.
     */
    function _setOperatingMode(bool lpModeEnabled_, address stonks_) internal {
        if (stonks_ == address(0)) {
            revert InvalidStonksAddress();
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

        _setLastOrderTrackingData(address(0), 0);

        emit OperatingModeSet(lpModeEnabled_, stonks_);
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

        emit StaleOrderRecovered(trackedOrderAddress);

        if (STETH.balanceOf(trackedOrderAddress) >= MIN_POSSIBLE_ORDER_BALANCE) {
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

        _setLastOrderTrackingData(newOrder, block.timestamp + stonksOrderDurationSeconds);

        emit OrderPlaced(newOrder, sellAmount_, minBuyAmount_);
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
        lpTokensMinted = CURVE_POOL_AND_TOKEN.add_liquidity(amounts, 1);
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
     * @notice Reverts when a live tracked order is in place. Callers invoke `_sweepExpiredOrder`
     *         first, so by the time this runs the pointer is either cleared or points to a live one.
     */
    function _assertNoLiveOrder() internal view {
        if (lastOrderAddress == address(0)) {
            return;
        }

        revert LiveOrderInPlace(lastOrderAddress, lastOrderValidTo);
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
            (bool pricesValid, uint256 ldoUsdPrice, uint256 stEthUsdPrice) = _tryGetUsdPrices(
                address(LDO),
                address(STETH)
            );

            if (!pricesValid || ldoUsdPrice == 0 || stEthUsdPrice == 0) {
                return 0;
            }

            ldoInStEth = Math.mulDiv(ldoBalance, ldoUsdPrice, stEthUsdPrice);
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
     * @dev    Does not revert on missing oracle prices. Pool reverts bubble up.
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

        (bool pricesValid, uint256 ldoUsdPrice, uint256 stEthUsdPrice) = _tryGetUsdPrices(
            address(LDO),
            address(STETH)
        );

        if (!pricesValid || ldoUsdPrice == 0 || stEthUsdPrice == 0) {
            evaluation.status = AddLiquidityStatus.OraclePriceUnavailable;
            return evaluation;
        }

        (
            uint256 stEthPriceInLdo,
            uint256 poolEmaInStEth,
            uint256 divergenceBps
        ) = _computeOracleDivergence(ldoUsdPrice, stEthUsdPrice);

        if (stEthPriceInLdo == 0) {
            evaluation.status = AddLiquidityStatus.OraclePriceUnavailable;
            return evaluation;
        }

        evaluation.stEthPriceInLdo = stEthPriceInLdo;
        evaluation.poolEmaPrice = poolEmaInStEth;
        evaluation.divergenceBps = divergenceBps;

        if (divergenceBps > poolPriceDivergenceToleranceBps) {
            evaluation.status = AddLiquidityStatus.PoolPriceDivergenceTooHigh;
            return evaluation;
        }

        (uint256 ldoAmount, uint256 stEthAmount) = _computeBalancedAmounts(
            ldoBalance,
            stEthBalance,
            ldoUsdPrice,
            stEthUsdPrice
        );
        evaluation.ldoAmount = ldoAmount;
        evaluation.stEthAmount = stEthAmount;

        if (ldoAmount == 0 || stEthAmount == 0) {
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
     *         the oracle LDO/stETH ratio beyond `poolPriceDivergenceToleranceBps`. The pool EMA
     *         is converted from LDO/wstETH to LDO/stETH via the wstETH share rate.
     * @dev    Guards withdrawal sizing. `remove_liquidity` minAmounts derive from `price_oracle()`
     *         and `get_virtual_price()`, which can be skewed by a sandwich. The oracle cross-check
     *         rejects the withdrawal when off-peg.
     */
    function _assertPoolPriceWithinDivergence() internal view {
        (uint256 ldoUsdPrice, uint256 stEthUsdPrice) = ORACLE_ROUTER.getUsdPrices(
            address(LDO),
            address(STETH)
        );

        if (ldoUsdPrice == 0 || stEthUsdPrice == 0) {
            revert OraclePriceUnavailable();
        }

        (
            uint256 stEthPriceInLdo,
            uint256 poolEmaInStEth,
            uint256 divergenceBps
        ) = _computeOracleDivergence(ldoUsdPrice, stEthUsdPrice);

        if (stEthPriceInLdo == 0) {
            revert OraclePriceUnavailable();
        }

        if (divergenceBps > poolPriceDivergenceToleranceBps) {
            revert PoolPriceDivergenceTooHigh(
                poolEmaInStEth,
                stEthPriceInLdo,
                divergenceBps,
                poolPriceDivergenceToleranceBps
            );
        }
    }

    /**
     * @notice Pool EMA and divergence vs the LDO/stETH oracle ratio. The pool EMA is converted
     *         from LDO/wstETH to LDO/stETH via the wstETH share rate. Returns zeros when the
     *         LDO-denominated stETH price rounds to zero.
     * @param  ldoUsdPrice_ LDO/USD price scaled by `PRICE_SCALE`. Non-zero.
     * @param  stEthUsdPrice_ stETH/USD price scaled by `PRICE_SCALE`. Non-zero.
     * @return stEthPriceInLdo Oracle LDO/stETH ratio scaled by `PRICE_SCALE`, or zero on truncation.
     * @return poolEmaInStEth Pool EMA in LDO/stETH scaled by `PRICE_SCALE`.
     * @return divergenceBps Divergence between the pool EMA and the oracle ratio in basis points.
     */
    function _computeOracleDivergence(
        uint256 ldoUsdPrice_,
        uint256 stEthUsdPrice_
    )
        internal
        view
        returns (uint256 stEthPriceInLdo, uint256 poolEmaInStEth, uint256 divergenceBps)
    {
        stEthPriceInLdo = Math.mulDiv(stEthUsdPrice_, PRICE_SCALE, ldoUsdPrice_);
        if (stEthPriceInLdo == 0) {
            return (0, 0, 0);
        }

        poolEmaInStEth = Math.mulDiv(
            CURVE_POOL_AND_TOKEN.price_oracle(),
            PRICE_SCALE,
            WSTETH.stEthPerToken()
        );

        divergenceBps = _computeDivergenceBps(poolEmaInStEth, stEthPriceInLdo);
    }

    /**
     * @notice Balanced LDO/stETH deposit pair sized by the smaller-USD side.
     * @param  ldoBalance_ Current LDO balance.
     * @param  stEthBalance_ Current stETH balance.
     * @param  ldoUsdPrice_ LDO/USD price scaled by `PRICE_SCALE`.
     * @param  stEthUsdPrice_ stETH/USD price scaled by `PRICE_SCALE`.
     * @return ldoAmount Balanced LDO amount.
     * @return stEthAmount Balanced stETH amount.
     */
    function _computeBalancedAmounts(
        uint256 ldoBalance_,
        uint256 stEthBalance_,
        uint256 ldoUsdPrice_,
        uint256 stEthUsdPrice_
    ) internal pure returns (uint256 ldoAmount, uint256 stEthAmount) {
        // Compute the USD value of each side to find the smaller one.
        uint256 ldoUsdValue = Math.mulDiv(ldoBalance_, ldoUsdPrice_, PRICE_SCALE);
        uint256 stEthUsdValue = Math.mulDiv(stEthBalance_, stEthUsdPrice_, PRICE_SCALE);

        // Size by the smaller-USD side. The larger side's surplus carries over to the next cycle.
        if (ldoUsdValue <= stEthUsdValue) {
            ldoAmount = ldoBalance_;
            stEthAmount = Math.mulDiv(ldoUsdValue, PRICE_SCALE, stEthUsdPrice_);
        } else {
            stEthAmount = stEthBalance_;
            ldoAmount = Math.mulDiv(stEthUsdValue, PRICE_SCALE, ldoUsdPrice_);
        }
    }
}
