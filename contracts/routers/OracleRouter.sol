// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Ownable} from "../Ownable.sol";
import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";
import {IOracleRouter} from "../interfaces/IOracleRouter.sol";

/**
 * @title OracleRouter
 * @notice Chainlink-only price router with a 2-hop strategy:
 *         - TOKEN/USD feeds (preferred), or
 *         - TOKEN/ETH feeds bridged via ETH/USD.
 *         Bridge is assumed to be ETH/USD (no inversion logic).
 *         The router's fixed-point unit is configurable at deploy (UNIT_DECIMALS).
 *         Each feed stores precomputed scale factors to normalize to UNIT on read.
 */
contract OracleRouter is IOracleRouter, Ownable {
    uint8 public immutable UNIT_DECIMALS;
    uint256 public immutable UNIT;

    uint128 private constant MAX_DECIMALS = 38;

    enum QuoteDenomination {
        USD,
        ETH
    }

    struct FeedConfig {
        uint128 scaleNumerator;
        uint128 scaleDenominator;
        address aggregator;
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
    error TokenNotConfigured(address token);
    error EthUsdBridgeMissing();
    error OracleStale(address aggregator, uint256 lastUpdate);
    error OracleBadAnswer(address aggregator, int256 answer);

    /// @notice Set immutable unit settings and ownership agent.
    /// @param agent_ Owner agent for admin controls.
    /// @param unitDecimals_ Fixed-point unit decimals used across the router.
    constructor(address agent_, uint8 unitDecimals_) Ownable(agent_) {
        if (unitDecimals_ == 0) {
            revert InvalidAggregatorDecimals();
        }

        UNIT_DECIMALS = unitDecimals_;
        UNIT = 10 ** unitDecimals_;
    }

    /// @notice Configure the global ETH/USD bridge feed.
    /// @param aggregator_ Chainlink ETH/USD aggregator address.
    /// @param maxStaleness_ Max accepted staleness in seconds.
    function setEthUsdBridge(
        address aggregator_,
        uint32 maxStaleness_
    ) external onlyAgentOrManager {
        if (aggregator_ == address(0)) {
            revert ZeroAddress();
        }
        if (maxStaleness_ == 0) {
            revert ZeroStaleness();
        }

        uint8 aggregatorDecimals = IAggregatorV3(aggregator_).decimals();
        if (aggregatorDecimals == 0 || aggregatorDecimals > MAX_DECIMALS) {
            revert InvalidAggregatorDecimals();
        }

        (uint128 scaleNumerator, uint128 scaleDenominator) = _computeScaleFactors(
            aggregatorDecimals
        );

        ethUsdBridge = FeedConfig({
            aggregator: aggregator_,
            maxStaleness: maxStaleness_,
            aggregatorDecimals: aggregatorDecimals,
            scaleNumerator: scaleNumerator,
            scaleDenominator: scaleDenominator
        });

        emit EthUsdBridgeConfigured(
            aggregator_,
            aggregatorDecimals,
            maxStaleness_,
            scaleNumerator,
            scaleDenominator
        );
    }

    /// @notice Configure a token with a TOKEN/USD feed.
    /// @param token_ ERC20 token address.
    /// @param aggregator_ Chainlink TOKEN/USD aggregator.
    /// @param maxStaleness_ Max accepted staleness in seconds.
    /// @param tokenDecimals_ Cached ERC20 decimals for the token.
    /// @param isActive_ Whether this token is quotable.
    function setTokenUsdFeed(
        address token_,
        address aggregator_,
        uint32 maxStaleness_,
        uint8 tokenDecimals_,
        bool isActive_
    ) external onlyAgentOrManager {
        _setTokenFeed(
            token_,
            QuoteDenomination.USD,
            aggregator_,
            maxStaleness_,
            tokenDecimals_,
            isActive_
        );
    }

    /// @notice Configure a token with a TOKEN/ETH feed (will bridge via ETH/USD).
    /// @param token_ ERC20 token address.
    /// @param aggregator_ Chainlink TOKEN/ETH aggregator.
    /// @param maxStaleness_ Max accepted staleness in seconds.
    /// @param tokenDecimals_ Cached ERC20 decimals for the token.
    /// @param isActive_ Whether this token is quotable.
    function setTokenEthFeed(
        address token_,
        address aggregator_,
        uint32 maxStaleness_,
        uint8 tokenDecimals_,
        bool isActive_
    ) external onlyAgentOrManager {
        _setTokenFeed(
            token_,
            QuoteDenomination.ETH,
            aggregator_,
            maxStaleness_,
            tokenDecimals_,
            isActive_
        );
    }

    /// @notice Toggle quoting availability for a token.
    /// @param token_ ERC20 token address.
    /// @param isActive_ New active flag value.
    function setTokenActive(address token_, bool isActive_) external onlyAgentOrManager {
        if (token_ == address(0)) {
            revert ZeroAddress();
        }
        
        tokenConfig[token_].isActive = isActive_;
        emit TokenActiveUpdated(token_, isActive_);
    }

    /// @notice Return the USD price for a token in router UNIT.
    /// @param token_ ERC20 token address.
    /// @return usdPrice_ Price in UNIT decimals.
    function getUsdPrice(address token_) external view returns (uint256 usdPrice_) {
        TokenConfig storage config = tokenConfig[token_];
        if (!config.isActive) {
            revert TokenNotConfigured(token_);
        }

        if (config.primaryQuote == QuoteDenomination.USD) {
            usdPrice_ = _readNormalizedPrice(config.primaryFeed);
        } else {
            if (ethUsdBridge.aggregator == address(0)) {
                revert EthUsdBridgeMissing();
            }
            uint256 tokenToEth = _readNormalizedPrice(config.primaryFeed);
            uint256 ethToUsd = _readNormalizedPrice(ethUsdBridge);
            usdPrice_ = (tokenToEth * ethToUsd) / UNIT;
        }
    }

    /// @notice Return USD prices for two tokens; reuses a single ETH/USD read when possible.
    /// @param baseToken_ First token address.
    /// @param quoteToken_ Second token address.
    /// @return baseUsdPrice_ USD price of baseToken_ in UNIT.
    /// @return quoteUsdPrice_ USD price of quoteToken_ in UNIT.
    function getUsdPrices(
        address baseToken_,
        address quoteToken_
    ) external view returns (uint256 baseUsdPrice_, uint256 quoteUsdPrice_) {
        TokenConfig storage baseCfg = tokenConfig[baseToken_];
        TokenConfig storage quoteCfg = tokenConfig[quoteToken_];
        if (!baseCfg.isActive) {
            revert TokenNotConfigured(baseToken_);
        }
        if (!quoteCfg.isActive) {
            revert TokenNotConfigured(quoteToken_);
        }

        uint256 ethUsdCached = 0;

        // Base
        if (baseCfg.primaryQuote == QuoteDenomination.USD) {
            baseUsdPrice_ = _readNormalizedPrice(baseCfg.primaryFeed);
        } else {
            if (ethUsdBridge.aggregator == address(0)) {
                revert EthUsdBridgeMissing();
            }
            ethUsdCached = _readNormalizedPrice(ethUsdBridge);
            baseUsdPrice_ = (_readNormalizedPrice(baseCfg.primaryFeed) * ethUsdCached) / UNIT;
        }

        // Quote (reuse ETH/USD if already fetched)
        if (quoteCfg.primaryQuote == QuoteDenomination.USD) {
            quoteUsdPrice_ = _readNormalizedPrice(quoteCfg.primaryFeed);
        } else {
            if (ethUsdCached == 0) {
                if (ethUsdBridge.aggregator == address(0)) {
                    revert EthUsdBridgeMissing();
                }
                ethUsdCached = _readNormalizedPrice(ethUsdBridge);
            }
            quoteUsdPrice_ = (_readNormalizedPrice(quoteCfg.primaryFeed) * ethUsdCached) / UNIT;
        }
    }

    /// @notice Return cached ERC20 decimals for a token.
    /// @param token_ ERC20 token address.
    /// @return decimals_ Cached decimals value.
    function tokenDecimalsOf(address token_) external view returns (uint8 decimals_) {
        decimals_ = tokenConfig[token_].tokenDecimals;
    }

    /// @notice Return cached ERC20 decimals for two tokens.
    /// @param baseToken_ First token address.
    /// @param quoteToken_ Second token address.
    /// @return baseTokenDecimals_ Decimals for baseToken_.
    /// @return quoteTokenDecimals_ Decimals for quoteToken_.
    function getTokenDecimals(
        address baseToken_,
        address quoteToken_
    ) external view returns (uint8 baseTokenDecimals_, uint8 quoteTokenDecimals_) {
        baseTokenDecimals_ = tokenConfig[baseToken_].tokenDecimals;
        quoteTokenDecimals_ = tokenConfig[quoteToken_].tokenDecimals;
    }

    function _setTokenFeed(
        address token_,
        QuoteDenomination primaryQuote_,
        address aggregator_,
        uint32 maxStaleness_,
        uint8 tokenDecimals_,
        bool isActive_
    ) internal {
        if (token_ == address(0) || aggregator_ == address(0)) {
            revert ZeroAddress();
        }
        if (maxStaleness_ == 0) {
            revert ZeroStaleness();
        }

        uint8 aggregatorDecimals = IAggregatorV3(aggregator_).decimals();
        if (aggregatorDecimals == 0 || aggregatorDecimals > MAX_DECIMALS) {
            revert InvalidAggregatorDecimals();
        }

        (uint128 scaleNumerator, uint128 scaleDenominator) = _computeScaleFactors(
            aggregatorDecimals
        );

        tokenConfig[token_] = TokenConfig({
            primaryQuote: primaryQuote_,
            primaryFeed: FeedConfig({
                aggregator: aggregator_,
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
            aggregator_,
            aggregatorDecimals,
            maxStaleness_,
            tokenDecimals_,
            scaleNumerator,
            scaleDenominator,
            isActive_
        );
    }

    function _readNormalizedPrice(
        FeedConfig storage feed_
    ) internal view returns (uint256 normalizedPrice_) {
        (, int256 rawAnswer, , uint256 updatedAt, ) = IAggregatorV3(feed_.aggregator)
            .latestRoundData();
        if (rawAnswer <= 0) {
            revert OracleBadAnswer(feed_.aggregator, rawAnswer);
        }
        if (block.timestamp > updatedAt + feed_.maxStaleness) {
            revert OracleStale(feed_.aggregator, updatedAt);
        }
        normalizedPrice_ = (uint256(rawAnswer) * feed_.scaleNumerator) / feed_.scaleDenominator;
    }

    function _computeScaleFactors(
        uint8 feedDecimals_
    ) internal view returns (uint128 numerator_, uint128 denominator_) {
        if (feedDecimals_ == UNIT_DECIMALS) {
            return (1, 1);
        }

        if (feedDecimals_ < UNIT_DECIMALS) {
            return (uint128(10 ** (UNIT_DECIMALS - feedDecimals_)), 1);
        }

        return (1, uint128(10 ** (feedDecimals_ - UNIT_DECIMALS)));
    }
}
