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
 *         All outputs are normalized to UNIT (10 ** UNIT_DECIMALS).
 */
contract OracleRouter is IOracleRouter, Ownable {
    uint8 public immutable UNIT_DECIMALS;
    uint256 public immutable UNIT;
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

    constructor(address ownerAgent, uint8 unitDecimals, address feedRegistry) Ownable(ownerAgent) {
        if (unitDecimals == 0 || unitDecimals > MAX_DECIMALS) revert InvalidUnitDecimals();
        if (feedRegistry == address(0)) revert ZeroAddress();
        if (ownerAgent == address(0)) revert ZeroAddress();

        FEED_REGISTRY = feedRegistry;
        UNIT_DECIMALS = unitDecimals;
        UNIT = 10 ** unitDecimals;
    }

    function setEthUsdBridge(uint32 maxStalenessSeconds) external onlyAgentOrManager {
        if (maxStalenessSeconds == 0) revert ZeroStaleness();

        (
            address aggregator,
            uint8 decimals,
            uint128 scaleNumerator,
            uint128 scaleDenominator
        ) = _resolveFeedAndScale(ETH_DENOMINATION, USD_DENOMINATION);

        ethUsdBridge = FeedConfig({
            aggregator: aggregator,
            maxStalenessSeconds: maxStalenessSeconds,
            aggregatorDecimals: decimals,
            scaleNumerator: scaleNumerator,
            scaleDenominator: scaleDenominator
        });

        emit EthUsdBridgeConfigured(
            aggregator,
            decimals,
            maxStalenessSeconds,
            scaleNumerator,
            scaleDenominator
        );
    }

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

    function setTokenUsdFeed(
        address tokenAddress,
        uint32 maxStalenessSeconds,
        uint8 providedTokenDecimals,
        bool isActive
    ) external onlyAgentOrManager {
        _setTokenFeed(
            tokenAddress,
            QuoteDenomination.USD,
            maxStalenessSeconds,
            providedTokenDecimals,
            isActive
        );
    }

    function setTokenEthFeed(
        address tokenAddress,
        uint32 maxStalenessSeconds,
        uint8 providedTokenDecimals,
        bool isActive
    ) external onlyAgentOrManager {
        _setTokenFeed(
            tokenAddress,
            QuoteDenomination.ETH,
            maxStalenessSeconds,
            providedTokenDecimals,
            isActive
        );
    }

    function setTokenEthUsdStalenessOverride(
        address tokenAddress,
        uint32 overrideSeconds
    ) external onlyAgentOrManager {
        if (tokenAddress == address(0)) revert ZeroAddress();
        tokenConfig[tokenAddress].ethUsdMaxStalenessOverrideSeconds = overrideSeconds;
        emit TokenEthUsdStalenessOverride(tokenAddress, overrideSeconds);
    }

    function setTokenActive(address tokenAddress, bool isActive) external onlyAgentOrManager {
        if (tokenAddress == address(0)) revert ZeroAddress();
        TokenConfig storage config = tokenConfig[tokenAddress];
        if (isActive) {
            if (config.tokenDecimals == 0 || config.primaryFeed.aggregator == address(0)) {
                revert TokenNotConfigured(tokenAddress);
            }
        }
        config.isActive = isActive;
        emit TokenActiveUpdated(tokenAddress, isActive);
    }

    function getUsdPrices(
        address baseTokenAddress,
        address quoteTokenAddress
    ) external view returns (uint256 baseUsdPrice, uint256 quoteUsdPrice) {
        TokenConfig storage baseConfig = tokenConfig[baseTokenAddress];
        TokenConfig storage quoteConfig = tokenConfig[quoteTokenAddress];

        bool baseIsEthQuoted = baseConfig.primaryQuote == QuoteDenomination.ETH;
        bool quoteIsEthQuoted = quoteConfig.primaryQuote == QuoteDenomination.ETH;

        if (baseIsEthQuoted && quoteIsEthQuoted) {
            uint32 baseCap = _effectiveEthUsdStaleness(baseConfig);
            uint32 quoteCap = _effectiveEthUsdStaleness(quoteConfig);
            if (baseCap == quoteCap) {
                uint256 ethUsd = _readEthUsdWithCap(baseCap);
                baseUsdPrice = _usdPriceWithEth(baseTokenAddress, ethUsd);
                quoteUsdPrice = _usdPriceWithEth(quoteTokenAddress, ethUsd);
                return (baseUsdPrice, quoteUsdPrice);
            }
        }

        baseUsdPrice = _usdPrice(baseTokenAddress);
        quoteUsdPrice = _usdPrice(quoteTokenAddress);
    }

    function getTokenDecimals(
        address baseTokenAddress,
        address quoteTokenAddress
    ) external view returns (uint8 baseTokenDecimals, uint8 quoteTokenDecimals) {
        baseTokenDecimals = tokenConfig[baseTokenAddress].tokenDecimals;
        if (baseTokenDecimals == 0) revert TokenNotConfigured(baseTokenAddress);

        quoteTokenDecimals = tokenConfig[quoteTokenAddress].tokenDecimals;
        if (quoteTokenDecimals == 0) revert TokenNotConfigured(quoteTokenAddress);
    }

    function getPricesAndDecimals(
        address baseTokenAddress,
        address quoteTokenAddress
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
        (baseUsdPrice, quoteUsdPrice) = this.getUsdPrices(baseTokenAddress, quoteTokenAddress);

        baseTokenDecimals = tokenConfig[baseTokenAddress].tokenDecimals;
        if (baseTokenDecimals == 0) revert TokenNotConfigured(baseTokenAddress);

        quoteTokenDecimals = tokenConfig[quoteTokenAddress].tokenDecimals;
        if (quoteTokenDecimals == 0) revert TokenNotConfigured(quoteTokenAddress);
    }

    function isBridgeInSync() external view returns (bool) {
        (address aggregator, uint8 decimals) = _currentFeedMeta(ETH_DENOMINATION, USD_DENOMINATION);
        FeedConfig storage b = ethUsdBridge;
        return (aggregator == b.aggregator && decimals == b.aggregatorDecimals);
    }

    function isFeedInSync(address tokenAddress) external view returns (bool) {
        TokenConfig storage c = tokenConfig[tokenAddress];
        if (c.tokenDecimals == 0) return false;
        address quote = c.primaryQuote == QuoteDenomination.USD
            ? USD_DENOMINATION
            : ETH_DENOMINATION;
        (address aggregator, uint8 decimals) = _currentFeedMeta(tokenAddress, quote);
        return (aggregator == c.primaryFeed.aggregator &&
            decimals == c.primaryFeed.aggregatorDecimals);
    }

    function syncTokenFeed(address tokenAddress) external onlyAgentOrManager {
        TokenConfig storage config = tokenConfig[tokenAddress];
        if (config.tokenDecimals == 0) revert TokenNotConfigured(tokenAddress);

        address quote = config.primaryQuote == QuoteDenomination.USD
            ? USD_DENOMINATION
            : ETH_DENOMINATION;
        (
            address aggregator,
            uint8 decimals,
            uint128 scaleNumerator,
            uint128 scaleDenominator
        ) = _resolveFeedAndScale(tokenAddress, quote);

        config.primaryFeed.aggregator = aggregator;
        config.primaryFeed.aggregatorDecimals = decimals;
        config.primaryFeed.scaleNumerator = scaleNumerator;
        config.primaryFeed.scaleDenominator = scaleDenominator;

        emit TokenConfigured(
            tokenAddress,
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

    function _usdPrice(address tokenAddress) internal view returns (uint256 price) {
        TokenConfig storage config = tokenConfig[tokenAddress];
        if (!config.isActive) revert TokenNotConfigured(tokenAddress);

        if (config.primaryQuote == QuoteDenomination.USD) {
            return _readNormalizedPrice(tokenAddress, USD_DENOMINATION, config.primaryFeed);
        }

        uint256 tokenToEth = _readNormalizedPrice(
            tokenAddress,
            ETH_DENOMINATION,
            config.primaryFeed
        );
        uint256 ethUsd = _readEthUsdWithCap(_effectiveEthUsdStaleness(config));
        price = Math.mulDiv(tokenToEth, ethUsd, UNIT);
    }

    function _usdPriceWithEth(
        address tokenAddress,
        uint256 ethUsd
    ) internal view returns (uint256 price) {
        TokenConfig storage config = tokenConfig[tokenAddress];
        if (!config.isActive) revert TokenNotConfigured(tokenAddress);
        if (config.primaryQuote == QuoteDenomination.USD) {
            return _readNormalizedPrice(tokenAddress, USD_DENOMINATION, config.primaryFeed);
        }
        uint256 tokenToEth = _readNormalizedPrice(
            tokenAddress,
            ETH_DENOMINATION,
            config.primaryFeed
        );
        price = Math.mulDiv(tokenToEth, ethUsd, UNIT);
    }

    function _readEthUsdWithCap(uint32 capSeconds) internal view returns (uint256) {
        FeedConfig storage bridge = ethUsdBridge;
        if (bridge.aggregatorDecimals == 0) revert EthUsdBridgeMissing();

        FeedConfig memory bridgeCopy = bridge;
        bridgeCopy.maxStalenessSeconds = capSeconds;
        return _readNormalizedPrice(ETH_DENOMINATION, USD_DENOMINATION, bridgeCopy);
    }

    function _effectiveEthUsdStaleness(TokenConfig storage config) internal view returns (uint32) {
        uint32 overrideSeconds = config.ethUsdMaxStalenessOverrideSeconds;
        if (overrideSeconds == 0) return ethUsdBridge.maxStalenessSeconds;
        return
            overrideSeconds < ethUsdBridge.maxStalenessSeconds
                ? overrideSeconds
                : ethUsdBridge.maxStalenessSeconds;
    }

    function _readNormalizedPrice(
        address baseToken,
        address quoteToken,
        FeedConfig memory feedConfig
    ) internal view returns (uint256 normalizedPrice) {
        IFeedRegistry registry = IFeedRegistry(FEED_REGISTRY);

        address liveAggregator = registry.getFeed(baseToken, quoteToken);
        uint8 liveDecimals = registry.decimals(baseToken, quoteToken);
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
            .latestRoundData(baseToken, quoteToken);

        if (rawAnswer <= 0) revert OracleBadAnswer(feedConfig.aggregator, rawAnswer);
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
            revert OracleQuantizedToZero(feedConfig.aggregator, liveDecimals, UNIT_DECIMALS);
        }
    }

    // -----------------------------------------------------------------------
    // Configuration
    // -----------------------------------------------------------------------

    function _setTokenFeed(
        address tokenAddress,
        QuoteDenomination primaryQuote,
        uint32 maxStalenessSeconds,
        uint8 providedTokenDecimals,
        bool isActive
    ) internal {
        if (tokenAddress == address(0)) revert ZeroAddress();
        if (maxStalenessSeconds == 0) revert ZeroStaleness();

        uint8 erc20Decimals = IERC20Metadata(tokenAddress).decimals();
        if (erc20Decimals == 0 || erc20Decimals > MAX_DECIMALS) revert InvalidTokenDecimals();
        if (providedTokenDecimals != 0 && providedTokenDecimals != erc20Decimals) {
            revert TokenDecimalsMismatch(erc20Decimals, providedTokenDecimals);
        }

        address quoteAddress = primaryQuote == QuoteDenomination.USD
            ? USD_DENOMINATION
            : ETH_DENOMINATION;

        (
            address aggregator,
            uint8 feedDecimals,
            uint128 scaleNumerator,
            uint128 scaleDenominator
        ) = _resolveFeedAndScale(tokenAddress, quoteAddress);

        tokenConfig[tokenAddress] = TokenConfig({
            primaryQuote: primaryQuote,
            primaryFeed: FeedConfig({
                aggregator: aggregator,
                maxStalenessSeconds: maxStalenessSeconds,
                aggregatorDecimals: feedDecimals,
                scaleNumerator: scaleNumerator,
                scaleDenominator: scaleDenominator
            }),
            tokenDecimals: erc20Decimals,
            isActive: isActive,
            ethUsdMaxStalenessOverrideSeconds: 0
        });

        emit TokenConfigured(
            tokenAddress,
            primaryQuote,
            aggregator,
            feedDecimals,
            maxStalenessSeconds,
            erc20Decimals,
            scaleNumerator,
            scaleDenominator,
            isActive
        );
    }

    function _resolveFeedAndScale(
        address baseToken,
        address quoteToken
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

        aggregator = registry.getFeed(baseToken, quoteToken);
        if (aggregator == address(0)) revert FeedMissing(baseToken, quoteToken);

        decimals = registry.decimals(baseToken, quoteToken);
        if (decimals == 0 || decimals > MAX_DECIMALS) revert InvalidAggregatorDecimals();

        (scaleNumerator, scaleDenominator) = _computeScaleFactors(decimals);
    }

    function _currentFeedMeta(
        address baseToken,
        address quoteToken
    ) internal view returns (address aggregator, uint8 decimals) {
        IFeedRegistry registry = IFeedRegistry(FEED_REGISTRY);
        aggregator = registry.getFeed(baseToken, quoteToken);
        decimals = registry.decimals(baseToken, quoteToken);
    }

    function _computeScaleFactors(
        uint8 feedDecimals
    ) internal view returns (uint128 numerator, uint128 denominator) {
        if (feedDecimals == UNIT_DECIMALS) {
            return (1, 1);
        }
        if (feedDecimals < UNIT_DECIMALS) {
            uint8 upDiff = UNIT_DECIMALS - feedDecimals;
            if (upDiff > 38) revert InvalidAggregatorDecimals();
            return (uint128(10 ** upDiff), 1);
        }
        uint8 downDiff = feedDecimals - UNIT_DECIMALS;
        if (downDiff > 38) revert InvalidAggregatorDecimals();
        return (1, uint128(10 ** downDiff));
    }
}
