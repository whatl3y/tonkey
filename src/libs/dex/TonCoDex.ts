/**
 * TONCO (cryptoalgebra) DEX integration — IDex implementation.
 *
 * TONCO is a Uniswap V3-style concentrated-liquidity AMM on TON. Swaps go
 * through a single Router (no per-pair router): you send a jetton transfer
 * (or wrapped-TON transfer) whose forward payload encodes the swap intent,
 * including the OUTPUT-side router jetton wallet that identifies the target
 * token. Pool addresses are deterministic given the two router-side jetton
 * wallet addresses, so we never need to consult an indexer to find a pool.
 *
 * Slippage protection: we ALWAYS pass a non-zero `minimumAmountOut` derived
 * from the on-chain quote scaled by `(1 - slippageBps/10000)`. Setting it to 0
 * (as the upstream SDK demo does) would accept ANY output and is unsafe in
 * production.
 *
 * MEV note: TON has no public mempool the way EVM does, so sandwich vectors
 * are limited. The dominant residual risk is pool-state drift between quote
 * and execution. The min-output check is the primary defense and is mandatory
 * here.
 */
import { Address } from "@ton/core";
import {
  PoolMessageManager,
  PoolV3Contract,
  SwapType,
  TickMath,
  computePoolAddress,
  pTON_ROUTER_WALLET,
  ROUTER,
} from "@toncodex/sdk";
import { exponentialBackoff } from "../Helpers";
import { getJettonWalletAddress } from "../Jetton";
import {
  IDex,
  IDexBuildArgs,
  IDexQuote,
  IDexQuoteArgs,
  IDexSwapMessage,
  SwapDirection,
  bpsScaleDown,
} from "./types";

/** Cast helper for the SDK ↔ @ton/core version skew (nested 0.59 vs top 0.63). */
function sdkAddr(a: Address): any {
  return a as any;
}

interface ITonCoPayload {
  poolAddress: Address;
  inputRouterWallet: Address;
  outputRouterWallet: Address;
  zeroForOne: bigint extends never ? never : boolean;
  swapType: SwapType;
}

export default class TonCoDex implements IDex {
  readonly name = "tonco" as const;

  async quote(args: IDexQuoteArgs): Promise<IDexQuote | null> {
    const { client, jettonMaster, amountIn, direction, slippageBps } = args;
    const pTonWallet = Address.parse(pTON_ROUTER_WALLET);
    const routerAddr = Address.parse(ROUTER);
    const jettonMasterAddr = Address.parse(jettonMaster);

    const jettonRouterWallet = await getJettonWalletAddress(
      client,
      jettonMasterAddr,
      routerAddr,
    );

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
    } catch {
      // No pool deployed (or RPC can't reach it) — soft-fail.
      return null;
    }
    if (!state.pool_active || state.liquidity === 0n) {
      return null;
    }

    const inputRouterWallet = direction === "buy" ? pTonWallet : jettonRouterWallet;
    const outputRouterWallet =
      direction === "buy" ? jettonRouterWallet : pTonWallet;
    const zeroForOne = inputRouterWallet.equals(j0);

    const priceLimit = zeroForOne
      ? BigInt(TickMath.MIN_SQRT_RATIO.toString()) + 1n
      : BigInt(TickMath.MAX_SQRT_RATIO.toString()) - 1n;

    let res: { amount0: bigint; amount1: bigint };
    try {
      res = await exponentialBackoff(() =>
        poolContract.getSwapEstimate(zeroForOne, amountIn, priceLimit),
      );
    } catch {
      return null;
    }

    const expectedOut: bigint = zeroForOne ? -res.amount1 : -res.amount0;
    if (expectedOut <= 0n) {
      // Hit price limit / insufficient liquidity at this size — disqualified
      // rather than fatal so the aggregator can try other DEXs.
      return null;
    }

    const minimumOut = bpsScaleDown(expectedOut, slippageBps);
    const swapType: SwapType =
      direction === "buy" ? SwapType.TON_TO_JETTON : SwapType.JETTON_TO_TON;

    const payload: ITonCoPayload = {
      poolAddress,
      inputRouterWallet,
      outputRouterWallet,
      zeroForOne,
      swapType,
    };

    return {
      dex: this.name,
      direction,
      jettonMaster,
      amountIn,
      expectedOut,
      minimumOut,
      slippageBps,
      poolAddress: poolAddress.toString({ urlSafe: true, bounceable: true }),
      payload,
    };
  }

  async buildSwapMessage(args: IDexBuildArgs): Promise<IDexSwapMessage> {
    const { client, quote, senderAddress } = args;
    const p = quote.payload as ITonCoPayload;

    const priceLimitSqrt = p.zeroForOne
      ? BigInt(TickMath.MIN_SQRT_RATIO.toString()) + 1n
      : BigInt(TickMath.MAX_SQRT_RATIO.toString()) - 1n;

    // For TON_TO_JETTON the SDK doesn't actually use senderJettonWallet; pass
    // pTON router wallet as a safe placeholder. For JETTON_TO_TON we resolve
    // the sender's jetton wallet on the jetton master.
    let senderJettonWallet: Address;
    if (quote.direction === "buy") {
      senderJettonWallet = Address.parse(pTON_ROUTER_WALLET);
    } else {
      senderJettonWallet = await getJettonWalletAddress(
        client,
        Address.parse(quote.jettonMaster),
        senderAddress,
      );
    }

    const msg = PoolMessageManager.createSwapExactInMessage(
      sdkAddr(senderJettonWallet),
      sdkAddr(p.outputRouterWallet),
      sdkAddr(senderAddress),
      quote.amountIn,
      quote.minimumOut,
      priceLimitSqrt,
      p.swapType,
    );

    return {
      to: msg.to as unknown as Address,
      value: BigInt(msg.value.toString()),
      body: msg.body as any,
      sendMode: (msg as any).sendMode,
    };
  }
}

// Re-exported for callers that want to use shared utilities outside the DEX
// abstraction (none currently, but keeps the public surface stable).
export { SwapDirection };
