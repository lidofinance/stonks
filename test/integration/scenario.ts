import { ethers, network } from 'hardhat'
import { expect } from 'chai'
import { parseEther, Signer, TransactionReceipt } from 'ethers'
import { setup, pairs, TokenPair } from './setup'
import { isClose } from '../../utils/assert'
import { mainnet } from '../../utils/contracts'
import { AmountConverter, IERC20, Stonks, Order } from '../../typechain-types'
import {
  MAGIC_VALUE,
  formOrderHashFromTxReceipt,
} from '../../utils/gpv2-helpers'
import { getPlaceOrderData } from '../../utils/get-events'
import { fillUpBalance } from '../../utils/fill-up-balance'

const deployedContracts: string[] = []
const testItems: Array<TokenPair | string> = deployedContracts.length
  ? deployedContracts
  : pairs

describe('Scenario test multi-pair', function () {
  testItems.forEach((item) => {
    const isStonksDeployed = typeof item === 'string'

    describe(`${
      isStonksDeployed ? item : (item as TokenPair).name
    }`, function () {
      let snapshotId: string
      let orderPlacedSnapshodId: string
      let value: bigint
      let stonks: Stonks
      let manager: Signer
      let amountConverter: AmountConverter
      let tokenFrom: IERC20
      let expectedBuyAmount: bigint
      let orderReceipt: TransactionReceipt
      let order: Order
      let orderHash: string

      this.beforeAll(async () => {
        snapshotId = await network.provider.send('evm_snapshot')

        const result = await setup({
          pair: isStonksDeployed ? undefined : (item as TokenPair),
          deployedContract: isStonksDeployed ? (item as string) : undefined,
        })

        stonks = result.stonks
        amountConverter = result.amountConverter
        value = result.value
        manager = result.manager

        tokenFrom = await ethers.getContractAt(
          'IERC20',
          await stonks.TOKEN_FROM()
        )

        await fillUpBalance(mainnet.AGENT, parseEther('100'))
      })

      context('Setup', () => {
        it('agent should fill up a stonks with tokenFrom', async function () {
          const treasurySigner = await ethers.provider.getSigner(mainnet.AGENT)
          const token = tokenFrom.connect(treasurySigner)
          const currentBalance = await token.balanceOf(
            await stonks.getAddress()
          )

          if (currentBalance > 0) {
            this.skip()
          }

          await network.provider.request({
            method: 'hardhat_impersonateAccount',
            params: [mainnet.AGENT],
          })

          const subjectAddress = await stonks.getAddress()

          const transferTx = await token.transfer(subjectAddress, value)
          await transferTx.wait()

          expect(isClose(await token.balanceOf(subjectAddress), value)).to.be
            .true
        })

        it('manager should place order', async () => {
          expectedBuyAmount =
            await stonks.estimateTradeOutputFromCurrentBalance()
          const orderTx = await stonks.placeOrder(expectedBuyAmount)

          orderReceipt = (await orderTx.wait())!
          if (!orderReceipt) throw new Error('No order receipt')

          const { address } = await getPlaceOrderData(orderReceipt)

          order = await ethers.getContractAt('Order', address)
          expect(isClose(await tokenFrom.balanceOf(address), value)).to.be.true
          expect(
            isClose(await tokenFrom.balanceOf(stonks.getAddress()), BigInt(0))
          ).to.be.true

          orderHash = await formOrderHashFromTxReceipt(
            orderReceipt,
            stonks,
            expectedBuyAmount,
            BigInt(await stonks.MARGIN_IN_BASIS_POINTS())
          )

          const [orderHashFromContract] = await order.getOrderDetails()
          expect(orderHash).to.be.equal(orderHashFromContract)
        })

        after(async () => {
          orderPlacedSnapshodId = await network.provider.send('evm_snapshot')
        })
      })

      context('Successful trade', () => {
        it('settlement should successfully check hash', async () => {
          expect(await order.isValidSignature(orderHash, '0x')).to.equal(
            MAGIC_VALUE
          )
          await expect(
            order.isValidSignature(ethers.ZeroHash, '0x')
          ).to.be.revertedWithCustomError(order, 'InvalidOrderHash')
        })

        it('settlement should pull off assets from order contract', async () => {
          await network.provider.send('hardhat_setCode', [
            mainnet.VAULT_RELAYER,
            '0x',
          ])
          await fillUpBalance(mainnet.VAULT_RELAYER, ethers.parseEther('100'))
          await network.provider.request({
            method: 'hardhat_impersonateAccount',
            params: [mainnet.VAULT_RELAYER],
          })
          const relayerSigner = await ethers.provider.getSigner(
            mainnet.VAULT_RELAYER
          )
          const stethRelayer = await tokenFrom.connect(relayerSigner)
          const orderAddress = await order.getAddress()

          await stethRelayer.transferFrom(
            orderAddress,
            mainnet.VAULT_RELAYER,
            await stethRelayer.balanceOf(await order.getAddress())
          )

          expect(isClose(await stethRelayer.balanceOf(orderAddress), BigInt(0)))
            .to.be.true
        })
      })

      context('Order expired', () => {
        before(async () => {
          await network.provider.send('evm_revert', [orderPlacedSnapshodId])
          orderPlacedSnapshodId = await network.provider.send('evm_snapshot')
        })
        it('should not be possible to cancel order due to expiration time', async () => {
          await expect(order.recoverTokenFrom()).to.be.revertedWithCustomError(
            order,
            'OrderNotExpired'
          )
        })
        it('should be possible to recover tokenFrom after expiration time', async () => {
          await network.provider.send('evm_increaseTime', [
            Number(await stonks.ORDER_DURATION_IN_SECONDS()) + 1,
          ])
          await order.recoverTokenFrom()

          expect(
            isClose(
              await tokenFrom.balanceOf(await order.getAddress()),
              BigInt(0)
            )
          ).to.be.true
        })
        it('should be invalid after order expiration', async () => {
          await expect(
            order.isValidSignature(orderHash, '0x')
          ).to.be.revertedWithCustomError(order, 'OrderExpired')
        })
      })

      context('Market price spike', () => {
        before(async () => {
          await network.provider.send('evm_revert', [orderPlacedSnapshodId])
          orderPlacedSnapshodId = await network.provider.send('evm_snapshot')
        })
        it('settlement should successfully check hash', async () => {
          expect(await order.isValidSignature(orderHash, '0x')).to.equal(
            MAGIC_VALUE
          )
          await expect(
            order.isValidSignature(ethers.ZeroHash, '0x')
          ).to.be.revertedWithCustomError(order, 'InvalidOrderHash')
        })
        it('should change stonks amount converter address', async () => {
          const heartbeat = await amountConverter.priceFeedsHeartbeatTimeouts(
            await stonks.TOKEN_FROM()
          )
          const AmountConverterTestFactory = await ethers.getContractFactory(
            'AmountConverterTest'
          )
          const amountConverterTest = await AmountConverterTestFactory.deploy(
            mainnet.CHAINLINK_PRICE_FEED_REGISTRY,
            mainnet.CHAINLINK_USD_QUOTE,
            [await stonks.TOKEN_FROM()],
            [await stonks.TOKEN_TO()],
            [heartbeat]
          )
          const stonksBytecode = await ethers.provider.getCode(
            await stonks.getAddress()
          )
          const amountConverterAddress = (await amountConverter.getAddress())
            .toLowerCase()
            .slice(2)
          const amountConverterTestAddress = (
            await amountConverterTest.getAddress()
          )
            .toLowerCase()
            .slice(2)

          await network.provider.send('hardhat_setCode', [
            await stonks.getAddress(),
            stonksBytecode.replace(
              new RegExp(amountConverterAddress, 'g'),
              amountConverterTestAddress
            ),
          ])
          await amountConverterTest.multiplyAnswer(
            10000 + Number(await stonks.PRICE_TOLERANCE_IN_BASIS_POINTS()) + 1
          )

          await expect(
            order.isValidSignature(orderHash, '0x')
          ).to.be.revertedWithCustomError(order, 'PriceConditionChanged')
        })
        it('should be possible to recover tokenFrom after price spike', async () => {
          await network.provider.send('evm_increaseTime', [
            Number(await stonks.ORDER_DURATION_IN_SECONDS()) + 1,
          ])
          await order.recoverTokenFrom()

          expect(
            isClose(
              await tokenFrom.balanceOf(await order.getAddress()),
              BigInt(0)
            )
          ).to.be.true
        })
        it('should create a new order for new market conditions', async () => {
          const expectedBuyAmount =
            await stonks.estimateTradeOutputFromCurrentBalance()
          const orderTx = await stonks.placeOrder(expectedBuyAmount)

          const orderReceipt = (await orderTx.wait())!
          if (!orderReceipt) throw new Error('No order receipt')

          const { address } = await getPlaceOrderData(orderReceipt)

          const newOrder = await ethers.getContractAt('Order', address)
          expect(isClose(await tokenFrom.balanceOf(address), value)).to.be.true
          expect(
            isClose(await tokenFrom.balanceOf(stonks.getAddress()), BigInt(0))
          ).to.be.true

          const orderHash = await formOrderHashFromTxReceipt(
            orderReceipt,
            stonks,
            expectedBuyAmount,
            BigInt(await stonks.MARGIN_IN_BASIS_POINTS())
          )

          const [orderHashFromContract] = await newOrder.getOrderDetails()
          expect(orderHash).to.be.equal(orderHashFromContract)
          expect(await newOrder.getAddress()).to.not.be.equal(
            await order.getAddress()
          )
        })
      })
      context('Manager change', () => {
        before(async () => {
          await network.provider.send('evm_revert', [orderPlacedSnapshodId])
          orderPlacedSnapshodId = await network.provider.send('evm_snapshot')
        })
        it('agent should change a manager', async () => {
          const agent = await ethers.getSigner(mainnet.AGENT)
          await stonks.connect(agent).setManager(ethers.ZeroAddress)
          expect(await stonks.manager()).to.be.equal(ethers.ZeroAddress)
        })
        it('manager should not be allowed to interact', async () => {
          await expect(stonks.placeOrder(1)).to.be.revertedWithCustomError(
            stonks,
            'NotAgentOrManager'
          )
        })
      })
      context('Unexpected tokens', () => {
        let ldo: IERC20
        before(async () => {
          await network.provider.send('evm_revert', [orderPlacedSnapshodId])
          orderPlacedSnapshodId = await network.provider.send('evm_snapshot')
        })
        it('should fill up stonks with unexpected token', async () => {
          const agent = await ethers.getSigner(mainnet.AGENT)
          const value = parseEther('1')

          ldo = await ethers.getContractAt('IERC20', mainnet.LDO)
          await ldo.connect(agent).transfer(await stonks.getAddress(), value)

          expect(isClose(await ldo.balanceOf(await stonks.getAddress()), value))
        })
        it('manager should recover unexpected token', async () => {
          const agentBalanceBefore = await ldo.balanceOf(mainnet.AGENT)
          await stonks
            .connect(manager)
            .recoverERC20(
              await ldo.getAddress(),
              await ldo.balanceOf(await stonks.getAddress())
            )
          expect(
            isClose(await ldo.balanceOf(await stonks.getAddress()), BigInt(0))
          )
          expect(
            isClose(
              await ldo.balanceOf(mainnet.AGENT),
              agentBalanceBefore + value
            )
          )
        })
        it('should fill up order contract with unexpected token', async () => {
          const value = parseEther('1')
          const agent = await ethers.getSigner(mainnet.AGENT)
          await ldo.connect(agent).transfer(await order.getAddress(), value)

          expect(isClose(await ldo.balanceOf(await order.getAddress()), value))
        })
        it('manager should recover unexpected token from order contract', async () => {
          const agentBalanceBefore = await ldo.balanceOf(mainnet.AGENT)
          await order
            .connect(manager)
            .recoverERC20(
              await ldo.getAddress(),
              await ldo.balanceOf(await order.getAddress())
            )
          expect(
            isClose(await ldo.balanceOf(await order.getAddress()), BigInt(0))
          )
          expect(
            isClose(
              await ldo.balanceOf(mainnet.AGENT),
              agentBalanceBefore + value
            )
          )
        })
      })

      this.afterAll(async () => {
        await network.provider.send('evm_revert', [snapshotId])
      })
    })
  })
})
