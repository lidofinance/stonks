// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.23;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IRevenueSource} from "../interfaces/IRevenueSource.sol";

/**
 * @title BuybackAllocator stubs
 * @notice Minimal test doubles for the dependencies `BuybackAllocator` touches: the stETH token
 *         (balance and transfer), a revenue source whose cumulative USD is settable and can be
 *         forced to revert, an oracle router with a configurable price unit, and receivers
 *         implementing the allocation callback. Each exposes setters so a test can script precise
 *         accounting scenarios.
 */

/// @notice Bare ERC20-ish stETH stand-in: enough surface for `balanceOf` and a `SafeERC20`
///         `transfer`. `mint` seeds the allocator's spendable balance, and `setFailTransfers`
///         makes `transfer` report failure so tests can drive the transfer-revert path.
contract StEthTokenStub {
    mapping(address => uint256) public balanceOf;
    bool public failTransfers;

    function mint(address to_, uint256 amount_) external {
        balanceOf[to_] += amount_;
    }

    function setFailTransfers(bool failTransfers_) external {
        failTransfers = failTransfers_;
    }

    function transfer(address to_, uint256 amount_) external returns (bool) {
        if (failTransfers) return false;
        balanceOf[msg.sender] -= amount_;
        balanceOf[to_] += amount_;
        return true;
    }
}

/// @notice Revenue source with a directly settable cumulative total and a revert switch, so tests
///         can drive both the accounting math and the unreachable-source revert path.
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

/// @notice Allocation receiver that re-enters `allocate()` inside the callback, so a test can drive
///         the `nonReentrant` guard on the allocator.
contract ReentrantExecutorStub {
    function onStEthAllocated() external {
        IAllocate(msg.sender).allocate();
    }
}

/// @notice Allocation receiver whose callback always reverts, so a test can assert the whole
///         allocation rolls back when the hook fails.
contract RevertingExecutorStub {
    error RevertingExecutorStubFailure();

    function onStEthAllocated() external pure {
        revert RevertingExecutorStubFailure();
    }
}

/// @notice Allocation receiver that records its own stETH balance inside the callback and emits a
///         marker event, so a test can assert the transfer and the `Allocated` event happen before
///         the hook runs.
contract ObservingExecutorStub {
    StEthTokenStub public immutable STETH;
    uint256 public balanceInHook;

    event HookObserved(uint256 balance);

    constructor(StEthTokenStub stEth_) {
        STETH = stEth_;
    }

    function onStEthAllocated() external {
        balanceInHook = STETH.balanceOf(address(this));
        emit HookObserved(balanceInHook);
    }
}

/// @notice Oracle router stand-in with a configurable `PRICE_UNIT`, so a test can assert the
///         allocator converts USD to stETH at the unit it reads from the router at deployment.
contract ScaledOracleRouterStub {
    uint256 public immutable PRICE_UNIT;
    uint256 public usdPrice;

    constructor(uint256 priceUnit_) {
        PRICE_UNIT = priceUnit_;
    }

    function setUsdPrice(uint256 usdPrice_) external {
        usdPrice = usdPrice_;
    }

    function getUsdPrices(address, address) external view returns (uint256, uint256) {
        return (usdPrice, usdPrice);
    }
}

interface IAllocate {
    function allocate() external;
}
