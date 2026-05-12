import assert from "assert";
import {
  KeyPair,
  keyPairFromSecretKey,
  mnemonicNew,
  mnemonicToPrivateKey,
} from "@ton/crypto";
import { WalletContractV4, WalletContractV5R1 } from "@ton/ton";
import { Address } from "@ton/core";
import { formatAddress } from "./Address";
import { randomizeArray, randomizeObjectKeys } from "./Helpers";
import {
  IConfig,
  ITonAccount,
  WalletSource,
  WalletVersion,
} from "../types";

const DEFAULT_WORKCHAIN = 0;

// TON network global IDs (used inside V5R1 wallet_id)
const NETWORK_GLOBAL_ID = {
  mainnet: -239,
  testnet: -3,
} as const;

function walletFromKeypair(
  keyPair: KeyPair,
  version: WalletVersion,
  subwalletId: number,
  network: IConfig["network"],
) {
  if (version === "v4") {
    return WalletContractV4.create({
      workchain: DEFAULT_WORKCHAIN,
      publicKey: keyPair.publicKey,
      walletId: subwalletId === 0 ? undefined : subwalletId,
    });
  }
  return WalletContractV5R1.create({
    publicKey: keyPair.publicKey,
    walletId: {
      networkGlobalId: NETWORK_GLOBAL_ID[network],
      context: {
        workchain: DEFAULT_WORKCHAIN,
        walletVersion: "v5r1",
        subwalletNumber: subwalletId,
      },
    },
  });
}

export function accountFromKeyPair(
  keyPair: KeyPair,
  version: WalletVersion,
  subwalletId: number,
  network: IConfig["network"],
  idx: number,
): ITonAccount {
  const wallet = walletFromKeypair(keyPair, version, subwalletId, network);
  const fmt = formatAddress(wallet.address, network);
  return {
    address: wallet.address.toRawString(),
    friendly: fmt.friendly,
    friendlyNonBounce: fmt.friendlyNonBounce,
    publicKey: keyPair.publicKey,
    secretKey: keyPair.secretKey,
    subwalletId,
    version,
    idx,
  };
}

export function walletContractForAccount(
  account: ITonAccount,
  network: IConfig["network"],
) {
  const keyPair: KeyPair = {
    publicKey: account.publicKey,
    secretKey: account.secretKey,
  };
  return walletFromKeypair(
    keyPair,
    account.version,
    account.subwalletId,
    network,
  );
}

export async function randomMnemonic(): Promise<string> {
  const words = await mnemonicNew();
  return words.join(" ");
}

export default function Wallets(config: IConfig) {
  return {
    async getAccounts(): Promise<ITonAccount[]> {
      const src: WalletSource = config.walletSource;
      switch (src) {
        case "mnemonic":
          return await this.fromSingleMnemonic();
        case "env":
        default:
          return await this.fromEnv();
      }
    },

    async fromEnv(): Promise<ITonAccount[]> {
      const mnemonicPattern = /^WALLET_MNEMONIC_(\d+)$/;
      const pkeyPattern = /^WALLET_PKEY_(\d+)$/;
      const mnemonicKeys = randomizeObjectKeys(
        process.env,
        mnemonicPattern,
        config.randomize,
      );
      const pkeyKeys = randomizeObjectKeys(
        process.env,
        pkeyPattern,
        config.randomize,
      );

      const accounts: ITonAccount[] = [];
      let idx = 0;

      for (const key of mnemonicKeys) {
        const phrase = (process.env[key] || "").trim();
        if (!phrase) continue;
        const words = phrase.split(/\s+/);
        const keyPair = await mnemonicToPrivateKey(words);
        accounts.push(
          accountFromKeyPair(
            keyPair,
            config.walletVersion,
            0,
            config.network,
            idx++,
          ),
        );
      }

      for (const key of pkeyKeys) {
        const hex = (process.env[key] || "").trim();
        if (!hex) continue;
        const buf = Buffer.from(hex.replace(/^0x/, ""), "hex");
        assert(
          buf.length === 64,
          `${key} must be a 64-byte ed25519 secret key (got ${buf.length} bytes)`,
        );
        const keyPair = keyPairFromSecretKey(buf);
        accounts.push(
          accountFromKeyPair(
            keyPair,
            config.walletVersion,
            0,
            config.network,
            idx++,
          ),
        );
      }

      return config.randomize ? randomizeArray(accounts) : accounts;
    },

    async fromSingleMnemonic(): Promise<ITonAccount[]> {
      assert(
        process.env.MNEMONIC,
        "No MNEMONIC env var set for walletSource=mnemonic",
      );
      const words = process.env.MNEMONIC.trim().split(/\s+/);
      const keyPair = await mnemonicToPrivateKey(words);
      const start = Number(config.subwalletStart ?? 0);
      const count = Number(config.subwalletNumber ?? 10);
      const accounts: ITonAccount[] = [];
      for (let i = 0; i < count; i++) {
        const subwalletId = start + i;
        accounts.push(
          accountFromKeyPair(
            keyPair,
            config.walletVersion,
            subwalletId,
            config.network,
            i,
          ),
        );
      }
      return config.randomize ? randomizeArray(accounts) : accounts;
    },
  };
}

export function selectAccount(
  accounts: ITonAccount[],
  selector: string,
): ITonAccount {
  const numeric = Number(selector);
  if (Number.isInteger(numeric) && numeric >= 0 && numeric < accounts.length) {
    return accounts[numeric];
  }
  const normalized = selector.trim();
  let parsed: Address | null = null;
  try {
    parsed = Address.parse(normalized);
  } catch {
    parsed = null;
  }
  const match = accounts.find((a) => {
    if (parsed) {
      try {
        return Address.parse(a.address).equals(parsed!);
      } catch {
        return false;
      }
    }
    return (
      a.friendly === normalized ||
      a.friendlyNonBounce === normalized ||
      a.address === normalized
    );
  });
  assert(match, `Could not find wallet matching "${selector}"`);
  return match;
}
