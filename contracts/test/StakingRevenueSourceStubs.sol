// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IOracleRouter} from "../interfaces/IOracleRouter.sol";

/**
 * @title StakingRevenueSource stubs
 * @notice Minimal test doubles for the four external dependencies consumed by
 *         `StakingRevenueSource.pushTokenRate`: wstETH rate, stETH shares, StakingRouter fee
 *         distribution, and OracleRouter USD price. Each stub exposes a setter so the test writer
 *         can script precise branch coverage (positive/zero/negative delta, share/fee edges,
 *         price-zero, division-by-zero). Unused interface methods are omitted to keep ABIs tight.
 */

contract WstEthRateStub {
    uint256 public stEthPerToken;

    constructor(uint256 initialStEthPerToken_) {
        stEthPerToken = initialStEthPerToken_;
    }

    function setStEthPerToken(uint256 stEthPerToken_) external {
        stEthPerToken = stEthPerToken_;
    }

    function getStETHByWstETH(uint256 wstEthAmount_) external view returns (uint256) {
        // The production interface scales arbitrary `wstEthAmount_` by the stored rate. For the
        // source we only ever query `TOKEN_RATE_SCALE` (1e27), so the divisor is 1e27; a faithful
        // implementation lets a test probe other inputs without the stub short-circuiting.
        return (stEthPerToken * wstEthAmount_) / 1e27;
    }
}

contract StEthSharesStub {
    uint256 public totalShares;
    uint256 public externalShares;

    function setShares(uint256 totalShares_, uint256 externalShares_) external {
        totalShares = totalShares_;
        externalShares = externalShares_;
    }

    function getTotalShares() external view returns (uint256) {
        return totalShares;
    }

    function getExternalShares() external view returns (uint256) {
        return externalShares;
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
    uint256 public baseUsdPrice;
    uint256 public quoteUsdPrice;

    function setUsdPrice(uint256 baseUsdPrice_, uint256 quoteUsdPrice_) external {
        baseUsdPrice = baseUsdPrice_;
        quoteUsdPrice = quoteUsdPrice_;
    }

    function getUsdPrices(address, address) external view returns (uint256, uint256) {
        return (baseUsdPrice, quoteUsdPrice);
    }
}
