// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IFeedRegistry} from "../interfaces/IFeedRegistry.sol";

contract FeedRegistryTest {
    address public immutable FEED_REGISTRY;
    uint256 public heartbeat;

    constructor(address feedRegistry_) {
        FEED_REGISTRY = feedRegistry_;
    }

    function setHeartbeat(uint256 heartbeat_) external {
        heartbeat = heartbeat_;
    }

    function getFeed(address base, address quote) external view returns (address) {
        return IFeedRegistry(FEED_REGISTRY).getFeed(base, quote);
    }

    function decimals(address base, address quote) external view returns (uint8) {
        return IFeedRegistry(FEED_REGISTRY).decimals(base, quote);
    }

    function latestRoundData(address base, address quote)
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        (roundId, answer, startedAt, updatedAt, answeredInRound) =
            IFeedRegistry(FEED_REGISTRY).latestRoundData(base, quote);

        if (heartbeat != 0) {
            updatedAt = block.timestamp - heartbeat;
        }
    }
}
