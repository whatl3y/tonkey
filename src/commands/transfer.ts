import assert from "assert";
import BigNumber from "bignumber.js";
import {
  Address,
  beginCell,
  internal,
  SendMode,
  toNano,
} from "@ton/core";
import { TonClient } from "@ton/ton";
import {
  buildJettonTransferMessage,
  getJettonInfo,
  getJettonWalletAddress,
  JETTON_SEND_MODE,
} from "../libs/Jetton";
import { sleep } from "../libs/Helpers";
import { selectAccount, walletContractForAccount } from "../libs/Wallets";
import Vomit from "../libs/Vomit";
import { ICommand, ICommandOption, IConfig, ITonAccount } from "../types";
import BalanceCommand from "./balance";

export default function TransferCommand(client: TonClient): ICommand {
  return {
    name: "transfer",

    help() {
      return "Send TON (or a Jetton) from a loaded wallet to any address.";
    },

    options(): ICommandOption[] {
      return [
        {
          flag: "-f, --from <wallet>",
          desc: "Wallet to send from (index or address).",
          isRequired: true,
        },
        {
          flag: "-t, --to <address>",
          desc: "Recipient address (any TON address form).",
          isRequired: true,
        },
        {
          flag: "--token <jettonMaster>",
          desc: "OPTIONAL: send a Jetton instead of native TON. Pass the Jetton master address.",
        },
        {
          flag: "-a, --amount <amount>",
          desc: "Amount to send. Omit or pass 0 to send max available (native TON only).",
          default: "0",
        },
        {
          flag: "-c, --comment <text>",
          desc: "OPTIONAL: text comment payload (native TON only).",
        },
        {
          flag: "--bounce <flag>",
          desc: "OPTIONAL: override bounce flag (true/false). Default depends on recipient state.",
        },
      ];
    },

    async execute(
      _config: IConfig,
      options: Record<string, any>,
      accounts: ITonAccount[],
    ) {
      const from: ITonAccount = selectAccount(accounts, options.from);
      const toAddr = Address.parse(options.to);
      const bounce = parseBounce(options.bounce);

      // V4 and V5R1 have similar sendTransfer signatures for our minimal use
      // (seqno + secretKey + sendMode + messages), but their union type makes
      // TypeScript complain. Cast to a structural any here is the pragmatic fix.
      const walletContract: any = client.open(
        walletContractForAccount(from, _config.network),
      );
      const seqno = await walletContract.getSeqno();

      if (options.token) {
        // Auto-detect jetton decimals from the master's on-chain content cell.
        // We refuse to guess — the wrong scale silently corrupts the trade size.
        const info = await getJettonInfo(client, options.token);
        const decimals = info.decimals;
        const amountStr = String(options.amount ?? "0");
        assert(
          new BigNumber(amountStr).gt(0),
          "Jetton amount must be > 0 (no 'send max' for jettons in v0).",
        );
        const jettonAmount = BigInt(
          new BigNumber(amountStr)
            .times(new BigNumber(10).pow(decimals))
            .toFixed(0),
        );

        const fromAddr = Address.parse(from.address);
        const senderJettonWallet = await getJettonWalletAddress(
          client,
          Address.parse(options.token),
          fromAddr,
        );

        const transferMsg = buildJettonTransferMessage({
          senderJettonWallet,
          jettonAmount,
          recipientOwner: toAddr,
          responseDestination: fromAddr,
        });

        await walletContract.sendTransfer({
          seqno,
          secretKey: from.secretKey,
          sendMode: JETTON_SEND_MODE,
          messages: [transferMsg],
        });
      } else {
        const amountStr = String(options.amount ?? "0");
        const amountBn = new BigNumber(amountStr);
        const sendMax = amountBn.lte(0);

        const message = internal({
          to: toAddr,
          value: sendMax ? toNano("0") : toNano(amountStr),
          bounce: bounce ?? false,
          body: options.comment
            ? beginCell()
                .storeUint(0, 32)
                .storeStringTail(String(options.comment))
                .endCell()
            : undefined,
        });

        const sendMode = sendMax
          ? SendMode.CARRY_ALL_REMAINING_BALANCE |
            SendMode.IGNORE_ERRORS
          : SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS;

        await walletContract.sendTransfer({
          seqno,
          secretKey: from.secretKey,
          sendMode,
          messages: [message],
        });
      }

      const confirmedSeqno = await waitForSeqno(
        async () => walletContract.getSeqno(),
        seqno,
      );
      return { fromIdx: from.idx, oldSeqno: seqno, newSeqno: confirmedSeqno };
    },

    async runCli(
      config: IConfig,
      options: Record<string, any>,
      accounts: ITonAccount[],
    ) {
      const res = await this.execute(config, options, accounts);
      Vomit.singleLine(
        `Sent. Wallet seqno advanced ${res.oldSeqno} → ${res.newSeqno}.`,
      );
      await BalanceCommand(client).runCli(config, options, accounts);
    },
  };
}

function parseBounce(value?: string): boolean | undefined {
  if (value == null) return undefined;
  const v = String(value).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return undefined;
}

async function waitForSeqno(
  getSeqno: () => Promise<number>,
  oldSeqno: number,
  timeoutMs = 60_000,
  pollMs = 2_500,
): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(pollMs);
    try {
      const next = await getSeqno();
      if (next > oldSeqno) return next;
    } catch {
      // wallet may not be deployed yet on the very first send — keep polling
    }
  }
  throw new Error("Timed out waiting for seqno to advance after send.");
}
