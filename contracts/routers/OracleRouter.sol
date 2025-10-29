// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Ownable} from "../Ownable.sol";
import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";
import {IOracleRouter} from "../interfaces/IOracleRouter.sol";
import {IFeedRegistry} from "../interfaces/IFeedRegistry.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title OracleRouter
 * @notice Price router based on Chainlink Feed Registry with two hop options:
 *         - TOKEN/USD (preferred), or
 *         - TOKEN/ETH bridged via ETH/USD.
 *         All outputs are normalized to PRICE_UNIT (10 ** PRICE_DECIMALS).
 */
contract OracleRouter is IOracleRouter, Ownable {
    uint8 public immutable PRICE_DECIMALS;
    uint256 public immutable PRICE_UNIT;
    address public immutable FEED_REGISTRY;

    address private constant USD_DENOMINATION = 0x0000000000000000000000000000000000000348;
    address private constant ETH_DENOMINATION = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    uint128 private constant MAX_DECIMALS = 38;

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

    mapping(address => TokenConfig) public tokenConfig;
    FeedConfig public ethUsdBridge;

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

    event TokenEthUsdStalenessOverride(address indexed token, uint32 overrideSeconds);

    error ZeroAddress();
    error ZeroStaleness();
    error InvalidAggregatorDecimals();
    error InvalidUnitDecimals();
    error InvalidTokenDecimals();
    error TokenNotConfigured(address token);
    error EthUsdBridgeMissing();
    error OracleStale(address aggregator, uint256 lastUpdate);
    error OracleBadAnswer(address aggregator, int256 answer);
    error OracleUnanswered(address aggregator, uint80 roundId, uint80 answeredInRound);
    error OracleQuantizedToZero(address aggregator, uint8 feedDecimals, uint8 unitDecimals);
    error FeedMissing(address base, address quote);
    error FeedConfigOutOfSync(
        address expectedAggregator,
        address actualAggregator,
        uint8 expectedDecimals,
        uint8 actualDecimals
    );
    error TokenDecimalsMismatch(uint8 erc20Decimals, uint8 providedDecimals);

    constructor(address ownerAgent_, uint8 unitDecimals_, address feedRegistry_) Ownable(ownerAgent_) {
        if (unitDecimals_ == 0 || unitDecimals_ > MAX_DECIMALS) {
            revert InvalidUnitDecimals();
        }
        if (feedRegistry_ == address(0)) {
            revert ZeroAddress();
        }
        if (ownerAgent_ == address(0)) {
            revert ZeroAddress();
        }

        FEED_REGISTRY = feedRegistry_;
        PRICE_DECIMALS = unitDecimals_;
        PRICE_UNIT = 10 ** unitDecimals_;
    }

    /**
     * @notice Sets the ETH/USD bridge configuration for token price routing.
     * @param maxStalenessSeconds_ Maximum allowed staleness for ETH/USD price feed.
     */
    function setEthUsdBridge(uint32 maxStalenessSeconds_) external onlyAgentOrManager {
        if (maxStalenessSeconds_ == 0) {
            revert ZeroStaleness();
        }

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
     * @notice Synchronizes the ETH/USD bridge configuration with current feed registry state.
     */
    function syncEthUsdBridge() external onlyAgentOrManager {
        (
            address aggregator,
            uint8 decimals,
            uint128 scaleNumerator,
            uint128 scaleDenominator
        ) = _resolveFeedAndScale(ETH_DENOMINATION, USD_DENOMINATION);

        uint32 staleness = ethUsdBridge.maxStalenessSeconds;

        ethUsdBridge = FeedConfig({
            aggregator: aggregator,
            maxStalenessSeconds: staleness,
            aggregatorDecimals: decimals,
            scaleNumerator: scaleNumerator,
            scaleDenominator: scaleDenominator
        });

        emit EthUsdBridgeConfigured(
            aggregator,
            decimals,
            staleness,
            scaleNumerator,
            scaleDenominator
        );
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
            revert ZeroAddress();
        }
        tokenConfig[tokenAddress_].ethUsdMaxStalenessOverrideSeconds = overrideSeconds_;
        emit TokenEthUsdStalenessOverride(tokenAddress_, overrideSeconds_);
    }

    /**
     * @notice Sets the active status of a token configuration.
     * @param tokenAddress_ Address of the token to configure.
     * @param isActive_ Whether the token should be active for price queries.
     */
    function setTokenActive(address tokenAddress_, bool isActive_) external onlyAgentOrManager {
        if (tokenAddress_ == address(0)) {
            revert ZeroAddress();
        }
        TokenConfig storage config = tokenConfig[tokenAddress_];
        if (isActive_) {
            if (config.tokenDecimals == 0 || config.primaryFeed.aggregator == address(0)) {
                revert TokenNotConfigured(tokenAddress_);
            }
        }
        config.isActive = isActive_;
        emit TokenActiveUpdated(tokenAddress_, isActive_);
    }

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
        TokenConfig storage baseConfig = tokenConfig[baseTokenAddress_];
        TokenConfig storage quoteConfig = tokenConfig[quoteTokenAddress_];

        bool baseIsEthQuoted = baseConfig.primaryQuote == QuoteDenomination.ETH;
        bool quoteIsEthQuoted = quoteConfig.primaryQuote == QuoteDenomination.ETH;

        if (baseIsEthQuoted && quoteIsEthQuoted) {
            uint32 baseCap = _effectiveEthUsdStaleness(baseConfig);
            uint32 quoteCap = _effectiveEthUsdStaleness(quoteConfig);
            if (baseCap == quoteCap) {
                uint256 ethUsd = _readEthUsdWithCap(baseCap);
                baseUsdPrice = _usdPriceWithEth(baseTokenAddress_, ethUsd);
                quoteUsdPrice = _usdPriceWithEth(quoteTokenAddress_, ethUsd);
                return (baseUsdPrice, quoteUsdPrice);
            }
        }

        baseUsdPrice = _usdPrice(baseTokenAddress_);
        quoteUsdPrice = _usdPrice(quoteTokenAddress_);
    }

    /**
     * @notice Gets the decimal places for two tokens.
     * @param baseTokenAddress_ Address of the base token.
     * @param quoteTokenAddress_ Address of the quote token.
     * @return baseTokenDecimals Number of decimals for the base token.
     * @return quoteTokenDecimals Number of decimals for the quote token.
     */
    function getTokenDecimals(
        address baseTokenAddress_,
        address quoteTokenAddress_
    ) external view returns (uint8 baseTokenDecimals, uint8 quoteTokenDecimals) {
        baseTokenDecimals = tokenConfig[baseTokenAddress_].tokenDecimals;
        if (baseTokenDecimals == 0) {
            revert TokenNotConfigured(baseTokenAddress_);
        }

        quoteTokenDecimals = tokenConfig[quoteTokenAddress_].tokenDecimals;
        if (quoteTokenDecimals == 0) {
            revert TokenNotConfigured(quoteTokenAddress_);
        }
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
    function getPricesAndDecimals(
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
        (baseUsdPrice, quoteUsdPrice) = this.getUsdPrices(baseTokenAddress_, quoteTokenAddress_);

        baseTokenDecimals = tokenConfig[baseTokenAddress_].tokenDecimals;
        if (baseTokenDecimals == 0) {
            revert TokenNotConfigured(baseTokenAddress_);
        }

        quoteTokenDecimals = tokenConfig[quoteTokenAddress_].tokenDecimals;
        if (quoteTokenDecimals == 0) {
            revert TokenNotConfigured(quoteTokenAddress_);
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

    // -----------------------------------------------------------------------
    // Pricing
    // -----------------------------------------------------------------------

    function _usdPrice(address tokenAddress_) internal view returns (uint256 price) {
        TokenConfig storage config = tokenConfig[tokenAddress_];
        if (!config.isActive) {
            revert TokenNotConfigured(tokenAddress_);
        }

        if (config.primaryQuote == QuoteDenomination.USD) {
            return _readNormalizedPrice(tokenAddress_, USD_DENOMINATION, config.primaryFeed);
        }

        uint256 tokenToEth = _readNormalizedPrice(
            tokenAddress_,
            ETH_DENOMINATION,
            config.primaryFeed
        );
        uint256 ethUsd = _readEthUsdWithCap(_effectiveEthUsdStaleness(config));
        price = Math.mulDiv(tokenToEth, ethUsd, PRICE_UNIT);
    }

    function _usdPriceWithEth(
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
        uint256 tokenToEth = _readNormalizedPrice(
            tokenAddress_,
            ETH_DENOMINATION,
            config.primaryFeed
        );
        price = Math.mulDiv(tokenToEth, ethUsd, PRICE_UNIT);
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
        if (answeredInRound < roundId)
            revert OracleUnanswered(feedConfig.aggregator, roundId, answeredInRound);

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

    // -----------------------------------------------------------------------
    // Configuration
    // -----------------------------------------------------------------------

    function _setTokenFeed(
        address tokenAddress_,
        QuoteDenomination primaryQuote_,
        uint32 maxStalenessSeconds_,
        uint8 providedTokenDecimals_,
        bool isActive_
    ) internal {
        if (tokenAddress_ == address(0)) {
            revert ZeroAddress();
        }
        if (maxStalenessSeconds_ == 0) {
            revert ZeroStaleness();
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
