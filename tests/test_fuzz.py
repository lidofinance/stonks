import random
from typing import Dict, Tuple, Union, NamedTuple

from wake.testing import *
from wake.testing.fuzzing import *
from pytypes.contracts.AmountConverter import AmountConverter
from pytypes.contracts.Order import Order
from pytypes.contracts.Stonks import Stonks
from pytypes.tests.AggregatorV2V3Interface import AggregatorV2V3Interface
from pytypes.contracts.interfaces.ICoWSwapSettlement import ICoWSwapSettlement
from pytypes.contracts.interfaces.IFeedRegistry import IFeedRegistry
from pytypes.openzeppelin.contracts.token.ERC20.extensions.IERC20Metadata import IERC20Metadata


CHAINLINK_FEED_REGISTRY = Address("0x47Fb2585D2C56Fe188D0E6ec628a38b74fCeeeDf")
USD_DENOMINATION = Address("0x0000000000000000000000000000000000000348")
STETH = Address("0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84")
DAI = Address("0x6B175474E89094C44Da98b954EedeAC495271d0F")
USDT = Address("0xdAC17F958D2ee523a2206206994597C13D831ec7")
USDC = Address("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
COW_SETTLEMENT = Address("0x9008D19f58AAbD9eD0D60971565AA8510560ab41")
COW_VAULT_RELAYER = Address("0xC92E8bdf79f0507f65a392b0ab4667716BFE0110")


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


class AggregatorData(NamedTuple):
    round_id: int
    price: int
    timestamp: int


class StonksTest(FuzzTest):
    agent: Account
    amount_converter: AmountConverter
    stonks: Dict[Tuple[Address, Address], Stonks]
    chainlink_aggregators: Dict[Tuple[Address, Address], Account]
    aggregator_data: Dict[Account, AggregatorData]
    heartbeat_timeouts: Dict[Address, int]

    order_duration: int
    margin_basis_points: int
    price_tolerance_basis_points: int

    def pre_sequence(self):
        self.agent = Account.new()
        manager = default_chain.accounts[0]

        self.order_duration = random_int(60, 60 * 60 * 24)
        self.margin_basis_points = random_int(0, 1_000, edge_values_prob=0.33)  # 0% - 10%
        self.price_tolerance_basis_points = random_int(0, 1_000, edge_values_prob=0.33)  # 0% - 10%

        self.heartbeat_timeouts = {}
        for sell_token in [STETH, DAI, USDT, USDC]:
            self.heartbeat_timeouts[sell_token] = random_int(60, 60 * 60 * 24)

        self.amount_converter = AmountConverter.deploy(
            CHAINLINK_FEED_REGISTRY,
            USD_DENOMINATION,
            [STETH, DAI, USDT, USDC],
            [DAI, USDT, USDC],
            [
                self.heartbeat_timeouts[STETH],
                self.heartbeat_timeouts[DAI],
                self.heartbeat_timeouts[USDT],
                self.heartbeat_timeouts[USDC]
            ]
        )

        sample_order = Order.deploy(
            self.agent,
            COW_VAULT_RELAYER,
            ICoWSwapSettlement(COW_SETTLEMENT).domainSeparator(),
        )

        self.stonks = {}
        self.chainlink_aggregators = {}
        self.aggregator_data = {}
        for sell_token in [STETH, DAI, USDT, USDC]:
            aggregator = Account(IFeedRegistry(CHAINLINK_FEED_REGISTRY).getFeed(sell_token, USD_DENOMINATION))
            self.chainlink_aggregators[(sell_token, USD_DENOMINATION)] = aggregator
            round_id: int = read_storage_variable(aggregator, "s_hotVars", keys=["latestAggregatorRoundId"])  # pyright: ignore reportGeneralTypeIssues
            _, price, _, updated_at, _ = AggregatorV2V3Interface(aggregator).latestRoundData()
            self.aggregator_data[aggregator] = AggregatorData(
                round_id,
                price,
                updated_at,
            )

            _, price, _, _, _ = IFeedRegistry(CHAINLINK_FEED_REGISTRY).latestRoundData(sell_token, USD_DENOMINATION)
            assert price == self.aggregator_data[aggregator].price

            self._update_aggregator_price(aggregator, price + 1)

            for buy_token in [DAI, USDT, USDC]:
                if sell_token == buy_token:
                    continue

                self.stonks[(sell_token, buy_token)] = Stonks.deploy(
                    self.agent,
                    manager,
                    sell_token,
                    buy_token,
                    self.amount_converter,
                    sample_order,
                    self.order_duration,
                    self.margin_basis_points,
                    self.price_tolerance_basis_points,
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
        write_storage_variable(aggregator, "s_transmissions", {"answer": new_price, "timestamp": timestamp}, keys=[round_id])

        _, price, _, updated_at, _ = AggregatorV2V3Interface(aggregator).latestRoundData()
        assert price == new_price
        assert updated_at == timestamp

    def _compute_buy_amount(self, sell_amount: int, price: int, sell_decimals: int, price_decimals: int, buy_decimals: int) -> int:
        buy_amount = self._compute_buy_amount_without_margin(sell_amount, price, sell_decimals, price_decimals, buy_decimals)
        return buy_amount * (10_000 - self.margin_basis_points) // 10_000

    def _compute_buy_amount_without_margin(self, sell_amount: int, price: int, sell_decimals: int, price_decimals: int, buy_decimals: int) -> int:
        if sell_decimals + price_decimals >= buy_decimals:
            buy_amount = sell_amount * price // 10 ** (sell_decimals + price_decimals - buy_decimals)
        else:
            buy_amount = sell_amount * price * 10 ** (buy_decimals - sell_decimals - price_decimals)

        return buy_amount

    @flow()
    def flow_place_order(self):
        sell_token = random.choice([STETH, DAI, USDT, USDC])
        buy_token = random.choice(list({DAI, USDT, USDC} - {sell_token}))
        sell_decimals = IERC20Metadata(sell_token).decimals()
        buy_decimals = IERC20Metadata(buy_token).decimals()
        sell_amount = random_int(1, 10_000 * sell_decimals)
        aggregator = self.chainlink_aggregators[(sell_token, USD_DENOMINATION)]

        with default_chain.snapshot_and_revert():
            default_chain.mine()
            block = default_chain.blocks["latest"]
            _, price, _, _, _ = IFeedRegistry(CHAINLINK_FEED_REGISTRY).latestRoundData(sell_token, USD_DENOMINATION)
            decimals = IFeedRegistry(CHAINLINK_FEED_REGISTRY).decimals(sell_token, USD_DENOMINATION)

        default_chain.set_next_block_timestamp(block.timestamp)

        mint(sell_token, self.stonks[(sell_token, buy_token)], sell_amount)
        sell_amount = IERC20Metadata(sell_token).balanceOf(self.stonks[(sell_token, buy_token)])
        buy_amount = self._compute_buy_amount(sell_amount, price, sell_decimals, decimals, buy_decimals)
        min_buy_amount = random_int(1, round(buy_amount * 1.1)) if buy_amount >= 1 else 1
        buy_amount = max(buy_amount, min_buy_amount)

        if sell_amount <= 10:
            with must_revert(Stonks.MinimumPossibleBalanceNotMet):
                self.stonks[(sell_token, buy_token)].placeOrder(min_buy_amount)
            return
        elif self.aggregator_data[self.chainlink_aggregators[(sell_token, USD_DENOMINATION)]].timestamp + self.heartbeat_timeouts[sell_token] < default_chain.blocks["pending"].timestamp:
            # Chainlink feed is outdated
            with must_revert(AmountConverter.PriceFeedNotUpdated):
                self.stonks[(sell_token, buy_token)].placeOrder(min_buy_amount)

            # update Chainlink feed so it doesn't fail next time
            self._update_aggregator_price(self.chainlink_aggregators[(sell_token, USD_DENOMINATION)], round(price * random.uniform(0.9, 1.1)))
            return
        elif self._compute_buy_amount_without_margin(sell_amount, price, sell_decimals, decimals, buy_decimals) == 0:
            with must_revert(AmountConverter.InvalidExpectedOutAmount):
                self.stonks[(sell_token, buy_token)].placeOrder(min_buy_amount)
            return
        else:
            # everything should pass
            tx = self.stonks[(sell_token, buy_token)].placeOrder(min_buy_amount)
            assert tx.block.number == block.number
            assert tx.block.timestamp == block.timestamp

            e = next(e for e in tx.events if isinstance(e, Order.OrderCreated))
            order = Order(e.order)
            order_hash = e.orderHash
            # update values with amounts from event
            sell_amount = e.orderData.sellAmount
            buy_amount = max(self._compute_buy_amount(sell_amount, price, sell_decimals, decimals, buy_decimals), min_buy_amount)
            assert buy_amount == e.orderData.buyAmount

        with must_revert(Order.OrderNotExpired):
            order.recoverTokenFrom()

        with must_revert(Order.CannotRecoverTokenFrom(sell_token)):
            order.recoverERC20(sell_token, IERC20Metadata(sell_token).balanceOf(order))

        # must pass - price didn't change
        assert order.isValidSignature(order_hash, b"") == bytes.fromhex("1626ba7e")

        old_price = self.aggregator_data[aggregator].price
        new_price = round(old_price * random.uniform(0.9, 1.1))
        self._update_aggregator_price(aggregator, new_price)

        difference = self._compute_buy_amount(sell_amount, new_price, sell_decimals, decimals, buy_decimals) - buy_amount
        max_tolerated_difference = buy_amount * self.price_tolerance_basis_points // 10_000

        if self._compute_buy_amount_without_margin(sell_amount, new_price, sell_decimals, decimals, buy_decimals) == 0:
            with must_revert(AmountConverter.InvalidExpectedOutAmount):
                order.isValidSignature(order_hash, b"")
        elif difference > max_tolerated_difference:
            with must_revert(Order.PriceConditionChanged(buy_amount + max_tolerated_difference, buy_amount + difference)):
                order.isValidSignature(order_hash, b"")
        else:
            # must pass - market situation got worse or stayed the same
            assert order.isValidSignature(order_hash, b"") == bytes.fromhex("1626ba7e")

        # roll time forward for order to expire
        default_chain.mine(lambda _: tx.block.timestamp + self.order_duration + 1)
        with must_revert(Order.OrderExpired):
            order.isValidSignature(order_hash, b"")

        # must succeed - order expired
        order.recoverTokenFrom(from_=random_account())


def test_stonks():
    for _ in range(100):
        fork_block = random_int(17034871, 19049237)
        with default_chain.connect(fork=f"http://localhost:8545@{fork_block}"):
            try:
                StonksTest().run(1, 500)
            except TransactionRevertedError as e:
                print(e.tx.call_trace if e.tx else "Call reverted")
                raise
            print("sequence passed")
