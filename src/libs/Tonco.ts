/**
 * TONCO (cryptoalgebra) DEX integration.
 *
 * TONCO is a Uniswap V3-style concentrated-liquidity AMM on TON. Swaps go through
 * a single Router contract (no per-pair router): you send a jetton transfer
 * (or wrapped-TON transfer) whose forward payload encodes the swap intent,
 * including the OUTPUT-side router jetton wallet that identifies the target token.
 *
 * Pool addresses are deterministic given the two router-side jetton wallet
 * addresses, so we never need to consult an indexer to find a pool.
 *
 * Slippage protection: we ALWAYS pass a non-zero `minimumAmountOut` derived from
 * the on-chain quote scaled by `(1 - slippageBps/10000)`. Setting it to 0 (as the
 * upstream SDK demo does) would accept ANY output and is unsafe in production.
 *
 * MEV note: TON has no public mempool the way EVM does, so sandwich vectors are
 * limited. The dominant residual risk is pool-state drift between quote and
 * execution. The min-output check is the primary defense and is mandatory here.
 */
import { Address, fromNano, toNano } from "@ton/core";
import { TonClient } from "@ton/ton";
import {
  PoolMessageManager,
  PoolV3Contract,
  SwapType,
  TickMath,
  computePoolAddress,
  pTON_ROUTER_WALLET,
  ROUTER,
} from "@toncodex/sdk";
import { exponentialBackoff } from "./Helpers";
import { getJettonWalletAddress } from "./Jetton";

export type SwapDirection = "buy" | "sell";

export interface ITonCoPoolInfo {
  poolAddress: Address;
  routerJ0Wallet: Address;
  routerJ1Wallet: Address;
  inputRouterWallet: Address;
  outputRouterWallet: Address;
  zeroForOne: boolean;
  pTonIsToken0: boolean;
  liquidity: bigint;
  priceSqrt: bigint;
  tick: number;
  lpFeeBps: number;
}

export interface ITonCoQuote {
  pool: ITonCoPoolInfo;
  amountIn: bigint;
  expectedOut: bigint;
  minimumOut: bigint;
  slippageBps: number;
  swapType: SwapType;
  direction: SwapDirection;
}

const BPS = 10_000n;

/** Cast helper for the SDK ↔ @ton/core version skew (nested 0.59 vs top 0.63). */
function sdkAddr(a: Address): any {
  return a as any;
}

export function bpsScaleDown(value: bigint, bps: number): bigint {
  if (bps < 0 || bps > 10_000) throw new Error("slippage bps out of range");
  return (value * (BPS - BigInt(bps))) / BPS;
}

/**
 * Look up the TONCO pool for (TON, jettonMaster) and return its state.
 *
 * @param client TonClient
 * @param jettonMasterStr Jetton minter address of the non-TON side of the pair.
 * @param direction "buy" means TON → jetton, "sell" means jetton → TON.
 */
export async function findPool(
  client: TonClient,
  jettonMasterStr: string,
  direction: SwapDirection,
): Promise<ITonCoPoolInfo> {
  const pTonWallet = Address.parse(pTON_ROUTER_WALLET);
  const routerAddr = Address.parse(ROUTER);
  const jettonMaster = Address.parse(jettonMasterStr);

  // Router's jetton wallet for the user's chosen jetton (the non-TON side).
  const jettonRouterWallet = await getJettonWalletAddress(
    client,
    jettonMaster,
    routerAddr,
  );

  // The pool stores jetton0 < jetton1 by raw bytes.
  const pTonIsToken0 = PoolV3Contract.orderJettonId(
    sdkAddr(pTonWallet),
    sdkAddr(jettonRouterWallet),
  );
  const [j0, j1] = pTonIsToken0
    ? [pTonWallet, jettonRouterWallet]
    : [jettonRouterWallet, pTonWallet];

  const poolAddress: Address = computePoolAddress(sdkAddr(j0), sdkAddr(j1));
  const poolContract = client.open(new PoolV3Contract(sdkAddr(poolAddress)));

  let state;
  try {
    state = await exponentialBackoff(() =>
      poolContract.getPoolStateAndConfiguration(),
    );
  } catch (err: any) {
    throw new Error(
      `TONCO pool not found or uninitialized for jetton ${jettonMasterStr} (derived address ${poolAddress.toString({ urlSafe: true, bounceable: true })}). The TON/jetton pool must exist on TONCO. Underlying error: ${err?.message || err}`,
    );
  }

  if (!state.pool_active) {
    throw new Error(
      `TONCO pool ${poolAddress.toString({ urlSafe: true, bounceable: true })} exists but is paused (pool_active=false).`,
    );
  }
  if (state.liquidity === 0n) {
    throw new Error(
      `TONCO pool ${poolAddress.toString({ urlSafe: true, bounceable: true })} has zero liquidity.`,
    );
  }

  const inputRouterWallet = direction === "buy" ? pTonWallet : jettonRouterWallet;
  const outputRouterWallet =
    direction === "buy" ? jettonRouterWallet : pTonWallet;
  const zeroForOne = inputRouterWallet.equals(j0);

  return {
    poolAddress,
    routerJ0Wallet: j0,
    routerJ1Wallet: j1,
    inputRouterWallet,
    outputRouterWallet,
    zeroForOne,
    pTonIsToken0,
    liquidity: state.liquidity,
    priceSqrt: state.price_sqrt,
    tick: state.tick,
    lpFeeBps: Math.round(state.lp_fee_current / 100),
  };
}

