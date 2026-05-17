/**
 * STON.fi v2 DEX integration — IDex implementation.
 *
 * STON.fi v2 deploys many parallel routers (one per pool family); pool addresses
 * are NOT deterministic from token pair alone the way they are on TONCO.
 *
 * Quote source: STON.fi's `/v1/swap/simulate?dex_v2=true` endpoint. This is the
 * authoritative path STON.fi itself recommends — their indexer reads the
 * actual on-chain pool state and runs the constant-product math, returning the
 * winning router/pool plus `ask_units` (expected out at current state).
 *
 * We pass `slippage_tolerance=0` to the API so it returns the raw expected
 * output, and then apply OUR `slippageBps` to derive `minimumOut`. Keeping the
 * floor calc local keeps it consistent with TONCO and makes the slippage
 * semantics user-visible.
 *
 * Transaction construction: `@ston-fi/sdk` Router + pTON helpers. We pick
 * `DEX.v2_1` vs `DEX.v2_2` based on `router.minor_version` from the simulate
 * response.
 *
 * Network: this DEX is mainnet-only for now. On testnet, `quote` returns
 * `null` so the aggregator falls back to TONCO.
 */
import axios from "axios";
import { Address } from "@ton/core";
import { DEX, pTON } from "@ston-fi/sdk";
import {
  IDex,
  IDexBuildArgs,
  IDexQuote,
  IDexQuoteArgs,
  IDexSwapMessage,
  bpsScaleDown,
} from "./types";

// STON.fi represents native TON as this sentinel "address" in their API.
const STONFI_TON_SENTINEL =
  "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";

const SIMULATE_URL = "https://api.ston.fi/v1/swap/simulate";
const SIMULATE_TIMEOUT_MS = 10_000;

interface IStonfiSimulateRouter {
  address: string;
  major_version: number;
  minor_version: number;
  pton_master_address: string;
  pton_wallet_address: string;
  pton_version: string;
  router_type: string;
  pool_creation_enabled?: boolean;
}

interface IStonfiSimulateResponse {
  offer_address: string;
  ask_address: string;
  offer_jetton_wallet: string;
  ask_jetton_wallet: string;
  router_address: string;
  router: IStonfiSimulateRouter;
  pool_address: string;
  offer_units: string;
  ask_units: string;
  slippage_tolerance: string;
  min_ask_units: string;
  fee_units: string;
  fee_percent: string;
  price_impact: string;
  swap_rate: string;
  gas_params: {
    forward_gas: string;
    estimated_gas_consumption: string;
  };
}

interface IStonfiV2Payload {
  routerAddress: string;
  routerMinorVersion: number;
  ptonMasterAddress: string;
  ptonVersion: string;
}

export interface IStonfiV2Options {
  /** Network passed in by the caller — used to gate STON.fi v2 to mainnet. */
  network: "mainnet" | "testnet";
}

export default class StonfiV2Dex implements IDex {
  readonly name = "stonfi-v2" as const;
  private readonly network: "mainnet" | "testnet";

  constructor(opts: IStonfiV2Options) {
    this.network = opts.network;
  }

  async quote(args: IDexQuoteArgs): Promise<IDexQuote | null> {
    if (this.network !== "mainnet") {
      // STON.fi v2 mainnet-only for now — see file header.
      return null;
    }

    const { jettonMaster, amountIn, direction, slippageBps } = args;

    const offerAddress =
      direction === "buy" ? STONFI_TON_SENTINEL : jettonMaster;
    const askAddress =
      direction === "buy" ? jettonMaster : STONFI_TON_SENTINEL;

    let body: IStonfiSimulateResponse;
    try {
      const res = await axios.post<IStonfiSimulateResponse | string>(
        SIMULATE_URL,
        null,
        {
          params: {
            offer_address: offerAddress,
            ask_address: askAddress,
            units: amountIn.toString(),
            // Ask for the raw expected output; we apply our own slippage.
            slippage_tolerance: 0,
            dex_v2: true,
          },
          timeout: SIMULATE_TIMEOUT_MS,
          validateStatus: () => true,
        },
      );

      // The simulate endpoint returns errors as a bare JSON-encoded string
      // (e.g. "1010: Could not find pool address ...") with a 2xx status.
      // Treat that as "no pool" → soft-fail.
      if (res.status >= 400 || typeof res.data === "string") {
        return null;
      }
      body = res.data;
    } catch {
      // Network failure → soft-fail so the aggregator can still use TONCO.
      return null;
    }

    if (body.router.major_version !== 2) {
      // Defensive — `dex_v2=true` should filter, but never route via v1.
      return null;
    }

    const expectedOut = BigInt(body.ask_units);
    if (expectedOut <= 0n) return null;

    const minimumOut = bpsScaleDown(expectedOut, slippageBps);

    const payload: IStonfiV2Payload = {
      routerAddress: body.router_address,
      routerMinorVersion: body.router.minor_version,
      ptonMasterAddress: body.router.pton_master_address,
      ptonVersion: body.router.pton_version,
    };

    return {
      dex: this.name,
      direction,
      jettonMaster,
      amountIn,
      expectedOut,
      minimumOut,
      slippageBps,
      poolAddress: body.pool_address,
      routerAddress: body.router_address,
      estimatedGasTon: BigInt(body.gas_params.forward_gas),
      payload,
    };
  }

  async buildSwapMessage(args: IDexBuildArgs): Promise<IDexSwapMessage> {
    const { client, quote, senderAddress } = args;
    const p = quote.payload as IStonfiV2Payload;

    const router = this.openRouter(client, p);
    const proxyTon = this.openPton(p);

    if (quote.direction === "buy") {
      const params: any = await (router as any).getSwapTonToJettonTxParams({
        userWalletAddress: senderAddress,
        proxyTon,
        offerAmount: quote.amountIn,
        askJettonAddress: Address.parse(quote.jettonMaster),
        minAskAmount: quote.minimumOut,
        refundAddress: senderAddress,
      });
      return this.normalizeParams(params);
    }

    const params: any = await (router as any).getSwapJettonToTonTxParams({
      userWalletAddress: senderAddress,
      proxyTon,
      offerJettonAddress: Address.parse(quote.jettonMaster),
      offerAmount: quote.amountIn,
      minAskAmount: quote.minimumOut,
      refundAddress: senderAddress,
    });
    return this.normalizeParams(params);
  }

  private openRouter(client: any, p: IStonfiV2Payload): any {
    const addr = Address.parse(p.routerAddress);
    if (p.routerMinorVersion === 2) {
      return client.open(DEX.v2_2.Router.create(addr as any));
    }
    if (p.routerMinorVersion === 1) {
      return client.open(DEX.v2_1.Router.create(addr as any));
    }
    throw new Error(
      `Unsupported STON.fi v2 minor version: 2.${p.routerMinorVersion}`,
    );
  }

  private openPton(p: IStonfiV2Payload): any {
    const addr = Address.parse(p.ptonMasterAddress);
    if (p.ptonVersion.startsWith("2.1")) {
      return pTON.v2_1.create(addr as any);
    }
    throw new Error(`Unsupported STON.fi pTON version: ${p.ptonVersion}`);
  }

  private normalizeParams(params: any): IDexSwapMessage {
    return {
      to: params.to as Address,
      value: BigInt(params.value.toString()),
      body: params.body,
      sendMode: params.sendMode,
    };
  }
}
