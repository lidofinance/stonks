// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {Ownable} from "../Ownable.sol";
import {IOracleRouter} from "../interfaces/IOracleRouter.sol";
import {IFeedRegistry} from "../interfaces/IFeedRegistry.sol";

/**
 * @title OracleRouter
 * @notice Price router based on Chainlink Feed Registry with two hop options:
 *         - TOKEN/USD (preferred), or
 *         - TOKEN/ETH bridged via ETH/USD.
 *         All outputs are normalized to PRICE_UNIT (10 ** PRICE_DECIMALS).
 */
contract OracleRouter is IOracleRouter, Ownable {
    // ==================== Immutables ====================

    /// @notice Number of decimals used for price normalization (typically 8 or 18).
    uint8 public immutable PRICE_DECIMALS;
    /// @notice Price unit calculated as 10 ** PRICE_DECIMALS.
    uint256 public immutable PRICE_UNIT;
    /// @notice Address of the Chainlink Feed Registry contract.
    address public immutable FEED_REGISTRY;

    // ==================== Constants ====================

    /// @notice Address representing USD denomination in Chainlink Feed Registry.
    address private constant USD_DENOMINATION = 0x0000000000000000000000000000000000000348;
    /// @notice Address representing ETH denomination in Chainlink Feed Registry.
    address private constant ETH_DENOMINATION = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /// @notice Maximum supported decimals for feeds and tokens.
    uint128 public constant MAX_DECIMALS = 38;

    // ==================== Type Definitions ====================

    struct FeedConfig {
        address aggregator;
        uint128 scaleNumerator;
        uint128 scaleDenominator;
        uint32 maxStalenessSeconds;
        uint8 aggregatorDecimals;
    }

    struct TokenConfig {
        IOracleRouter.QuoteDenomination primaryQuote;
        FeedConfig primaryFeed;
        uint8 tokenDecimals;
        bool isActive;
        uint32 ethUsdMaxStalenessOverrideSeconds; // 0 => use global bridge staleness
    }

    // ==================== Storage Variables ====================

    /// @notice Mapping from token address to its price feed configuration.
    mapping(address => TokenConfig) public tokenConfig;
    /// @notice Configuration for the ETH/USD bridge feed used for tokens quoted in ETH.
    FeedConfig public ethUsdBridge;

    // ==================== Events ====================

    event TokenConfigured(
        address indexed token,
        IOracleRouter.QuoteDenomination primaryQuote,
        address indexed aggregator,
        uint8 aggregatorDecimals,
        uint32 maxStalenessSeconds,
        uint8 tokenDecimals,
        uint128 scaleNumerator,
        uint128 scaleDenominator,
        bool isActive
    );
    event TokenActiveUpdated(address indexed token, bool isActive);
    event EthUsdBridgeConfigured(
        address indexed aggregator,
        uint8 aggregatorDecimals,
        uint32 maxStalenessSeconds,
        uint128 scaleNumerator,
        uint128 scaleDenominator
    );
    event TokenEthUsdStalenessOverridden(address indexed token, uint32 overrideSeconds);

    // ==================== Errors ====================

    error InvalidFeedRegistryAddress(address feedRegistry);
    error InvalidTokenAddress(address token);
    error InvalidStaleness();
    error InvalidAggregatorDecimals();
    error InvalidUnitDecimals();
    error InvalidTokenDecimals();
    error TokenNotConfigured(address token);
    error TokenDecimalsMismatch(uint8 erc20Decimals, uint8 providedDecimals);
    error TokenStateUnchanged(address token, bool currentState);
    error EthUsdBridgeMissing();
    error FeedMissing(address base, address quote);
    error FeedConfigOutOfSync(
        address expectedAggregator,
        address actualAggregator,
        uint8 expectedDecimals,
        uint8 actualDecimals
    );
    error OracleStale(address aggregator, uint256 lastUpdate);
    error OracleBadAnswer(address aggregator, int256 answer);
    error OracleUnanswered(address aggregator, uint80 roundId, uint80 answeredInRound);
    error OracleQuantizedToZero(address aggregator, uint8 feedDecimals, uint8 unitDecimals);
    error TokenNotEthQuoted(address token);
    error TokenNotUsdQuoted(address token);

    // ==================== Constructor ====================

    /**
     * @notice Constructor
     * @param agent_ Address of the owner agent.
     * @param unitDecimals_ Number of decimals for price normalization.
     * @param feedRegistry_ Address of the Chainlink Feed Registry.
     */
    constructor(address agent_, uint8 unitDecimals_, address feedRegistry_) Ownable(agent_) {
        if (unitDecimals_ == 0 || unitDecimals_ > MAX_DECIMALS) {
            revert InvalidUnitDecimals();
        }
        if (feedRegistry_ == address(0)) {
            revert InvalidFeedRegistryAddress(feedRegistry_);
        }

        FEED_REGISTRY = feedRegistry_;
        PRICE_DECIMALS = unitDecimals_;
        PRICE_UNIT = 10 ** unitDecimals_;
    }

    // ==================== External Functions ====================

    /**
     * @notice Sets the ETH/USD bridge configuration for token price routing.
     * @param maxStalenessSeconds_ Maximum allowed staleness for ETH/USD price feed.
     */
    function setEthUsdBridge(uint32 maxStalenessSeconds_) external onlyAgentOrManager {
        if (maxStalenessSeconds_ == 0) {
            revert InvalidStaleness();
        }

        _updateEthUsdBridge(maxStalenessSeconds_);
    }

    /**
     * @notice Synchronizes the ETH/USD bridge configuration with current feed registry state.
     * @dev Preserves the existing staleness threshold while updating feed metadata.
     */
    function syncEthUsdBridge() external onlyAgentOrManager {
        _updateEthUsdBridge(ethUsdBridge.maxStalenessSeconds);
    }

    /**
     * @notice Sets the feed configuration for a token.
     * @param token_ Address of the token to configure.
     * @param primaryQuote_ Primary quote denomination (USD or ETH).
     * @param maxStalenessSeconds_ Maximum allowed staleness for the price feed.
     * @param tokenDecimals_ Number of decimals for the token.
     * @param isActive_ Whether the token should be active for price queries.
     */
    function setTokenFeed(
        address token_,
        IOracleRouter.QuoteDenomination primaryQuote_,
        uint32 maxStalenessSeconds_,
        uint8 tokenDecimals_,
        bool isActive_
    ) external onlyAgentOrManager {
        _setTokenFeed(token_, primaryQuote_, maxStalenessSeconds_, tokenDecimals_, isActive_);
    }

    /**
     * @notice Sets a custom staleness override for ETH/USD bridge when used for a specific token.
     * @param token_ Address of the token to configure.
     * @param overrideSeconds_ Custom staleness threshold for this token's ETH/USD bridge usage.
     */
    function setTokenEthUsdStalenessOverride(
        address token_,
        uint32 overrideSeconds_
    ) external onlyAgentOrManager {
        if (token_ == address(0)) {
            revert InvalidTokenAddress(token_);
        }

        tokenConfig[token_].ethUsdMaxStalenessOverrideSeconds = overrideSeconds_;

        emit TokenEthUsdStalenessOverridden(token_, overrideSeconds_);
    }

    /**
     * @notice Sets the active status of a token configuration.
     * @param token_ Address of the token to configure.
     * @param isActive_ Whether the token should be active for price queries.
     */
    function setTokenActive(address token_, bool isActive_) external onlyAgentOrManager {
        if (token_ == address(0)) {
            revert InvalidTokenAddress(token_);
        }

        TokenConfig storage config = tokenConfig[token_];

        if (config.isActive == isActive_) {
            revert TokenStateUnchanged(token_, config.isActive);
        }

        if (isActive_) {
            if (config.tokenDecimals == 0) {
                revert TokenNotConfigured(token_);
            }
        }

        config.isActive = isActive_;
        emit TokenActiveUpdated(token_, isActive_);
    }

    /**
     * @notice Synchronizes a token's feed configuration with current feed registry state.
     * @param token_ Address of the token to synchronize.
     */
    function syncTokenFeed(address token_) external onlyAgentOrManager {
        TokenConfig storage config = tokenConfig[token_];

        if (config.tokenDecimals == 0) {
            revert TokenNotConfigured(token_);
        }

        address quote;
        if (config.primaryQuote == IOracleRouter.QuoteDenomination.USD) {
            quote = USD_DENOMINATION;
        } else {
            quote = ETH_DENOMINATION;
        }
        (
            address aggregator,
            uint8 decimals,
            uint128 scaleNumerator,
            uint128 scaleDenominator
        ) = _resolveFeedAndScale(token_, quote);

        config.primaryFeed.aggregator = aggregator;
        config.primaryFeed.aggregatorDecimals = decimals;
        config.primaryFeed.scaleNumerator = scaleNumerator;
        config.primaryFeed.scaleDenominator = scaleDenominator;

        emit TokenConfigured(
            token_,
            config.primaryQuote,
            aggregator,
            decimals,
            config.primaryFeed.maxStalenessSeconds,
            config.tokenDecimals,
            scaleNumerator,
            scaleDenominator,
            config.isActive
        );
    }

    // ==================== External View Functions ====================

    /**
     * @notice Gets USD prices for two tokens.
     * @param baseToken_ Address of the base token.
     * @param quoteToken_ Address of the quote token.
     * @return baseUsdPrice USD price of the base token.
     * @return quoteUsdPrice USD price of the quote token.
     */
    function getUsdPrices(
        address baseToken_,
        address quoteToken_
    ) external view returns (uint256 baseUsdPrice, uint256 quoteUsdPrice) {
        return _getUsdPrices(baseToken_, quoteToken_);
    }

    /**
     * @notice Gets prices and decimal places for two tokens with the same quote denomination.
     * @dev Both tokens must be configured with the same primary quote denomination (USD or ETH).
     * @param baseToken_ Address of the base token.
     * @param quoteToken_ Address of the quote token.
     * @param quote_ Expected quote denomination (USD or ETH) for both tokens.
     * @return basePrice Price of the base token (normalized to PRICE_UNIT).
     * @return quotePrice Price of the quote token (normalized to PRICE_UNIT).
     * @return baseTokenDecimals Number of decimals for the base token.
     * @return quoteTokenDecimals Number of decimals for the quote token.
     */
    function getPricesAndDecimals(
        address baseToken_,
        address quoteToken_,
        IOracleRouter.QuoteDenomination quote_
    )
        external
        view
        returns (
            uint256 basePrice,
            uint256 quotePrice,
            uint8 baseTokenDecimals,
            uint8 quoteTokenDecimals
        )
    {
        TokenConfig storage baseConfig = tokenConfig[baseToken_];
        baseTokenDecimals = baseConfig.tokenDecimals;

        if (baseTokenDecimals == 0 || !baseConfig.isActive) {
            revert TokenNotConfigured(baseToken_);
        }

        if (baseConfig.primaryQuote != quote_) {
            if (quote_ == IOracleRouter.QuoteDenomination.USD) {
                revert TokenNotUsdQuoted(baseToken_);
            } else {
                revert TokenNotEthQuoted(baseToken_);
            }
        }

        TokenConfig storage quoteConfig = tokenConfig[quoteToken_];
        quoteTokenDecimals = quoteConfig.tokenDecimals;

        if (quoteTokenDecimals == 0 || !quoteConfig.isActive) {
            revert TokenNotConfigured(quoteToken_);
        }

        if (quoteConfig.primaryQuote != quote_) {
            if (quote_ == IOracleRouter.QuoteDenomination.USD) {
                revert TokenNotUsdQuoted(quoteToken_);
            } else {
                revert TokenNotEthQuoted(quoteToken_);
            }
        }

        if (quote_ == IOracleRouter.QuoteDenomination.USD) {
            (basePrice, quotePrice) = _getUsdPrices(baseToken_, quoteToken_);
        } else {
            // Read ETH prices directly (no USD conversion)
            basePrice = _readNormalizedPrice(baseToken_, ETH_DENOMINATION, baseConfig.primaryFeed);
            quotePrice = _readNormalizedPrice(
                quoteToken_,
                ETH_DENOMINATION,
                quoteConfig.primaryFeed
            );
        }
    }

    /**
     * @notice Checks if the ETH/USD bridge configuration is synchronized with the feed registry.
     * @return True if the bridge configuration matches the current feed registry state.
     */
    function isBridgeInSync() external view returns (bool) {
        (address aggregator, uint8 decimals) = _currentFeedMeta(ETH_DENOMINATION, USD_DENOMINATION);
        FeedConfig storage b = ethUsdBridge;

        return (aggregator == b.aggregator && decimals == b.aggregatorDecimals);
    }

    /**
     * @notice Checks if a token's feed configuration is synchronized with the feed registry.
     * @param token_ Address of the token to check.
     * @return True if the token configuration matches the current feed registry state.
     */
    function isFeedInSync(address token_) external view returns (bool) {
        TokenConfig storage c = tokenConfig[token_];

        if (c.tokenDecimals == 0) {
            return false;
        }

        address quote;
        if (c.primaryQuote == IOracleRouter.QuoteDenomination.USD) {
            quote = USD_DENOMINATION;
        } else {
            quote = ETH_DENOMINATION;
        }

        (address aggregator, uint8 decimals) = _currentFeedMeta(token_, quote);

        return (aggregator == c.primaryFeed.aggregator &&
            decimals == c.primaryFeed.aggregatorDecimals);
    }

    // ==================== Internal Functions ====================

    /**
     * @dev Updates ETH/USD bridge configuration. Consolidates logic for setEthUsdBridge and syncEthUsdBridge.
     * @param maxStalenessSeconds_ Maximum allowed staleness for ETH/USD price feed.
     */
    function _updateEthUsdBridge(uint32 maxStalenessSeconds_) internal {
        (
            address aggregator,
            uint8 decimals,
            uint128 scaleNumerator,
            uint128 scaleDenominator
        ) = _resolveFeedAndScale(ETH_DENOMINATION, USD_DENOMINATION);

        ethUsdBridge = FeedConfig({
            aggregator: aggregator,
            maxStalenessSeconds: maxStalenessSeconds_,
            aggregatorDecimals: decimals,
            scaleNumerator: scaleNumerator,
            scaleDenominator: scaleDenominator
        });

        emit EthUsdBridgeConfigured(
            aggregator,
            decimals,
            maxStalenessSeconds_,
            scaleNumerator,
            scaleDenominator
        );
    }

    /**
     * @dev Gets USD price for a token. Optimized to accept pre-fetched ethUsd to avoid redundant reads.
     * @param token_ Address of the token to price.
     * @param ethUsd_ Pre-fetched ETH/USD price, or 0 to fetch internally (prices are never 0).
     * @return price USD price of the token, normalized to PRICE_UNIT.
     */
    function _getUsdPrice(address token_, uint256 ethUsd_) internal view returns (uint256 price) {
        TokenConfig storage config = tokenConfig[token_];

        if (!config.isActive) {
            revert TokenNotConfigured(token_);
        }

        if (config.primaryQuote == IOracleRouter.QuoteDenomination.USD) {
            return _readNormalizedPrice(token_, USD_DENOMINATION, config.primaryFeed);
        }

        // Token is ETH-quoted, need to bridge via ETH/USD
        uint256 tokenToEth = _readNormalizedPrice(token_, ETH_DENOMINATION, config.primaryFeed);

        // Use provided ethUsd or fetch if not provided (0 means fetch)
        uint256 ethUsdPrice;
        if (ethUsd_ != 0) {
            ethUsdPrice = ethUsd_;
        } else {
            ethUsdPrice = _readEthUsdWithCap(_effectiveEthUsdStaleness(config));
        }

        price = Math.mulDiv(tokenToEth, ethUsdPrice, PRICE_UNIT);
    }

    /**
     * @dev Gets USD prices for two tokens with gas optimization for shared ETH/USD bridge.
     * When both tokens are ETH-quoted with same staleness cap, fetches ETH/USD once.
     */
    function _getUsdPrices(
        address baseToken_,
        address quoteToken_
    ) internal view returns (uint256 baseUsdPrice, uint256 quoteUsdPrice) {
        TokenConfig storage baseConfig = tokenConfig[baseToken_];
        TokenConfig storage quoteConfig = tokenConfig[quoteToken_];

        // Gas optimization: if both tokens are ETH-quoted with same staleness, fetch ETH/USD once
        if (
            baseConfig.primaryQuote == IOracleRouter.QuoteDenomination.ETH &&
            quoteConfig.primaryQuote == IOracleRouter.QuoteDenomination.ETH
        ) {
            uint32 baseCap = _effectiveEthUsdStaleness(baseConfig);
            uint32 quoteCap = _effectiveEthUsdStaleness(quoteConfig);

            if (baseCap == quoteCap) {
                uint256 ethUsd = _readEthUsdWithCap(baseCap);
                baseUsdPrice = _getUsdPrice(baseToken_, ethUsd);
                quoteUsdPrice = _getUsdPrice(quoteToken_, ethUsd);
                return (baseUsdPrice, quoteUsdPrice);
            }
        }

        // Fallback: fetch prices independently (0 = fetch internally)
        baseUsdPrice = _getUsdPrice(baseToken_, 0);
        quoteUsdPrice = _getUsdPrice(quoteToken_, 0);
    }

    function _readEthUsdWithCap(uint32 capSeconds_) internal view returns (uint256) {
        FeedConfig storage bridge = ethUsdBridge;

        if (bridge.aggregatorDecimals == 0) {
            revert EthUsdBridgeMissing();
        }

        FeedConfig memory bridgeCopy = bridge;
        bridgeCopy.maxStalenessSeconds = capSeconds_;

        return _readNormalizedPrice(ETH_DENOMINATION, USD_DENOMINATION, bridgeCopy);
    }

    function _effectiveEthUsdStaleness(TokenConfig storage config) internal view returns (uint32) {
        uint32 overrideSeconds = config.ethUsdMaxStalenessOverrideSeconds;
        uint32 maxStaleness = ethUsdBridge.maxStalenessSeconds;

        if (overrideSeconds == 0) {
            return maxStaleness;
        }

        if (overrideSeconds < maxStaleness) {
            return overrideSeconds;
        } else {
            return maxStaleness;
        }
    }

    function _readNormalizedPrice(
        address baseToken_,
        address quoteToken_,
        FeedConfig memory feedConfig_
    ) internal view returns (uint256 normalizedPrice) {
        IFeedRegistry registry = IFeedRegistry(FEED_REGISTRY);

        address liveAggregator = registry.getFeed(baseToken_, quoteToken_);
        uint8 liveDecimals = registry.decimals(baseToken_, quoteToken_);

        if (
            liveAggregator != feedConfig_.aggregator ||
            liveDecimals != feedConfig_.aggregatorDecimals
        ) {
            revert FeedConfigOutOfSync(
                feedConfig_.aggregator,
                liveAggregator,
                feedConfig_.aggregatorDecimals,
                liveDecimals
            );
        }

        (uint80 roundId, int256 rawAnswer, , uint256 updatedAt, uint80 answeredInRound) = registry
            .latestRoundData(baseToken_, quoteToken_);

        if (rawAnswer <= 0) {
            revert OracleBadAnswer(feedConfig_.aggregator, rawAnswer);
        }
        if (answeredInRound < roundId) {
            revert OracleUnanswered(feedConfig_.aggregator, roundId, answeredInRound);
        }
        if (block.timestamp - updatedAt > feedConfig_.maxStalenessSeconds) {
            revert OracleStale(feedConfig_.aggregator, updatedAt);
        }

        (uint128 scaleNumerator, uint128 scaleDenominator) = _computeScaleFactors(liveDecimals);

        normalizedPrice = Math.mulDiv(uint256(rawAnswer), scaleNumerator, scaleDenominator);

        if (normalizedPrice == 0) {
            revert OracleQuantizedToZero(feedConfig_.aggregator, liveDecimals, PRICE_DECIMALS);
        }
    }

    function _setTokenFeed(
        address token_,
        IOracleRouter.QuoteDenomination primaryQuote_,
        uint32 maxStalenessSeconds_,
        uint8 tokenDecimals_,
        bool isActive_
    ) internal {
        if (token_ == address(0)) {
            revert InvalidTokenAddress(token_);
        }
        if (maxStalenessSeconds_ == 0) {
            revert InvalidStaleness();
        }

        uint8 erc20Decimals = IERC20Metadata(token_).decimals();

        if (erc20Decimals == 0 || erc20Decimals > MAX_DECIMALS) {
            revert InvalidTokenDecimals();
        }
        if (tokenDecimals_ != 0 && tokenDecimals_ != erc20Decimals) {
            revert TokenDecimalsMismatch(erc20Decimals, tokenDecimals_);
        }

        address quote;
        if (primaryQuote_ == IOracleRouter.QuoteDenomination.USD) {
            quote = USD_DENOMINATION;
        } else {
            quote = ETH_DENOMINATION;
        }

        (
            address aggregator,
            uint8 feedDecimals,
            uint128 scaleNumerator,
            uint128 scaleDenominator
        ) = _resolveFeedAndScale(token_, quote);

        tokenConfig[token_] = TokenConfig({
            primaryQuote: primaryQuote_,
            primaryFeed: FeedConfig({
                aggregator: aggregator,
                maxStalenessSeconds: maxStalenessSeconds_,
                aggregatorDecimals: feedDecimals,
                scaleNumerator: scaleNumerator,
                scaleDenominator: scaleDenominator
            }),
            tokenDecimals: erc20Decimals,
            isActive: isActive_,
            ethUsdMaxStalenessOverrideSeconds: 0
        });

        emit TokenConfigured(
            token_,
            primaryQuote_,
            aggregator,
            feedDecimals,
            maxStalenessSeconds_,
            erc20Decimals,
            scaleNumerator,
            scaleDenominator,
            isActive_
        );
    }

    function _resolveFeedAndScale(
        address baseToken_,
        address quoteToken_
    )
        internal
        view
        returns (
            address aggregator,
            uint8 decimals,
            uint128 scaleNumerator,
            uint128 scaleDenominator
        )
    {
        IFeedRegistry registry = IFeedRegistry(FEED_REGISTRY);

        aggregator = registry.getFeed(baseToken_, quoteToken_);

        if (aggregator == address(0)) {
            revert FeedMissing(baseToken_, quoteToken_);
        }

        decimals = registry.decimals(baseToken_, quoteToken_);

        if (decimals == 0 || decimals > MAX_DECIMALS) {
            revert InvalidAggregatorDecimals();
        }

        (scaleNumerator, scaleDenominator) = _computeScaleFactors(decimals);
    }

    function _currentFeedMeta(
        address baseToken_,
        address quoteToken_
    ) internal view returns (address aggregator, uint8 decimals) {
        IFeedRegistry registry = IFeedRegistry(FEED_REGISTRY);

        aggregator = registry.getFeed(baseToken_, quoteToken_);
        decimals = registry.decimals(baseToken_, quoteToken_);
    }

    function _computeScaleFactors(
        uint8 feedDecimals_
    ) internal view returns (uint128 numerator, uint128 denominator) {
        if (feedDecimals_ == PRICE_DECIMALS) {
            return (1, 1);
        }

        if (feedDecimals_ < PRICE_DECIMALS) {
            uint8 upDiff = PRICE_DECIMALS - feedDecimals_;

            if (upDiff > MAX_DECIMALS) {
                revert InvalidAggregatorDecimals();
            }

            return (uint128(10 ** upDiff), 1);
        }

        uint8 downDiff = feedDecimals_ - PRICE_DECIMALS;

        if (downDiff > MAX_DECIMALS) {
            revert InvalidAggregatorDecimals();
        }

        return (1, uint128(10 ** downDiff));
    }
}
