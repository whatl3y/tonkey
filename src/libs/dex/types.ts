import { Address, Cell } from "@ton/core";
import { TonClient } from "@ton/ton";

export type DexName = "tonco" | "stonfi-v2";
export type SwapDirection = "buy" | "sell";

/**
 * Quote produced by a single DEX implementation. `expectedOut` is the
 * authoritative on-chain (or indexer-authoritative) output for `amountIn`;
 * `minimumOut` already has the user's slippage tolerance applied. Both are
 * expressed in raw token units (jetton-nano for jettons, nanoton for TON).
 *
 * The `payload` field is opaque DEX-specific data that `buildSwapMessage` will
 * consume — it lets us cache the heavy data (router address, pool address,
 * router-side wallets, gas params) computed during quoting so we don't have to
 * recompute it at execution time.
 */
export interface IDexQuote {
  dex: DexName;
  direction: SwapDirection;
  jettonMaster: string;
  amountIn: bigint;
  expectedOut: bigint;
  minimumOut: bigint;
  slippageBps: number;
  poolAddress: string;
  routerAddress?: string;
  /** Display-only: approximate TON gas the message will attach. */
  estimatedGasTon?: bigint;
  /** DEX-specific data forwarded to buildSwapMessage. */
  payload: unknown;
}

export interface IDexSwapMessage {
  to: Address;
  value: bigint;
  body: Cell;
  sendMode?: number;
}

export interface IDexQuoteArgs {
  client: TonClient;
  jettonMaster: string;
  amountIn: bigint;
  direction: SwapDirection;
  slippageBps: number;
  /** Jetton decimals — provided by the caller after on-chain detection. */
  decimals: number;
}

export interface IDexBuildArgs {
  client: TonClient;
  quote: IDexQuote;
  /** The owner address that will sign and receive output. */
  senderAddress: Address;
}

export interface IDex {
  readonly name: DexName;
  /**
   * Try to quote this swap on the DEX. Return `null` when the DEX simply has
   * no pool for this pair or no usable liquidity — the aggregator treats that
   * as a non-fatal disqualification. Throw only for genuine errors
   * (network down, malformed input) that the user should see.
   */
  quote(args: IDexQuoteArgs): Promise<IDexQuote | null>;
  /** Build the internal message that performs the swap. */
  buildSwapMessage(args: IDexBuildArgs): Promise<IDexSwapMessage>;
}

const BPS = 10_000n;

export function bpsScaleDown(value: bigint, bps: number): bigint {
  if (!Number.isFinite(bps) || bps < 0 || bps > 10_000) {
    throw new Error("slippage bps out of range");
  }
  return (value * (BPS - BigInt(bps))) / BPS;
}
