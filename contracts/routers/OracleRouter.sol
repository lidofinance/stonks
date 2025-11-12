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

    address private constant USD_DENOMINATION = 0x0000000000000000000000000000000000000348;
    address private constant ETH_DENOMINATION = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    uint128 private constant MAX_DECIMALS = 38;

    // ==================== Type Definitions ====================

    enum QuoteDenomination {
        USD,
        ETH
    }

    struct FeedConfig {
        address aggregator;
        uint128 scaleNumerator;
        uint128 scaleDenominator;
        uint32 maxStalenessSeconds;
        uint8 aggregatorDecimals;
    }

    struct TokenConfig {
        QuoteDenomination primaryQuote;
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
        QuoteDenomination primaryQuote,
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
     * @notice Sets the USD feed configuration for a token.
     * @param tokenAddress_ Address of the token to configure.
     * @param maxStalenessSeconds_ Maximum allowed staleness for the price feed.
     * @param providedTokenDecimals_ Number of decimals for the token.
     * @param isActive_ Whether the token should be active for price queries.
     */
    function setTokenUsdFeed(
        address tokenAddress_,
        uint32 maxStalenessSeconds_,
        uint8 providedTokenDecimals_,
        bool isActive_
    ) external onlyAgentOrManager {
        _setTokenFeed(
            tokenAddress_,
            QuoteDenomination.USD,
            maxStalenessSeconds_,
            providedTokenDecimals_,
            isActive_
        );
    }

    /**
     * @notice Sets the ETH feed configuration for a token.
     * @param tokenAddress_ Address of the token to configure.
     * @param maxStalenessSeconds_ Maximum allowed staleness for the price feed.
     * @param providedTokenDecimals_ Number of decimals for the token.
     * @param isActive_ Whether the token should be active for price queries.
     */
    function setTokenEthFeed(
        address tokenAddress_,
        uint32 maxStalenessSeconds_,
        uint8 providedTokenDecimals_,
        bool isActive_
    ) external onlyAgentOrManager {
        _setTokenFeed(
            tokenAddress_,
            QuoteDenomination.ETH,
            maxStalenessSeconds_,
            providedTokenDecimals_,
            isActive_
        );
    }

    /**
     * @notice Sets a custom staleness override for ETH/USD bridge when used for a specific token.
     * @param tokenAddress_ Address of the token to configure.
     * @param overrideSeconds_ Custom staleness threshold for this token's ETH/USD bridge usage.
     */
    function setTokenEthUsdStalenessOverride(
        address tokenAddress_,
        uint32 overrideSeconds_
    ) external onlyAgentOrManager {
        if (tokenAddress_ == address(0)) {
            revert InvalidTokenAddress(tokenAddress_);
        }

        tokenConfig[tokenAddress_].ethUsdMaxStalenessOverrideSeconds = overrideSeconds_;
        emit TokenEthUsdStalenessOverridden(tokenAddress_, overrideSeconds_);
    }

    /**
     * @notice Sets the active status of a token configuration.
     * @param tokenAddress_ Address of the token to configure.
     * @param isActive_ Whether the token should be active for price queries.
     */
    function setTokenActive(address tokenAddress_, bool isActive_) external onlyAgentOrManager {
        if (tokenAddress_ == address(0)) {
            revert InvalidTokenAddress(tokenAddress_);
        }

        TokenConfig storage config = tokenConfig[tokenAddress_];

        if (config.isActive == isActive_) {
            revert TokenStateUnchanged(tokenAddress_, config.isActive);
        }

        if (isActive_) {
            if (config.tokenDecimals == 0) {
                revert TokenNotConfigured(tokenAddress_);
            }
        }

        config.isActive = isActive_;
        emit TokenActiveUpdated(tokenAddress_, isActive_);
    }

    /**
     * @notice Synchronizes a token's feed configuration with current feed registry state.
     * @param tokenAddress_ Address of the token to synchronize.
     */
    function syncTokenFeed(address tokenAddress_) external onlyAgentOrManager {
        TokenConfig storage config = tokenConfig[tokenAddress_];

        if (config.tokenDecimals == 0) {
            revert TokenNotConfigured(tokenAddress_);
        }

        address quote = config.primaryQuote == QuoteDenomination.USD
            ? USD_DENOMINATION
            : ETH_DENOMINATION;
        (
            address aggregator,
            uint8 decimals,
            uint128 scaleNumerator,
            uint128 scaleDenominator
        ) = _resolveFeedAndScale(tokenAddress_, quote);

        config.primaryFeed.aggregator = aggregator;
        config.primaryFeed.aggregatorDecimals = decimals;
        config.primaryFeed.scaleNumerator = scaleNumerator;
        config.primaryFeed.scaleDenominator = scaleDenominator;

        emit TokenConfigured(
            tokenAddress_,
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
     * @param baseTokenAddress_ Address of the base token.
     * @param quoteTokenAddress_ Address of the quote token.
     * @return baseUsdPrice USD price of the base token.
     * @return quoteUsdPrice USD price of the quote token.
     */
    function getUsdPrices(
        address baseTokenAddress_,
        address quoteTokenAddress_
    ) external view returns (uint256 baseUsdPrice, uint256 quoteUsdPrice) {
        return _getUsdPrices(baseTokenAddress_, quoteTokenAddress_);
    }

    /**
     * @notice Gets USD prices and decimal places for two tokens.
     * @param baseTokenAddress_ Address of the base token.
     * @param quoteTokenAddress_ Address of the quote token.
     * @return baseUsdPrice USD price of the base token.
     * @return quoteUsdPrice USD price of the quote token.
     * @return baseTokenDecimals Number of decimals for the base token.
     * @return quoteTokenDecimals Number of decimals for the quote token.
     */
    function getUsdPricesAndDecimals(
        address baseTokenAddress_,
        address quoteTokenAddress_
    )
        external
        view
        returns (
            uint256 baseUsdPrice,
            uint256 quoteUsdPrice,
            uint8 baseTokenDecimals,
            uint8 quoteTokenDecimals
        )
    {
        TokenConfig storage baseConfig = tokenConfig[baseTokenAddress_];
        baseTokenDecimals = baseConfig.tokenDecimals;

        if (baseTokenDecimals == 0 || !baseConfig.isActive) {
            revert TokenNotConfigured(baseTokenAddress_);
        }
        if (baseConfig.primaryQuote != QuoteDenomination.USD) {
            revert TokenNotUsdQuoted(baseTokenAddress_);
        }

        TokenConfig storage quoteConfig = tokenConfig[quoteTokenAddress_];
        quoteTokenDecimals = quoteConfig.tokenDecimals;

        if (quoteTokenDecimals == 0 || !quoteConfig.isActive) {
            revert TokenNotConfigured(quoteTokenAddress_);
        }
        if (quoteConfig.primaryQuote != QuoteDenomination.USD) {
            revert TokenNotUsdQuoted(quoteTokenAddress_);
        }

        (baseUsdPrice, quoteUsdPrice) = _getUsdPrices(baseTokenAddress_, quoteTokenAddress_);
    }

    /**
     * @notice Gets ETH-denominated prices and decimal places for two ETH-quoted tokens.
     * @dev Both tokens must be configured with ETH as primary quote denomination.
     *      Gas-optimized alternative to getUsdPricesAndDecimals for ETH-quoted pairs.
     * @param baseTokenAddress_ Address of the base token.
     * @param quoteTokenAddress_ Address of the quote token.
     * @return baseEthPrice ETH price of the base token (normalized to PRICE_UNIT).
     * @return quoteEthPrice ETH price of the quote token (normalized to PRICE_UNIT).
     * @return baseTokenDecimals Number of decimals for the base token.
     * @return quoteTokenDecimals Number of decimals for the quote token.
     */
    function getEthPricesAndDecimals(
        address baseTokenAddress_,
        address quoteTokenAddress_
    )
        external
        view
        returns (
            uint256 baseEthPrice,
            uint256 quoteEthPrice,
            uint8 baseTokenDecimals,
            uint8 quoteTokenDecimals
        )
    {
        TokenConfig storage baseConfig = tokenConfig[baseTokenAddress_];
        baseTokenDecimals = baseConfig.tokenDecimals;

        if (baseTokenDecimals == 0 || !baseConfig.isActive) {
            revert TokenNotConfigured(baseTokenAddress_);
        }
        if (baseConfig.primaryQuote != QuoteDenomination.ETH) {
            revert TokenNotEthQuoted(baseTokenAddress_);
        }

        TokenConfig storage quoteConfig = tokenConfig[quoteTokenAddress_];
        quoteTokenDecimals = quoteConfig.tokenDecimals;

        if (quoteConfig.tokenDecimals == 0 || !quoteConfig.isActive) {
            revert TokenNotConfigured(quoteTokenAddress_);
        }
        if (quoteConfig.primaryQuote != QuoteDenomination.ETH) {
            revert TokenNotEthQuoted(quoteTokenAddress_);
        }

        // Read ETH prices directly (no USD conversion)
        baseEthPrice = _readNormalizedPrice(
            baseTokenAddress_,
            ETH_DENOMINATION,
            baseConfig.primaryFeed
        );
        quoteEthPrice = _readNormalizedPrice(
            quoteTokenAddress_,
            ETH_DENOMINATION,
            quoteConfig.primaryFeed
        );

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
     * @param tokenAddress_ Address of the token to check.
     * @return True if the token configuration matches the current feed registry state.
     */
    function isFeedInSync(address tokenAddress_) external view returns (bool) {
        TokenConfig storage c = tokenConfig[tokenAddress_];

        if (c.tokenDecimals == 0) {
            return false;
        }

        address quote = c.primaryQuote == QuoteDenomination.USD
            ? USD_DENOMINATION
            : ETH_DENOMINATION;
        (address aggregator, uint8 decimals) = _currentFeedMeta(tokenAddress_, quote);
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
     * @param tokenAddress_ Address of the token to price.
     * @param ethUsd Pre-fetched ETH/USD price, or 0 to fetch internally (prices are never 0).
     * @return price USD price of the token, normalized to PRICE_UNIT.
     */
    function _getUsdPrice(
        address tokenAddress_,
        uint256 ethUsd
    ) internal view returns (uint256 price) {
        TokenConfig storage config = tokenConfig[tokenAddress_];

        if (!config.isActive) {
            revert TokenNotConfigured(tokenAddress_);
        }

        if (config.primaryQuote == QuoteDenomination.USD) {
            return _readNormalizedPrice(tokenAddress_, USD_DENOMINATION, config.primaryFeed);
        }

        // Token is ETH-quoted, need to bridge via ETH/USD
        uint256 tokenToEth = _readNormalizedPrice(
            tokenAddress_,
            ETH_DENOMINATION,
            config.primaryFeed
        );

        // Use provided ethUsd or fetch if not provided (0 means fetch)
        uint256 ethUsdPrice = ethUsd != 0
            ? ethUsd
            : _readEthUsdWithCap(_effectiveEthUsdStaleness(config));

        price = Math.mulDiv(tokenToEth, ethUsdPrice, PRICE_UNIT);
    }

    /**
     * @dev Gets USD prices for two tokens with gas optimization for shared ETH/USD bridge.
     * When both tokens are ETH-quoted with same staleness cap, fetches ETH/USD once.
     */
    function _getUsdPrices(
        address baseTokenAddress_,
        address quoteTokenAddress_
    ) internal view returns (uint256 baseUsdPrice, uint256 quoteUsdPrice) {
        TokenConfig storage baseConfig = tokenConfig[baseTokenAddress_];
        TokenConfig storage quoteConfig = tokenConfig[quoteTokenAddress_];

        bool baseIsEthQuoted = baseConfig.primaryQuote == QuoteDenomination.ETH;
        bool quoteIsEthQuoted = quoteConfig.primaryQuote == QuoteDenomination.ETH;

        // Gas optimization: if both tokens are ETH-quoted with same staleness, fetch ETH/USD once
        if (baseIsEthQuoted && quoteIsEthQuoted) {
            uint32 baseCap = _effectiveEthUsdStaleness(baseConfig);
            uint32 quoteCap = _effectiveEthUsdStaleness(quoteConfig);
            if (baseCap == quoteCap) {
                uint256 ethUsd = _readEthUsdWithCap(baseCap);
                baseUsdPrice = _getUsdPrice(baseTokenAddress_, ethUsd);
                quoteUsdPrice = _getUsdPrice(quoteTokenAddress_, ethUsd);
                return (baseUsdPrice, quoteUsdPrice);
            }
        }

        // Fallback: fetch prices independently (0 = fetch internally)
        baseUsdPrice = _getUsdPrice(baseTokenAddress_, 0);
        quoteUsdPrice = _getUsdPrice(quoteTokenAddress_, 0);
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

        if (overrideSeconds == 0) {
            return ethUsdBridge.maxStalenessSeconds;
        }
        return
            overrideSeconds < ethUsdBridge.maxStalenessSeconds
                ? overrideSeconds
                : ethUsdBridge.maxStalenessSeconds;
    }

    function _readNormalizedPrice(
        address baseToken_,
        address quoteToken_,
        FeedConfig memory feedConfig
    ) internal view returns (uint256 normalizedPrice) {
        IFeedRegistry registry = IFeedRegistry(FEED_REGISTRY);

        address liveAggregator = registry.getFeed(baseToken_, quoteToken_);
        uint8 liveDecimals = registry.decimals(baseToken_, quoteToken_);

        if (
            liveAggregator != feedConfig.aggregator || liveDecimals != feedConfig.aggregatorDecimals
        ) {
            revert FeedConfigOutOfSync(
                feedConfig.aggregator,
                liveAggregator,
                feedConfig.aggregatorDecimals,
                liveDecimals
            );
        }

        (uint80 roundId, int256 rawAnswer, , uint256 updatedAt, uint80 answeredInRound) = registry
            .latestRoundData(baseToken_, quoteToken_);

        if (rawAnswer <= 0) {
            revert OracleBadAnswer(feedConfig.aggregator, rawAnswer);
        }

        if (answeredInRound < roundId) {
            revert OracleUnanswered(feedConfig.aggregator, roundId, answeredInRound);
        }

        unchecked {
            if (block.timestamp - updatedAt > feedConfig.maxStalenessSeconds) {
                revert OracleStale(feedConfig.aggregator, updatedAt);
            }
        }

        (uint128 scaleNumerator, uint128 scaleDenominator) = _computeScaleFactors(liveDecimals);

        normalizedPrice = Math.mulDiv(uint256(rawAnswer), scaleNumerator, scaleDenominator);

        if (normalizedPrice == 0) {
            revert OracleQuantizedToZero(feedConfig.aggregator, liveDecimals, PRICE_DECIMALS);
        }
    }

    function _setTokenFeed(
        address tokenAddress_,
        QuoteDenomination primaryQuote_,
        uint32 maxStalenessSeconds_,
        uint8 providedTokenDecimals_,
        bool isActive_
    ) internal {
        if (tokenAddress_ == address(0)) {
            revert InvalidTokenAddress(tokenAddress_);
        }
        if (maxStalenessSeconds_ == 0) {
            revert InvalidStaleness();
        }

        uint8 erc20Decimals = IERC20Metadata(tokenAddress_).decimals();

        if (erc20Decimals == 0 || erc20Decimals > MAX_DECIMALS) {
            revert InvalidTokenDecimals();
        }

        if (providedTokenDecimals_ != 0 && providedTokenDecimals_ != erc20Decimals) {
            revert TokenDecimalsMismatch(erc20Decimals, providedTokenDecimals_);
        }

        address quoteAddress = primaryQuote_ == QuoteDenomination.USD
            ? USD_DENOMINATION
            : ETH_DENOMINATION;

        (
            address aggregator,
            uint8 feedDecimals,
            uint128 scaleNumerator,
            uint128 scaleDenominator
        ) = _resolveFeedAndScale(tokenAddress_, quoteAddress);

        tokenConfig[tokenAddress_] = TokenConfig({
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
            tokenAddress_,
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

            if (upDiff > 38) {
                revert InvalidAggregatorDecimals();
            }
            return (uint128(10 ** upDiff), 1);
        }

        uint8 downDiff = feedDecimals_ - PRICE_DECIMALS;

        if (downDiff > 38) {
            revert InvalidAggregatorDecimals();
        }
        return (1, uint128(10 ** downDiff));
    }
}
