import { ethers } from 'hardhat'
import { Signer } from 'ethers'
import { getContracts } from './contracts'

const contracts = getContracts()

// Curve Twocrypto-NG factory on mainnet. Deploys the canonical LDO/wstETH TwoCrypto pool the
// BuybackExecutor expects (coin0 = LDO, coin1 = wstETH, with a working `price_oracle()`).
const TWOCRYPTO_NG_FACTORY = '0x98EE851a00abeE0d95D08cF4CA2BdCE32aeaAF7F'

const FACTORY_ABI = [
  'function deploy_pool(string _name, string _symbol, address[2] _coins, uint256 implementation_id, uint256 A, uint256 gamma, uint256 mid_fee, uint256 out_fee, uint256 fee_gamma, uint256 allowed_extra_profit, uint256 adjustment_step, uint256 ma_exp_time, uint256 initial_price) returns (address)',
]

export const CURVE_POOL_ABI = [
  'function add_liquidity(uint256[2] amounts, uint256 min_mint_amount) returns (uint256)',
  'function coins(uint256) view returns (address)',
  'function balances(uint256) view returns (uint256)',
  'function price_oracle() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]

// Standard Twocrypto-NG parameters (Curve UI defaults for a volatile pair). Validated by the
// factory's range checks; only `initial_price` is caller-supplied so the pool opens near market.
const POOL_PARAMS = {
  A: 400000n,
  gamma: 145000000000000n, // 1.45e14
  midFee: 26000000n, // 0.26%
  outFee: 45000000n, // 0.45%
  feeGamma: 230000000000000n, // 2.3e14
  allowedExtraProfit: 2000000000000n, // 2e12
  adjustmentStep: 146000000000000n, // 1.46e14
  maExpTime: 866n,
}

/**
 * Deploys a fresh LDO/wstETH Twocrypto-NG pool on the fork via the mainnet Curve factory.
 * @param deployer Signer that sends the deploy tx.
 * @param initialPrice Price of coin1 (wstETH) quoted in coin0 (LDO), 1e18-scaled. Drives both
 *        `price_oracle()` and the balanced seed ratio.
 * @returns The pool contract (also the LP token) bound to `deployer`, via {@link CURVE_POOL_ABI}.
 */
export async function deployLdoWstEthPool(deployer: Signer, initialPrice: bigint) {
  const factory = new ethers.Contract(TWOCRYPTO_NG_FACTORY, FACTORY_ABI, deployer)

  const poolAddress: string = await factory.deploy_pool.staticCall(
    'LDO/wstETH',
    'LDOwstETH',
    [contracts.LDO, contracts.WSTETH],
    0n,
    POOL_PARAMS.A,
    POOL_PARAMS.gamma,
    POOL_PARAMS.midFee,
    POOL_PARAMS.outFee,
    POOL_PARAMS.feeGamma,
    POOL_PARAMS.allowedExtraProfit,
    POOL_PARAMS.adjustmentStep,
    POOL_PARAMS.maExpTime,
    initialPrice
  )

  const tx = await factory.deploy_pool(
    'LDO/wstETH',
    'LDOwstETH',
    [contracts.LDO, contracts.WSTETH],
    0n,
    POOL_PARAMS.A,
    POOL_PARAMS.gamma,
    POOL_PARAMS.midFee,
    POOL_PARAMS.outFee,
    POOL_PARAMS.feeGamma,
    POOL_PARAMS.allowedExtraProfit,
    POOL_PARAMS.adjustmentStep,
    POOL_PARAMS.maExpTime,
    initialPrice
  )
  await tx.wait()

  return new ethers.Contract(poolAddress, CURVE_POOL_ABI, deployer)
}
