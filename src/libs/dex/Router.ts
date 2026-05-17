/**
 * Cross-DEX best-price aggregator.
 *
 * Quotes every registered DEX in parallel for the same `(jettonMaster,
 * amountIn, direction)` triple and picks the candidate with the largest
 * `expectedOut`. Comparison is apples-to-apples because every DEX is producing
 * the same input → output token pair.
 *
 * Failure handling is soft: a DEX that returns `null` (no pool / no liquidity)
 * or throws is simply disqualified — the aggregator picks among whoever
 * succeeded. Only fails the whole call if NO DEX produced a quote.
 */
import { TonClient } from "@ton/ton";
import {
  DexName,
  IDex,
  IDexQuote,
  SwapDirection,
} from "./types";

export interface IBestQuoteArgs {
  client: TonClient;
  jettonMaster: string;
  amountIn: bigint;
  direction: SwapDirection;
  slippageBps: number;
  decimals: number;
  /** When set, restrict to these DEX names; otherwise quote all registered. */
  only?: DexName[];
}

export interface IDexQuoteAttempt {
  dex: DexName;
  quote: IDexQuote | null;
  /** Reason this DEX was disqualified, if any. */
  reason?: string;
}

export interface IBestQuoteResult {
  best: IDexQuote;
  attempts: IDexQuoteAttempt[];
}

export default class DexRouter {
  private readonly dexes: IDex[];

  constructor(dexes: IDex[]) {
    if (!dexes.length) throw new Error("DexRouter needs at least one DEX.");
    this.dexes = dexes;
  }

  registeredNames(): DexName[] {
    return this.dexes.map((d) => d.name);
  }

  getDex(name: DexName): IDex {
    const found = this.dexes.find((d) => d.name === name);
    if (!found) {
      throw new Error(`DEX "${name}" is not registered.`);
    }
    return found;
  }

  async bestQuote(args: IBestQuoteArgs): Promise<IBestQuoteResult> {
    const selected = args.only
      ? this.dexes.filter((d) => args.only!.includes(d.name))
      : this.dexes;
    if (!selected.length) {
      throw new Error(
        `No DEX matched the --dex filter. Available: ${this.dexes
          .map((d) => d.name)
          .join(", ")}`,
      );
    }

    const settled = await Promise.allSettled(
      selected.map((d) =>
        d.quote({
          client: args.client,
          jettonMaster: args.jettonMaster,
          amountIn: args.amountIn,
          direction: args.direction,
          slippageBps: args.slippageBps,
          decimals: args.decimals,
        }),
      ),
    );

    const attempts: IDexQuoteAttempt[] = settled.map((r, i) => {
      const name = selected[i].name;
      if (r.status === "fulfilled") {
        return r.value
          ? { dex: name, quote: r.value }
          : { dex: name, quote: null, reason: "no pool / insufficient liquidity" };
      }
      return {
        dex: name,
        quote: null,
        reason: String((r.reason as any)?.message ?? r.reason),
      };
    });

    const candidates = attempts.filter(
      (a): a is IDexQuoteAttempt & { quote: IDexQuote } => a.quote !== null,
    );

    if (candidates.length === 0) {
      const summary = attempts
        .map((a) => `${a.dex}: ${a.reason ?? "no quote"}`)
        .join("; ");
      throw new Error(
        `No DEX could quote this swap. Tried: ${summary}`,
      );
    }

    let winner = candidates[0];
    for (const c of candidates.slice(1)) {
      if (c.quote.expectedOut > winner.quote.expectedOut) winner = c;
    }

    return { best: winner.quote, attempts };
  }
}
