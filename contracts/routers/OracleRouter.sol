// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Ownable} from "../Ownable.sol";
import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";
import {IOracleRouter} from "../interfaces/IOracleRouter.sol";
import {IFeedRegistry} from "../interfaces/IFeedRegistry.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title OracleRouter
 * @notice Chainlink-only price router with a 2-hop strategy:
 *         - TOKEN/USD feeds (preferred), or
 *         - TOKEN/ETH feeds bridged via ETH/USD.
 *         Bridge is assumed to be ETH/USD (no inversion logic).
 *         The router's fixed-point unit is configurable at deploy (UNIT_DECIMALS).
 *         Each feed stores precomputed scale factors to normalize to UNIT on read.
 *
 * @dev This version applies in-place gas/storage optimizations without changing the external/public API:
 *      - Deduplicated price retrieval logic with ETH/USD caching.
 *      - Consistent use of Math.mulDiv to avoid transient overflow and improve rounding.
 *      - Minimized repeated SLOADs and external calls within functions.
 */
contract OracleRouter is IOracleRouter, Ownable {
    uint8 public immutable UNIT_DECIMALS;
    uint256 public immutable UNIT;
    address public immutable FEED_REGISTRY;
    address private constant USD_DENOM = 0x0000000000000000000000000000000000000348;
    address private constant ETH_DENOM = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    uint128 private constant MAX_DECIMALS = 38;

    enum QuoteDenomination {
        USD,
        ETH
    }

    struct FeedConfig {
        address aggregator; // cached for observability/debugging
        uint128 scaleNumerator;
        uint128 scaleDenominator;
        uint32 maxStaleness;
        uint8 aggregatorDecimals;
    }

    struct TokenConfig {
        QuoteDenomination primaryQuote;
        FeedConfig primaryFeed;
        uint8 tokenDecimals;
        bool isActive;
    }

    mapping(address => TokenConfig) public tokenConfig;
    FeedConfig public ethUsdBridge;

    event TokenConfigured(
        address indexed token,
        QuoteDenomination primaryQuote,
        address indexed aggregator,
        uint8 aggregatorDecimals,
        uint32 maxStaleness,
        uint8 tokenDecimals,
        uint128 scaleNumerator,
        uint128 scaleDenominator,
        bool isActive
    );

    event TokenActiveUpdated(address indexed token, bool isActive);

    event EthUsdBridgeConfigured(
        address indexed aggregator,
        uint8 aggregatorDecimals,
        uint32 maxStaleness,
        uint128 scaleNumerator,
        uint128 scaleDenominator
    );

    error ZeroAddress();
    error ZeroStaleness();
    error InvalidAggregatorDecimals();
    error InvalidUnitDecimals();
    error TokenNotConfigured(address token);
    error EthUsdBridgeMissing();
    error OracleStale(address aggregator, uint256 lastUpdate);
    error OracleBadAnswer(address aggregator, int256 answer);
    error FeedMissing(address base, address quote);

    /// @notice Set immutable unit settings and ownership agent.
    /// @param agent_ Owner agent for admin controls.
    /// @param unitDecimals_ Fixed-point unit decimals used across the router.
    /// @param feedRegistry_ Chainlink Feed Registry address.
    constructor(address agent_, uint8 unitDecimals_, address feedRegistry_) Ownable(agent_) {
        if (unitDecimals_ == 0 || unitDecimals_ > MAX_DECIMALS) revert InvalidUnitDecimals();
        if (feedRegistry_ == address(0)) revert ZeroAddress();

        FEED_REGISTRY = feedRegistry_;
        UNIT_DECIMALS = unitDecimals_;
        UNIT = 10 ** unitDecimals_;
    }

    /// @notice Configure the global ETH/USD bridge feed.
    /// @param maxStaleness_ Max accepted staleness in seconds.
    function setEthUsdBridge(uint32 maxStaleness_) external onlyAgentOrManager {
        if (maxStaleness_ == 0) revert ZeroStaleness();

        IFeedRegistry registry = IFeedRegistry(FEED_REGISTRY);
        address resolvedAggregator = registry.getFeed(ETH_DENOM, USD_DENOM);
        if (resolvedAggregator == address(0)) revert FeedMissing(ETH_DENOM, USD_DENOM);

        uint8 aggregatorDecimals = registry.decimals(ETH_DENOM, USD_DENOM);
        if (aggregatorDecimals == 0 || aggregatorDecimals > MAX_DECIMALS)
            revert InvalidAggregatorDecimals();

        (uint128 scaleNumerator, uint128 scaleDenominator) = _computeScaleFactors(
            aggregatorDecimals
        );

        ethUsdBridge = FeedConfig({
            aggregator: resolvedAggregator,
            maxStaleness: maxStaleness_,
            aggregatorDecimals: aggregatorDecimals,
            scaleNumerator: scaleNumerator,
            scaleDenominator: scaleDenominator
        });

        emit EthUsdBridgeConfigured(
            resolvedAggregator,
            aggregatorDecimals,
            maxStaleness_,
            scaleNumerator,
            scaleDenominator
        );
    }

    /// @notice Configure a token with a TOKEN/USD feed.
    function setTokenUsdFeed(
        address token_,
        uint32 maxStaleness_,
        uint8 tokenDecimals_,
        bool isActive_
    ) external onlyAgentOrManager {
        _setTokenFeed(token_, QuoteDenomination.USD, maxStaleness_, tokenDecimals_, isActive_);
    }

    /// @notice Configure a token with a TOKEN/ETH feed (will bridge via ETH/USD).
    function setTokenEthFeed(
        address token_,
        uint32 maxStaleness_,
        uint8 tokenDecimals_,
        bool isActive_
    ) external onlyAgentOrManager {
        _setTokenFeed(token_, QuoteDenomination.ETH, maxStaleness_, tokenDecimals_, isActive_);
    }

    /// @notice Toggle quoting availability for a token.
    function setTokenActive(address token_, bool isActive_) external onlyAgentOrManager {
        if (token_ == address(0)) revert ZeroAddress();
        if (isActive_ && tokenConfig[token_].tokenDecimals == 0) revert TokenNotConfigured(token_);
        tokenConfig[token_].isActive = isActive_;
        emit TokenActiveUpdated(token_, isActive_);
    }

    /// @notice Return USD prices for two tokens; reuses a single ETH/USD read when possible.
    function getUsdPrices(
        address baseToken_,
        address quoteToken_
    ) external view returns (uint256 baseUsdPrice_, uint256 quoteUsdPrice_) {
        uint256 ethUsdCached;
        (baseUsdPrice_, ethUsdCached) = _usdPriceWithEthCache(baseToken_, 0);
        (quoteUsdPrice_, ) = _usdPriceWithEthCache(quoteToken_, ethUsdCached);
    }

    /// @notice Return cached ERC20 decimals for two tokens.
    function getTokenDecimals(
        address baseToken_,
        address quoteToken_
    ) external view returns (uint8 baseTokenDecimals_, uint8 quoteTokenDecimals_) {
        baseTokenDecimals_ = tokenConfig[baseToken_].tokenDecimals;
        if (baseTokenDecimals_ == 0) revert TokenNotConfigured(baseToken_);

        quoteTokenDecimals_ = tokenConfig[quoteToken_].tokenDecimals;
        if (quoteTokenDecimals_ == 0) revert TokenNotConfigured(quoteToken_);
    }

    /// @notice Return USD prices and decimals for two tokens in a single call.
    function getPricesAndDecimals(
        address baseToken_,
        address quoteToken_
    )
        external
        view
        returns (
            uint256 baseUsdPrice_,
            uint256 quoteUsdPrice_,
            uint8 baseTokenDecimals_,
            uint8 quoteTokenDecimals_
        )
    {
        uint256 ethUsdCached;
        (baseUsdPrice_, ethUsdCached) = _usdPriceWithEthCache(baseToken_, 0);
        (quoteUsdPrice_, ) = _usdPriceWithEthCache(quoteToken_, ethUsdCached);

        baseTokenDecimals_ = tokenConfig[baseToken_].tokenDecimals;
        if (baseTokenDecimals_ == 0) revert TokenNotConfigured(baseToken_);

        quoteTokenDecimals_ = tokenConfig[quoteToken_].tokenDecimals;
        if (quoteTokenDecimals_ == 0) revert TokenNotConfigured(quoteToken_);
    }

    /// @dev Returns USD price for a token and (optionally) reuses/provides ETH/USD cache.
    function _usdPriceWithEthCache(
        address token_,
        uint256 ethUsdCached_
    ) internal view returns (uint256 price_, uint256 ethUsdOut_) {
        TokenConfig storage cfg = tokenConfig[token_];
        if (!cfg.isActive) revert TokenNotConfigured(token_);

        if (cfg.primaryQuote == QuoteDenomination.USD) {
            price_ = _readNormalizedPrice(token_, USD_DENOM, cfg.primaryFeed);
            return (price_, ethUsdCached_);
        }

        // TOKEN/ETH path: ensure bridge exists and reuse cache when available.
        FeedConfig storage bridge = ethUsdBridge;
        if (bridge.aggregatorDecimals == 0) revert EthUsdBridgeMissing();

        uint256 tokenToEth = _readNormalizedPrice(token_, ETH_DENOM, cfg.primaryFeed);

        uint256 ethUsd = ethUsdCached_;
        if (ethUsd == 0) {
            ethUsd = _readNormalizedPrice(ETH_DENOM, USD_DENOM, bridge);
        }

        price_ = Math.mulDiv(tokenToEth, ethUsd, UNIT);
        return (price_, ethUsd);
    }

    function _setTokenFeed(
        address token_,
        QuoteDenomination primaryQuote_,
        uint32 maxStaleness_,
        uint8 tokenDecimals_,
        bool isActive_
    ) internal {
        if (token_ == address(0)) revert ZeroAddress();
        if (maxStaleness_ == 0) revert ZeroStaleness();

        address quote = primaryQuote_ == QuoteDenomination.USD ? USD_DENOM : ETH_DENOM;
        IFeedRegistry registry = IFeedRegistry(FEED_REGISTRY);

        address resolvedAggregator = registry.getFeed(token_, quote);
        if (resolvedAggregator == address(0)) revert FeedMissing(token_, quote);

        uint8 aggregatorDecimals = registry.decimals(token_, quote);
        if (aggregatorDecimals == 0 || aggregatorDecimals > MAX_DECIMALS)
            revert InvalidAggregatorDecimals();

        (uint128 scaleNumerator, uint128 scaleDenominator) = _computeScaleFactors(
            aggregatorDecimals
        );

        tokenConfig[token_] = TokenConfig({
            primaryQuote: primaryQuote_,
            primaryFeed: FeedConfig({
                aggregator: resolvedAggregator,
                maxStaleness: maxStaleness_,
                aggregatorDecimals: aggregatorDecimals,
                scaleNumerator: scaleNumerator,
                scaleDenominator: scaleDenominator
            }),
            tokenDecimals: tokenDecimals_,
            isActive: isActive_
        });

        emit TokenConfigured(
            token_,
            primaryQuote_,
            resolvedAggregator,
            aggregatorDecimals,
            maxStaleness_,
            tokenDecimals_,
            scaleNumerator,
            scaleDenominator,
            isActive_
        );
    }

    function _readNormalizedPrice(
        address base_,
        address quote_,
        FeedConfig storage feed_
    ) internal view returns (uint256 normalizedPrice_) {
        // Note: aggregator address stored in feed_ is for observability/events.
        // Reads are taken from FeedRegistry to ensure canonical latest data.
        IFeedRegistry registry = IFeedRegistry(FEED_REGISTRY);
        (uint80 roundId, int256 rawAnswer, , uint256 updatedAt, uint80 answeredInRound) = registry
            .latestRoundData(base_, quote_);

        if (rawAnswer <= 0) revert OracleBadAnswer(feed_.aggregator, rawAnswer);
        if (block.timestamp > updatedAt + feed_.maxStaleness || roundId > answeredInRound)
            revert OracleStale(feed_.aggregator, updatedAt);

        // Normalize: rawAnswer * scaleNumerator / scaleDenominator
        normalizedPrice_ = Math.mulDiv(
            uint256(rawAnswer),
            feed_.scaleNumerator,
            feed_.scaleDenominator
        );
    }

    function _computeScaleFactors(
        uint8 feedDecimals_
    ) internal view returns (uint128 numerator_, uint128 denominator_) {
        if (feedDecimals_ == UNIT_DECIMALS) {
            return (1, 1);
        }
        if (feedDecimals_ < UNIT_DECIMALS) {
            uint8 upDiff = UNIT_DECIMALS - feedDecimals_;
            if (upDiff > 38) revert InvalidAggregatorDecimals();
            return (uint128(10 ** upDiff), 1);
        }
        uint8 downDiff = feedDecimals_ - UNIT_DECIMALS;
        if (downDiff > 38) revert InvalidAggregatorDecimals();
        return (1, uint128(10 ** downDiff));
    }
}
