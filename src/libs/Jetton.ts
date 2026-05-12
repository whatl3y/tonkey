import crypto from "crypto";
import axios from "axios";
import {
  Address,
  beginCell,
  Cell,
  Dictionary,
  internal,
  SendMode,
  Slice,
  toNano,
} from "@ton/core";
import { JettonMaster, JettonWallet, TonClient } from "@ton/ton";
import { exponentialBackoff } from "./Helpers";

// TIP-74 / TEP-74 op code for transfer
export const JETTON_TRANSFER_OP = 0x0f8a7ea5;

export interface IJettonMetadata {
  totalSupply: bigint;
  mintable: boolean;
  adminAddress: Address | null;
  content: Cell;
  walletCode: Cell;
}

export interface IJettonInfo {
  decimals: number;
  symbol?: string;
  name?: string;
  image?: string;
  source: "onchain" | "offchain" | "semichain";
}

// TEP-64 — keys in on-chain content dict are sha256(name) as BigUint(256).
function metaKey(name: string): bigint {
  const h = crypto.createHash("sha256").update(name, "utf8").digest();
  return BigInt("0x" + h.toString("hex"));
}

const KEY_DECIMALS = metaKey("decimals");
const KEY_SYMBOL = metaKey("symbol");
const KEY_NAME = metaKey("name");
const KEY_IMAGE = metaKey("image");
const KEY_URI = metaKey("uri");

export async function getJettonWalletAddress(
  client: TonClient,
  masterAddress: Address,
  owner: Address,
): Promise<Address> {
  const master = client.open(JettonMaster.create(masterAddress));
  return await exponentialBackoff(() => master.getWalletAddress(owner));
}

export async function getJettonBalance(
  client: TonClient,
  jettonWallet: Address,
): Promise<bigint> {
  const wallet = client.open(JettonWallet.create(jettonWallet));
  return await exponentialBackoff(() => wallet.getBalance());
}

export async function getJettonData(
  client: TonClient,
  masterAddress: Address,
): Promise<IJettonMetadata> {
  const master = client.open(JettonMaster.create(masterAddress));
  return (await exponentialBackoff(() =>
    master.getJettonData(),
  )) as IJettonMetadata;
}

const JETTON_INFO_CACHE = new Map<string, IJettonInfo>();

/**
 * Resolve a jetton's metadata (decimals, symbol, name, image) by reading its
 * on-chain content cell per TEP-64. Handles:
 *   - on-chain (0x00 prefix): hashmap of sha256(key) -> snake/chunks value cells.
 *   - off-chain (0x01 prefix): snake-encoded URI -> HTTP/IPFS JSON.
 *   - semi-chain: on-chain dict with a "uri" key pointing at JSON; on-chain
 *     fields override the JSON.
 *
 * Throws if decimals cannot be determined. We refuse to guess because using
 * the wrong decimal scale silently turns a $1 trade into a $1,000,000 trade.
 *
 * Cached per process — jetton metadata is effectively immutable at human
 * timescales, so the second call for the same master is free.
 */
export async function getJettonInfo(
  client: TonClient,
  masterStr: string,
): Promise<IJettonInfo> {
  const cached = JETTON_INFO_CACHE.get(masterStr);
  if (cached) return cached;

  const masterAddr = Address.parse(masterStr);
  const data = await getJettonData(client, masterAddr);
  const info = await parseJettonContentCell(data.content);
  if (!Number.isInteger(info.decimals) || info.decimals < 0 || info.decimals > 30) {
    throw new Error(
      `Could not auto-detect jetton decimals for ${masterStr} (parsed value: ${info.decimals}). The token's content cell does not expose a valid decimals field on-chain or off-chain.`,
    );
  }
  JETTON_INFO_CACHE.set(masterStr, info);
  return info;
}

async function parseJettonContentCell(content: Cell): Promise<IJettonInfo> {
  const slice = content.beginParse();
  if (slice.remainingBits < 8) {
    throw new Error("Jetton content cell is too short to contain a format prefix.");
  }
  const prefix = slice.loadUint(8);

  if (prefix === 0x00) {
    return await parseOnchainContent(slice);
  }
  if (prefix === 0x01) {
    const uri = readSnakeTail(slice);
    const meta = await fetchOffchainMeta(uri);
    return { ...meta, source: "offchain" } as IJettonInfo;
  }
  throw new Error(`Unknown jetton content cell prefix: 0x${prefix.toString(16)}`);
}

async function parseOnchainContent(slice: Slice): Promise<IJettonInfo> {
  const dict = slice.loadDict(
    Dictionary.Keys.BigUint(256),
    Dictionary.Values.Cell(),
  );

  const result: Partial<IJettonInfo> = {};
  let source: IJettonInfo["source"] = "onchain";

  const uriCell = dict.get(KEY_URI);
  if (uriCell) {
    source = "semichain";
    try {
      const uri = readContentValueString(uriCell);
      const offchain = await fetchOffchainMeta(uri);
      Object.assign(result, offchain);
    } catch {
      // Off-chain unreachable — keep going; on-chain overrides may still suffice.
    }
  }

  const decimalsCell = dict.get(KEY_DECIMALS);
  if (decimalsCell) {
    const s = readContentValueString(decimalsCell).trim();
    const d = parseInt(s, 10);
    if (Number.isInteger(d)) result.decimals = d;
  }
  const symbolCell = dict.get(KEY_SYMBOL);
  if (symbolCell) result.symbol = readContentValueString(symbolCell).trim();
  const nameCell = dict.get(KEY_NAME);
  if (nameCell) result.name = readContentValueString(nameCell).trim();
  const imageCell = dict.get(KEY_IMAGE);
  if (imageCell) result.image = readContentValueString(imageCell).trim();

  return { ...(result as IJettonInfo), source };
}

