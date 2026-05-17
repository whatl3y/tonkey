import { TonClient } from "@ton/ton";
import { TonNetwork } from "../../types";
import DexRouter from "./Router";
import StonfiV2Dex from "./StonfiV2Dex";
import TonCoDex from "./TonCoDex";
import { DexName, IDex } from "./types";

export { default as DexRouter } from "./Router";
export type { IBestQuoteResult, IDexQuoteAttempt } from "./Router";
export * from "./types";

export const ALL_DEX_NAMES: DexName[] = ["tonco", "stonfi-v2"];

export function defaultDexRouter(_client: TonClient, network: TonNetwork): DexRouter {
  const dexes: IDex[] = [
    new TonCoDex(),
    new StonfiV2Dex({ network }),
  ];
  return new DexRouter(dexes);
}