/**
 * Ask the pool contract on-chain for the swap result of a given input amount.
 * This is the authoritative quote — what the contract will actually execute
 * at the current tick / liquidity profile.
 */
export async function quoteExactIn(
  client: TonClient,
  pool: ITonCoPoolInfo,
  amountIn: bigint,
  slippageBps: number,
  direction: SwapDirection,
): Promise<ITonCoQuote> {
  const poolContract = client.open(new PoolV3Contract(sdkAddr(pool.poolAddress)));

  const priceLimit = pool.zeroForOne
    ? BigInt(TickMath.MIN_SQRT_RATIO.toString()) + 1n
    : BigInt(TickMath.MAX_SQRT_RATIO.toString()) - 1n;

  const res: { amount0: bigint; amount1: bigint } = await exponentialBackoff(
    () => poolContract.getSwapEstimate(pool.zeroForOne, amountIn, priceLimit),
  );

  // Pool returns signed amounts: input is positive, output is negative.
  const expectedOut: bigint = pool.zeroForOne ? -res.amount1 : -res.amount0;
  if (expectedOut <= 0n) {
    throw new Error(
      `Quote returned non-positive output (${expectedOut.toString()}). Pool may have insufficient liquidity or hit price limit.`,
    );
  }

  const minimumOut = bpsScaleDown(expectedOut, slippageBps);

  return {
    pool,
    amountIn,
    expectedOut,
    minimumOut,
    slippageBps,
    swapType: direction === "buy" ? SwapType.TON_TO_JETTON : SwapType.JETTON_TO_TON,
    direction,
  };
}

/**
 * Build the SenderArguments (internal message) for the swap. Always uses a real
 * `minimumOut` computed from the on-chain quote — never the SDK demo's `0n`.
 *
 * For BUY (TON → jetton): the destination is `pTON_ROUTER_WALLET` and the
 * message carries the TON value being swapped plus gas.
 *
 * For SELL (jetton → TON): the destination is the SENDER's jetton wallet
 * (computed by caller and passed as `userJettonWallet`) and the message carries
 * only gas (the jetton transfer body forwards the amount to the router).
 */
export function buildSwapMessage(args: {
  quote: ITonCoQuote;
  recipient: Address;
  userJettonWallet?: Address; // required only for sell
}) {
  const { quote, recipient } = args;
  const priceLimitSqrt = quote.pool.zeroForOne
    ? BigInt(TickMath.MIN_SQRT_RATIO.toString()) + 1n
    : BigInt(TickMath.MAX_SQRT_RATIO.toString()) - 1n;

  // For TON_TO_JETTON the SDK doesn't use userJettonWallet; pass a placeholder.
  const senderJettonWallet =
    quote.direction === "buy"
      ? Address.parse(pTON_ROUTER_WALLET)
      : args.userJettonWallet;
  if (!senderJettonWallet) {
    throw new Error("userJettonWallet is required for sell swaps.");
  }

  return PoolMessageManager.createSwapExactInMessage(
    sdkAddr(senderJettonWallet),
    sdkAddr(quote.pool.outputRouterWallet),
    sdkAddr(recipient),
    quote.amountIn,
    quote.minimumOut,
    priceLimitSqrt,
    quote.swapType,
  );
}

export function formatTonAmount(nano: bigint, decimals = 4): string {
  const s = fromNano(nano);
  const [whole, frac = ""] = s.split(".");
  return decimals > 0
    ? `${whole}.${(frac + "0".repeat(decimals)).slice(0, decimals)}`
    : whole;
}

export function toNanoFromString(value: string): bigint {
  return toNano(value);
}