function readContentValueString(cell: Cell): string {
  const slice = cell.beginParse();
  if (slice.remainingBits < 8) return "";
  const fmt = slice.loadUint(8);
  if (fmt === 0x00) {
    return readSnakeTail(slice);
  }
  if (fmt === 0x01) {
    // Chunked: HashmapE 32 ^Cell, chunks concatenated in key order.
    const chunks = slice.loadDict(
      Dictionary.Keys.Uint(32),
      Dictionary.Values.Cell(),
    );
    const keys = chunks.keys().sort((a, b) => a - b);
    let result = "";
    for (const k of keys) {
      const c = chunks.get(k)!;
      result += readSnakeTail(c.beginParse());
    }
    return result;
  }
  // Unknown prefix — best-effort: rewind and read everything as snake.
  return readSnakeTail(cell.beginParse());
}

function readSnakeTail(slice: Slice): string {
  let bufs: Buffer[] = [];
  let cur = slice;
  while (true) {
    const bits = cur.remainingBits;
    const bytes = Math.floor(bits / 8);
    if (bytes > 0) bufs.push(cur.loadBuffer(bytes));
    if (cur.remainingRefs === 0) break;
    cur = cur.loadRef().beginParse();
  }
  return Buffer.concat(bufs).toString("utf-8");
}

async function fetchOffchainMeta(
  uri: string,
): Promise<Partial<Omit<IJettonInfo, "source">>> {
  const url = normalizeMetaUri(uri);
  let body: any;
  try {
    const res = await axios.get(url, {
      timeout: 10_000,
      responseType: "json",
      validateStatus: (s) => s >= 200 && s < 300,
    });
    body = res.data;
    if (typeof body === "string") body = JSON.parse(body);
  } catch (err: any) {
    throw new Error(
      `Failed to fetch off-chain jetton metadata from ${url}: ${err?.message || err}`,
    );
  }

  const result: Partial<Omit<IJettonInfo, "source">> = {};
  const decRaw = body?.decimals;
  if (decRaw != null) {
    const d =
      typeof decRaw === "number" ? decRaw : parseInt(String(decRaw), 10);
    if (Number.isInteger(d)) result.decimals = d;
  }
  if (typeof body?.symbol === "string") result.symbol = body.symbol;
  if (typeof body?.name === "string") result.name = body.name;
  if (typeof body?.image === "string") result.image = body.image;
  return result;
}

function normalizeMetaUri(uri: string): string {
  const trimmed = uri.trim();
  if (trimmed.startsWith("ipfs://")) {
    const path = trimmed.slice("ipfs://".length).replace(/^ipfs\//, "");
    return `https://ipfs.io/ipfs/${path}`;
  }
  return trimmed;
}

export interface IBuildJettonTransferBody {
  jettonAmount: bigint;
  toOwner: Address;
  responseDestination: Address;
  forwardTonAmount?: bigint;
  forwardPayload?: Cell | null;
  queryId?: bigint;
}

/**
 * Build the body cell for an internal message sent to the sender's jetton wallet.
 * Layout per TEP-74:
 *   op:0x0f8a7ea5
 *   query_id:uint64
 *   amount:Coins
 *   destination:MsgAddress (recipient OWNER address, not their jetton wallet)
 *   response_destination:MsgAddress
 *   custom_payload:Maybe ^Cell
 *   forward_ton_amount:Coins
 *   forward_payload:Either Cell ^Cell
 */
export function buildJettonTransferBody(
  args: IBuildJettonTransferBody,
): Cell {
  const queryId = args.queryId ?? BigInt(Math.floor(Date.now() / 1000));
  const forwardTonAmount = args.forwardTonAmount ?? 1n; // 1 nanoton triggers a notify
  const body = beginCell()
    .storeUint(JETTON_TRANSFER_OP, 32)
    .storeUint(queryId, 64)
    .storeCoins(args.jettonAmount)
    .storeAddress(args.toOwner)
    .storeAddress(args.responseDestination)
    .storeBit(0) // no custom payload
    .storeCoins(forwardTonAmount);
  if (args.forwardPayload) {
    body.storeBit(1).storeRef(args.forwardPayload);
  } else {
    body.storeBit(0);
  }
  return body.endCell();
}

/**
 * Build an internal message that a wallet contract can include in createTransfer
 * to send `jettonAmount` of the given jetton from `senderJettonWallet` to
 * `recipientOwner`. Attaches ~0.05 TON for the multi-contract gas chain.
 */
export function buildJettonTransferMessage(args: {
  senderJettonWallet: Address;
  jettonAmount: bigint;
  recipientOwner: Address;
  responseDestination: Address;
  attachedTon?: string;
  forwardTonAmount?: bigint;
  forwardPayload?: Cell | null;
}) {
  const body = buildJettonTransferBody({
    jettonAmount: args.jettonAmount,
    toOwner: args.recipientOwner,
    responseDestination: args.responseDestination,
    forwardTonAmount: args.forwardTonAmount,
    forwardPayload: args.forwardPayload,
  });
  return internal({
    to: args.senderJettonWallet,
    value: toNano(args.attachedTon ?? "0.05"),
    bounce: true,
    body,
  });
}

export const JETTON_SEND_MODE = SendMode.PAY_GAS_SEPARATELY;
