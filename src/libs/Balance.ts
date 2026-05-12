import { Address, fromNano } from "@ton/core";
import { TonClient } from "@ton/ton";
import { ITonAccount } from "../types";
import { exponentialBackoff, promiseAllConcurrent } from "./Helpers";
import {
  getJettonBalance,
  getJettonInfo,
  getJettonWalletAddress,
} from "./Jetton";

export interface IBalanceRow {
  account: ITonAccount;
  nativeNano: bigint;
  jettonRaw?: bigint | null;
  jettonWallet?: string | null;
}

export interface IBalances {
  rows: IBalanceRow[];
  jetton?: {
    master: string;
    decimals: number;
    symbol?: string;
    name?: string;
  };
}

export async function getNativeBalances(
  client: TonClient,
  accounts: ITonAccount[],
  concurrency = 4,
): Promise<IBalanceRow[]> {
  return await promiseAllConcurrent(
    accounts,
    async (account) => {
      const addr = Address.parse(account.address);
      const balance: bigint = await exponentialBackoff(() =>
        client.getBalance(addr),
      );
      return { account, nativeNano: balance };
    },
    concurrency,
  );
}

export async function getNativeAndJettonBalances(
  client: TonClient,
  accounts: ITonAccount[],
  jettonMasterStr: string,
  concurrency = 4,
): Promise<IBalances> {
  const masterAddr = Address.parse(jettonMasterStr);
  const info = await getJettonInfo(client, jettonMasterStr);
  const { decimals, symbol, name } = info;

  const rows = await promiseAllConcurrent(
    accounts,
    async (account) => {
      const owner = Address.parse(account.address);
      const native: bigint = await exponentialBackoff(() =>
        client.getBalance(owner),
      );
      let jettonRaw: bigint | null = null;
      let jettonWalletStr: string | null = null;
      try {
        const jWallet = await getJettonWalletAddress(client, masterAddr, owner);
        jettonWalletStr = jWallet.toString({ urlSafe: true, bounceable: true });
        jettonRaw = await getJettonBalance(client, jWallet);
      } catch (err) {
        // wallet not deployed or jetton wallet doesn't exist yet
      }
      return {
        account,
        nativeNano: native,
        jettonRaw,
        jettonWallet: jettonWalletStr,
      };
    },
    concurrency,
  );

  return {
    rows,
    jetton: {
      master: jettonMasterStr,
      decimals,
      symbol,
      name,
    },
  };
}

export function formatTon(nano: bigint): string {
  return fromNano(nano);
}
