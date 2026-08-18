import os
import random
from typing import Dict, List, Optional, Tuple, Union, NamedTuple

from wake.testing import *
from wake.testing.fuzzing import *
from pytypes.contracts.AmountConverter import AmountConverter
from pytypes.contracts.Order import Order
from pytypes.contracts.Stonks import Stonks
from pytypes.contracts.routers.OracleRouter import OracleRouter
from pytypes.tests.AggregatorV2V3Interface import AggregatorV2V3Interface
from pytypes.contracts.interfaces.ICoWSwapSettlement import ICoWSwapSettlement
from pytypes.contracts.interfaces.IFeedRegistry import IFeedRegistry
from pytypes.contracts.interfaces.IOracleRouter import IOracleRouter
from pytypes.openzeppelin.contracts.token.ERC20.extensions.IERC20Metadata import IERC20Metadata


CHAINLINK_FEED_REGISTRY = Address("0x47Fb2585D2C56Fe188D0E6ec628a38b74fCeeeDf")
USD_DENOMINATION = Address("0x0000000000000000000000000000000000000348")
STETH = Address("0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84")
DAI = Address("0x6B175474E89094C44Da98b954EedeAC495271d0F")
USDT = Address("0xdAC17F958D2ee523a2206206994597C13D831ec7")
USDC = Address("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
COW_SETTLEMENT = Address("0x9008D19f58AAbD9eD0D60971565AA8510560ab41")
COW_VAULT_RELAYER = Address("0xC92E8bdf79f0507f65a392b0ab4667716BFE0110")

SELL_TOKENS = [STETH, DAI, USDT, USDC]
BUY_TOKENS = [DAI, USDT, USDC]

MAX_BASIS_POINTS = 10_000
# Stonks caps margin, tolerance and improvement at 10%.
BASIS_POINTS_PARAMETERS_LIMIT = 1_000
# OracleRouter normalizes every feed answer to 1e18.
PRICE_DECIMALS = 18
PRICE_UNIT = 10**PRICE_DECIMALS
# Order tolerates a 2 wei mismatch on both amounts and 1e18-scaled prices.
AMOUNT_EQUALITY_TOLERANCE = 2
MIN_POSSIBLE_BALANCE = 10
UINT256_MAX = 2**256 - 1
ERC1271_MAGIC_VALUE = bytes.fromhex("1626ba7e")


def mint(token: Union[Address, Account], to: Union[Address, Account], amount: int):
    if isinstance(token, Account):
        token = token.address
    if isinstance(to, Account):
        to = to.address

    if token == DAI:
        total_supply_slot = 1
        balance_slot = int.from_bytes(keccak256(Abi.encode(["address", "uint256"], [to, 2])), byteorder="big")
    elif token == USDC:
        total_supply_slot = 11
        balance_slot = int.from_bytes(keccak256(Abi.encode(["address", "uint256"], [to, 9])), byteorder="big")
    elif token == USDT:
        total_supply_slot = 1
        balance_slot = int.from_bytes(keccak256(Abi.encode(["address", "uint256"], [to, 2])), byteorder="big")
    elif token == STETH:
        # stETH, mint shares instead of balance
        total_supply_slot = 0xe3b4b636e601189b5f4c6742edf2538ac12bb61ed03e6da26949d69838fa447e
        balance_slot = int.from_bytes(keccak256(Abi.encode(["address", "uint256"], [to, 0])), byteorder="big")
    else:
        raise ValueError(f"Unknown token {token}")

    old_total_supply = int.from_bytes(default_chain.chain_interface.get_storage_at(str(token), total_supply_slot), byteorder="big")
    default_chain.chain_interface.set_storage_at(str(token), total_supply_slot, (old_total_supply + amount).to_bytes(32, "big"))

    old_balance = int.from_bytes(default_chain.chain_interface.get_storage_at(str(token), balance_slot), byteorder="big")
    default_chain.chain_interface.set_storage_at(str(token), balance_slot, (old_balance + amount).to_bytes(32, "big"))


def normalize_price(raw_answer: int, feed_decimals: int) -> int:
    """Mirror of OracleRouter._readNormalizedPrice scaling to PRICE_UNIT."""
    if feed_decimals == PRICE_DECIMALS:
        return raw_answer
    if feed_decimals < PRICE_DECIMALS:
        return raw_answer * 10 ** (PRICE_DECIMALS - feed_decimals)
    return raw_answer // 10 ** (feed_decimals - PRICE_DECIMALS)


class AggregatorData(NamedTuple):
    round_id: int
    price: int
    timestamp: int


class StonksTest(FuzzTest):
    admin: Account
    manager: Account
    agent: Account
    oracle_router: OracleRouter
    amount_converter: AmountConverter
    stonks: Dict[Tuple[Address, Address], Stonks]
    chainlink_aggregators: Dict[Address, Account]
    feed_decimals: Dict[Address, int]
    aggregator_data: Dict[Account, AggregatorData]
    max_staleness: Dict[Address, int]

    order_duration: int
    margin_basis_points: int
    price_tolerance_basis_points: int
    max_improvement_basis_points: int

    def pre_sequence(self):
        self.admin = default_chain.accounts[0]
        self.manager = default_chain.accounts[1]
        self.agent = Account.new()

        self.order_duration = random_int(60, 60 * 60 * 24)
        self.margin_basis_points = random_int(0, BASIS_POINTS_PARAMETERS_LIMIT, edge_values_prob=0.33)
        self.price_tolerance_basis_points = random_int(0, BASIS_POINTS_PARAMETERS_LIMIT, edge_values_prob=0.33)
        # `uint256.max` disables the improvement cap, 0 is strict mode; both are distinct code paths.
        self.max_improvement_basis_points = random.choice(
            [0, UINT256_MAX, random_int(1, BASIS_POINTS_PARAMETERS_LIMIT)]
        )

        registry = IFeedRegistry(CHAINLINK_FEED_REGISTRY)

        self.oracle_router = OracleRouter.deploy(self.admin, CHAINLINK_FEED_REGISTRY)

        self.max_staleness = {}
        self.chainlink_aggregators = {}
        self.feed_decimals = {}
        self.aggregator_data = {}

        for token in SELL_TOKENS:
            self.max_staleness[token] = random_int(60, 60 * 60 * 24)
            self.oracle_router.setTokenFeed(
                token,
                IOracleRouter.QuoteDenomination.USD,
                self.max_staleness[token],
                True,
                from_=self.admin,
            )

            aggregator = Account(registry.getFeed(token, USD_DENOMINATION))
            self.chainlink_aggregators[token] = aggregator
            self.feed_decimals[token] = registry.decimals(token, USD_DENOMINATION)

            round_id: int = read_storage_variable(aggregator, "s_hotVars", keys=["latestAggregatorRoundId"])  # pyright: ignore reportGeneralTypeIssues
            _, price, _, updated_at, _ = AggregatorV2V3Interface(aggregator).latestRoundData()
            self.aggregator_data[aggregator] = AggregatorData(round_id, price, updated_at)

            _, registry_price, _, _, _ = registry.latestRoundData(token, USD_DENOMINATION)
            assert registry_price == price

            self._update_aggregator_price(aggregator, price + 1)

        # USD anchor: every token is configured with a USD primary quote, so no ETH/USD bridge hop.
        self.amount_converter = AmountConverter.deploy(
            self.oracle_router,
            SELL_TOKENS,
            BUY_TOKENS,
            False,
        )

        sample_order = Order.deploy(
            self.admin,
            self.agent,
            COW_VAULT_RELAYER,
            ICoWSwapSettlement(COW_SETTLEMENT).domainSeparator(),
        )

        self.stonks = {}
        for sell_token in SELL_TOKENS:
            for buy_token in BUY_TOKENS:
                if sell_token == buy_token:
                    continue

                self.stonks[(sell_token, buy_token)] = Stonks.deploy(
                    Stonks.InitParams(
                        admin=self.admin.address,
                        agent=self.agent.address,
                        manager=self.manager.address,
                        tokenFrom=sell_token,
                        tokenTo=buy_token,
                        amountConverter=self.amount_converter.address,
                        orderSample=sample_order.address,
                        orderDurationInSeconds=self.order_duration,
                        marginInBasisPoints=self.margin_basis_points,
                        priceToleranceInBasisPoints=self.price_tolerance_basis_points,
                        maxImprovementInBasisPoints=self.max_improvement_basis_points,
                        allowPartialFill=False,
                        receiver=Address.ZERO,
                    )
                )

    def _update_aggregator_price(self, aggregator: Account, new_price: int):
        round_id = self.aggregator_data[aggregator].round_id + 1
        timestamp = default_chain.blocks["latest"].timestamp
        self.aggregator_data[aggregator] = AggregatorData(
            round_id,
            new_price,
            timestamp,
        )

        write_storage_variable(aggregator, "s_hotVars", round_id, keys=["latestAggregatorRoundId"])
        # `latestRoundData` surfaces transmissionTimestamp as `updatedAt`, which the staleness
        # checks read; observationsTimestamp only feeds `startedAt`.
        write_storage_variable(
            aggregator,
            "s_transmissions",
            {
                "answer": new_price,
                "observationsTimestamp": timestamp,
                "transmissionTimestamp": timestamp,
            },
            keys=[round_id],
        )

        _, price, _, updated_at, _ = AggregatorV2V3Interface(aggregator).latestRoundData()
        assert price == new_price
        assert updated_at == timestamp

    def _normalized_price(self, token: Address) -> int:
        aggregator = self.chainlink_aggregators[token]
        return normalize_price(self.aggregator_data[aggregator].price, self.feed_decimals[token])

    def _stale_feed(self, sell_token: Address, buy_token: Address, timestamp: int) -> Optional[Tuple[Account, int]]:
        """First feed OracleRouter rejects as stale, in the order it reads them."""
        for token in (sell_token, buy_token):
            aggregator = self.chainlink_aggregators[token]
            updated_at = self.aggregator_data[aggregator].timestamp
            if timestamp - updated_at > self.max_staleness[token]:
                return aggregator, updated_at
        return None

    def _refresh_feeds(self, tokens: List[Address]):
        for token in tokens:
            aggregator = self.chainlink_aggregators[token]
            price = self.aggregator_data[aggregator].price
            self._update_aggregator_price(aggregator, max(1, round(price * random.uniform(0.9, 1.1))))

    def _expected_out(self, sell_amount: int, price_from: int, price_to: int, sell_decimals: int, buy_decimals: int) -> int:
        """Mirror of AmountConverter.getExpectedOut with both prices normalized to PRICE_UNIT."""
        if sell_decimals >= buy_decimals:
            decimals_diff = sell_decimals - buy_decimals
            if decimals_diff == 0:
                return sell_amount * price_from // price_to
            return sell_amount * price_from // (price_to * 10**decimals_diff)

        scaled_amount_from = sell_amount * 10 ** (buy_decimals - sell_decimals)
        return scaled_amount_from * price_from // price_to

    def _estimate_trade_output(self, sell_amount: int, price_from: int, price_to: int, sell_decimals: int, buy_decimals: int) -> int:
        """Mirror of Stonks.estimateTradeOutput: the expected out, less the margin."""
        expected_out = self._expected_out(sell_amount, price_from, price_to, sell_decimals, buy_decimals)
        return expected_out * (MAX_BASIS_POINTS - self.margin_basis_points) // MAX_BASIS_POINTS

    def _expected_signature_error(self, sell_amount: int, baseline_buy_amount: int, current_estimate: int):
        """Mirror of Order.isValidSignature price checks. Returns None when the signature must be accepted."""
        if current_estimate == 0:
            return Order.ZeroQuotableAmount(sell_amount)

        if abs(current_estimate - baseline_buy_amount) <= AMOUNT_EQUALITY_TOLERANCE:
            return None

        original_limit_price = baseline_buy_amount * PRICE_UNIT // sell_amount
        current_execution_price = current_estimate * PRICE_UNIT // sell_amount

        if original_limit_price == 0:
            return Order.PriceShortfallExceedsTolerance(baseline_buy_amount, current_estimate)

        if abs(current_execution_price - original_limit_price) <= AMOUNT_EQUALITY_TOLERANCE:
            return None

        if current_execution_price > original_limit_price:
            if self.max_improvement_basis_points == UINT256_MAX:
                return None

            if self.max_improvement_basis_points == 0:
                return Order.PriceImprovementRejectedInStrictMode(baseline_buy_amount, current_estimate)

            improvement_bps = (current_execution_price - original_limit_price) * MAX_BASIS_POINTS // original_limit_price
            if improvement_bps > self.max_improvement_basis_points:
                max_allowed_buy_amount = (
                    baseline_buy_amount * (MAX_BASIS_POINTS + self.max_improvement_basis_points) // MAX_BASIS_POINTS
                )
                if current_estimate > max_allowed_buy_amount + AMOUNT_EQUALITY_TOLERANCE:
                    return Order.PriceImprovementExceedsLimit(max_allowed_buy_amount, current_estimate)

            return None

        if self.price_tolerance_basis_points == 0:
            return Order.PriceShortfallExceedsTolerance(baseline_buy_amount, current_estimate)

        shortfall_bps = (original_limit_price - current_execution_price) * MAX_BASIS_POINTS // original_limit_price
        if shortfall_bps > self.price_tolerance_basis_points:
            max_tolerated_shortfall = baseline_buy_amount * self.price_tolerance_basis_points // MAX_BASIS_POINTS
            min_acceptable_buy_amount = baseline_buy_amount - max_tolerated_shortfall
            if min_acceptable_buy_amount > current_estimate + AMOUNT_EQUALITY_TOLERANCE:
                return Order.PriceShortfallExceedsTolerance(min_acceptable_buy_amount, current_estimate)

        return None

    def _check_signature(self, order: Order, order_hash: bytes, sell_amount: int, baseline_buy_amount: int, sell_token: Address, buy_token: Address, sell_decimals: int, buy_decimals: int):
        timestamp = default_chain.blocks["latest"].timestamp
        stale = self._stale_feed(sell_token, buy_token, timestamp)
        if stale is not None:
            aggregator, updated_at = stale
            with must_revert(OracleRouter.OracleStale(aggregator.address, updated_at)):
                order.isValidSignature(order_hash, b"")
            return

        current_estimate = self._estimate_trade_output(
            sell_amount,
            self._normalized_price(sell_token),
            self._normalized_price(buy_token),
            sell_decimals,
            buy_decimals,
        )
        error = self._expected_signature_error(sell_amount, baseline_buy_amount, current_estimate)

        if error is None:
            assert order.isValidSignature(order_hash, b"") == ERC1271_MAGIC_VALUE
        else:
            with must_revert(error):
                order.isValidSignature(order_hash, b"")

    @flow()
    def flow_place_order(self):
        sell_token = random.choice(SELL_TOKENS)
        buy_token = random.choice(list(set(BUY_TOKENS) - {sell_token}))
        stonks = self.stonks[(sell_token, buy_token)]
        sell_decimals = IERC20Metadata(sell_token).decimals()
        buy_decimals = IERC20Metadata(buy_token).decimals()
        # A uniform draw over whole tokens never lands under MIN_POSSIBLE_BALANCE; the edge
        # values are what keep the dust path reachable.
        sell_amount = random_int(1, 10_000 * 10**sell_decimals, edge_values_prob=0.05)

        with default_chain.snapshot_and_revert():
            default_chain.mine()
            block = default_chain.blocks["latest"]

        default_chain.set_next_block_timestamp(block.timestamp)

        price_from = self._normalized_price(sell_token)
        price_to = self._normalized_price(buy_token)

        mint(sell_token, stonks, sell_amount)
        sell_amount = IERC20Metadata(sell_token).balanceOf(stonks)
        estimated_output = self._estimate_trade_output(sell_amount, price_from, price_to, sell_decimals, buy_decimals)
        min_buy_amount = random_int(1, round(estimated_output * 1.1)) if estimated_output >= 1 else 1

        if sell_amount < MIN_POSSIBLE_BALANCE:
            with must_revert(Stonks.MinimumPossibleBalanceNotMet(MIN_POSSIBLE_BALANCE, sell_amount)):
                stonks.placeOrder(min_buy_amount)
            return

        stale = self._stale_feed(sell_token, buy_token, default_chain.blocks["pending"].timestamp)
        if stale is not None:
            aggregator, updated_at = stale
            with must_revert(OracleRouter.OracleStale(aggregator.address, updated_at)):
                stonks.placeOrder(min_buy_amount)

            # refresh both feeds so the next flow isn't blocked on the same revert
            self._refresh_feeds([sell_token, buy_token])
            return

        # A zero quote does not revert here: Order floors the CoW limit at `minBuyAmount`, so the
        # zero surfaces in `isValidSignature` instead.
        tx = stonks.placeOrder(min_buy_amount)
        assert tx.block.number == block.number
        assert tx.block.timestamp == block.timestamp

        e = next(e for e in tx.events if isinstance(e, Order.OrderCreated))
        order = Order(e.order)
        order_hash = e.orderHash
        # update values with amounts from event
        sell_amount = e.orderData.sellAmount
        estimated_output = self._estimate_trade_output(sell_amount, price_from, price_to, sell_decimals, buy_decimals)
        buy_amount = max(estimated_output, min_buy_amount)
        assert buy_amount == e.orderData.buyAmount

        with must_revert(Order.OrderNotExpired):
            order.recoverTokenFrom()

        with must_revert(Order.CannotRecoverTokenFrom(sell_token)):
            order.recoverERC20(sell_token, IERC20Metadata(sell_token).balanceOf(order), from_=self.admin)

        # price didn't change, but `minBuyAmount` may sit above the quote and count as a shortfall
        self._check_signature(order, order_hash, sell_amount, buy_amount, sell_token, buy_token, sell_decimals, buy_decimals)

        aggregator = self.chainlink_aggregators[sell_token]
        old_price = self.aggregator_data[aggregator].price
        self._update_aggregator_price(aggregator, max(1, round(old_price * random.uniform(0.9, 1.1))))

        self._check_signature(order, order_hash, sell_amount, buy_amount, sell_token, buy_token, sell_decimals, buy_decimals)

        # roll time forward for order to expire
        default_chain.mine(lambda _: tx.block.timestamp + self.order_duration + 1)
        with must_revert(Order.OrderExpired(e.orderData.validTo)):
            order.isValidSignature(order_hash, b"")

        # must succeed - order expired
        order.recoverTokenFrom(from_=random_account())


def test_stonks():
    # Defaults reproduce the full local sweep; CI scales both counts down.
    rpc_url = os.environ.get("WAKE_RPC_URL", "http://localhost:8545")
    fork_blocks = int(os.environ.get("WAKE_FORK_BLOCKS", "100"))
    flows_per_sequence = int(os.environ.get("WAKE_FLOWS", "500"))

    for _ in range(fork_blocks):
        # Floor is the Chainlink migration to AccessControlledOCR2Aggregator: before ~20.9M the
        # stETH/DAI feeds use an older aggregator and USDT/USDC predate `typeAndVersion`, so the
        # `s_hotVars`/`s_transmissions` writes below would target the wrong storage layout.
        fork_block = random_int(21_000_000, 25_700_000)
        with default_chain.connect(fork=f"{rpc_url}@{fork_block}"):
            try:
                StonksTest().run(1, flows_per_sequence)
            except TransactionRevertedError as e:
                print(e.tx.call_trace if e.tx else "Call reverted")
                raise
            print("sequence passed")
