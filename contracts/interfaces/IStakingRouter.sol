// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IStakingRouter {
    /// @notice Returns the aggregate fee distribution proportion.
    /// @return modulesFee Modules aggregate fee in base precision.
    /// @return treasuryFee Treasury fee in base precision.
    /// @return basePrecision Base precision: a value corresponding to the full fee.
    function getStakingFeeAggregateDistribution()
        public
        view
        returns (uint96 modulesFee, uint96 treasuryFee, uint256 basePrecision)
}
