// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {IOracleRouter} from "../interfaces/IOracleRouter.sol";

/**
 * @title StakingRevenueSource stubs
 * @notice Minimal test doubles for the external dependencies consumed by
 *         `StakingRevenueSource`: stETH share→ETH conversion, StakingRouter fee distribution,
 *         OracleRouter USD price, and LidoLocator service discovery. Each stub exposes a
 *         setter so the test writer can script precise branch coverage. Unused interface
 *         methods are omitted to keep ABIs tight.
 */

contract LidoLocatorStub {
    address public lido;
    address public stakingRouter;
    address public postTokenRebaseReceiver;

    function setLido(address lido_) external {
        lido = lido_;
    }

    function setStakingRouter(address stakingRouter_) external {
        stakingRouter = stakingRouter_;
    }

    function setPostTokenRebaseReceiver(address receiver_) external {
        postTokenRebaseReceiver = receiver_;
    }
}

contract StEthSharesStub {
    /// @notice stETH per share, scaled to `1e18` (1e18 == 1.0 stETH per share).
    uint256 public pooledEthPerShare;

    constructor(uint256 initialPooledEthPerShare_) {
        pooledEthPerShare = initialPooledEthPerShare_;
    }

    function setPooledEthPerShare(uint256 pooledEthPerShare_) external {
        pooledEthPerShare = pooledEthPerShare_;
    }

    function getPooledEthByShares(uint256 shares_) external view returns (uint256) {
        return (shares_ * pooledEthPerShare) / 1e18;
    }
}

contract StakingRouterStub {
    uint256 public modulesFee;
    uint256 public treasuryFee;
    uint256 public basePrecision;

    function setFeeDistribution(
        uint256 modulesFee_,
        uint256 treasuryFee_,
        uint256 basePrecision_
    ) external {
        modulesFee = modulesFee_;
        treasuryFee = treasuryFee_;
        basePrecision = basePrecision_;
    }

    function getStakingFeeAggregateDistribution()
        external
        view
        returns (uint256, uint256, uint256)
    {
        return (modulesFee, treasuryFee, basePrecision);
    }
}

contract OracleRouterUsdStub {
    /// @dev Failure modes for testing the source's catch branches. `None` returns the stored
    ///      prices; `CustomError` reverts with a named error (non-empty revert data) and exercises
    ///      the recoverable path; `EmptyRevert` reverts with zero data and exercises the
    ///      out-of-gas heuristic.
    enum FailureMode {
        None,
        CustomError,
        EmptyRevert
    }

    error OracleStubFailure();

    /// @notice Price unit reported to consumers. Mirrors `OracleRouter.PRICE_UNIT` so the source
    ///         under test caches the expected scale at deployment.
    uint256 public constant PRICE_UNIT = 1e18;

    uint256 public baseUsdPrice;
    uint256 public quoteUsdPrice;
    FailureMode public failureMode;

    function setUsdPrice(uint256 baseUsdPrice_, uint256 quoteUsdPrice_) external {
        baseUsdPrice = baseUsdPrice_;
        quoteUsdPrice = quoteUsdPrice_;
    }

    function setFailureMode(FailureMode failureMode_) external {
        failureMode = failureMode_;
    }

    function getUsdPrices(address, address) external view returns (uint256, uint256) {
        FailureMode mode = failureMode;
        if (mode == FailureMode.CustomError) {
            revert OracleStubFailure();
        }
        if (mode == FailureMode.EmptyRevert) {
            assembly {
                revert(0, 0)
            }
        }
        return (baseUsdPrice, quoteUsdPrice);
    }
}
