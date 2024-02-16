// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IFeedRegistry} from "../interfaces/IFeedRegistry.sol";

import {ManageableStub} from "./ManageableStub.sol";

/// @title Stub for the Chainlink's Feed Registry contract
/// @notice Contract is supposed to be used with the AmountConverter contract
///     to return preset answers.
contract ChainlinkFeedRegistryStub is IFeedRegistry, ManageableStub {
    struct FeedStub {
        uint80 roundId;
        uint80 answeredInRound;
        uint8 decimals;
        uint256 startedAt;
        uint256 updatedAt;
        int256 answer;
    }

    mapping(address base => mapping(address quote => FeedStub feed)) public feeds;

    constructor(address owner_, address manager_) ManageableStub(owner_, manager_) {}

    function getFeed(address, address) external view returns (address) {
        return address(this);
    }

    function decimals(address base, address quote) external view returns (uint8) {
        return feeds[base][quote].decimals;
    }

    function latestRoundData(
        address base,
        address quote
    )
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        FeedStub memory feed = feeds[base][quote];

        answer = feed.answer;
        roundId = feed.roundId;
        answeredInRound = feed.answeredInRound;
        startedAt = feed.startedAt == 0 ? block.timestamp : feed.startedAt;
        updatedAt = feed.updatedAt == 0 ? block.timestamp : feed.updatedAt;
    }

    function setFeed(address base, address quote, FeedStub calldata feed) external onlyManager {
        feeds[base][quote] = feed;
        emit FeedSet(base, quote, feed);
    }

    event FeedSet(address base, address quote, FeedStub feed);
}
