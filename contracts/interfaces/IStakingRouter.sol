// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

interface IStakingRouter {
    function getStakingFeeAggregateDistribution()
        external
        view
        returns (uint256 modulesFee, uint256 treasuryFee, uint256 basePrecision);
}
