// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IRevenueSource} from "../interfaces/IRevenueSource.sol";

/**
 * @title BuybackAllocator stubs
 * @notice Minimal test doubles for the dependencies `BuybackAllocator` touches: the stETH token
 *         (balance and transfer), a revenue source whose cumulative USD is settable and can be
 *         forced to revert, and a receiver implementing the allocation callback. Each exposes
 *         setters so a test can script precise accounting scenarios.
 */

/// @notice Bare ERC20-ish stETH stand-in: enough surface for `balanceOf` and a `SafeERC20`
///         `transfer`. `mint` seeds the allocator's spendable balance.
contract StEthTokenStub {
    mapping(address => uint256) public balanceOf;

    function mint(address to_, uint256 amount_) external {
        balanceOf[to_] += amount_;
    }

    function transfer(address to_, uint256 amount_) external returns (bool) {
        balanceOf[msg.sender] -= amount_;
        balanceOf[to_] += amount_;
        return true;
    }
}

/// @notice Revenue source with a directly settable cumulative total and a revert switch, so tests
///         can drive both the accounting math and the reverting-source (non-strict sum) path.
contract RevenueSourceStub is IRevenueSource {
    uint256 private _cumulativeRevenueUSD;
    bool public reverting;

    error RevenueSourceStubReverting();

    function setCumulativeRevenueUSD(uint256 cumulativeRevenueUSD_) external {
        _cumulativeRevenueUSD = cumulativeRevenueUSD_;
    }

    function setReverting(bool reverting_) external {
        reverting = reverting_;
    }

    function getCumulativeRevenueUSD() external view returns (uint256) {
        if (reverting) revert RevenueSourceStubReverting();
        return _cumulativeRevenueUSD;
    }

    function supportsInterface(bytes4 interfaceId_) external pure returns (bool) {
        return
            interfaceId_ == type(IRevenueSource).interfaceId ||
            interfaceId_ == type(IERC165).interfaceId;
    }
}

/// @notice Allocation receiver: records each `onStEthAllocated` callback so tests can assert the
///         allocator invoked it.
contract ExecutorStub {
    uint256 public onStEthAllocatedCount;

    function onStEthAllocated() external {
        onStEthAllocatedCount += 1;
    }
}
