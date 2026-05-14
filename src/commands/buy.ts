import assert from "assert";
import BigNumber from "bignumber.js";
import inquirer from "inquirer";
import {
  Address,
  beginCell,
  internal,
  SendMode,
  toNano,
} from "@ton/core";
import { TonClient } from "@ton/ton";
import {
  buildSwapMessage,
  findPool,
  quoteExactIn,
} from "../libs/Tonco";
import { getJettonInfo, getJettonWalletAddress } from "../libs/Jetton";
import { sleep } from "../libs/Helpers";
import {
  selectAccount,
  walletContractForAccount,
} from "../libs/Wallets";
import Vomit from "../libs/Vomit";
import { ICommand, ICommandOption, IConfig, ITonAccount } from "../types";
import BalanceCommand from "./balance";

const DEFAULT_SLIPPAGE_BPS = 50; // 0.5 %
const MAX_REASONABLE_SLIPPAGE_BPS = 5_000; // 50 %

export default function BuyCommand(client: TonClient): ICommand {
  return {
    name: "buy",

    help() {
      return "Buy a Jetton with TON via the TONCO DEX (concentrated-liquidity AMM).";
    },

    options(): ICommandOption[] {
      return [
        {
          flag: "-t, --token <jettonMaster>",
          desc: "Jetton master address you want to buy.",
          isRequired: true,
        },
        {
          flag: "-a, --amount <ton>",
          desc: "How much TON to spend (human-readable, e.g. 1.5).",
          isRequired: true,
        },
        {
          flag: "-f, --from <wallet>",
          desc: "Wallet to spend from (index or address). Defaults to 0.",
          default: "0",
        },
        {
          flag: "-s, --slippage <bps>",
          desc: `Slippage tolerance in basis points (default ${DEFAULT_SLIPPAGE_BPS} = 0.5%).`,
          default: String(DEFAULT_SLIPPAGE_BPS),
        },
        {
          flag: "-y, --yes",
          desc: "Skip the confirmation prompt.",
          default: false,
        },
        {
          flag: "--force",
          desc: "Allow slippage > 5%. Use with extreme care.",
          default: false,
        },
      ];
    },

    async execute(
      _config: IConfig,
      options: Record<string, any>,
      accounts: ITonAccount[],
    ) {
      const slippageBps = Number(options.slippage ?? DEFAULT_SLIPPAGE_BPS);
      assertSlippage(slippageBps, !!options.force);

      const amountIn = toNano(String(options.amount));
      assert(amountIn > 0n, "amount must be > 0");

      const from = selectAccount(accounts, options.from);

      // Auto-detect jetton decimals/symbol from the token's content cell.
      // Refuses to proceed if decimals can't be determined — using the wrong
      // scale would corrupt the entire trade.
      const jettonInfo = await getJettonInfo(client, options.token);
      const decimals = jettonInfo.decimals;
      const symbol = jettonInfo.symbol || "JTON";

      const pool = await findPool(client, options.token, "buy");
      const quote = await quoteExactIn(client, pool, amountIn, slippageBps, "buy");

      const fromAddr = Address.parse(from.address);
      const message = buildSwapMessage({
        quote,
        recipient: fromAddr,
      });

      if (!options.yes) {
        await confirmOrAbort({
          action: "BUY",
          fromFriendly: from.friendly,
          inLabel: "TON",
          inAmountHuman: new BigNumber(amountIn.toString())
            .div(1e9)
            .toFormat(),
          outLabel: symbol,
          outExpectedHuman: new BigNumber(quote.expectedOut.toString())
            .div(new BigNumber(10).pow(decimals))
            .toFormat(),
          outMinHuman: new BigNumber(quote.minimumOut.toString())
            .div(new BigNumber(10).pow(decimals))
            .toFormat(),
          slippageBps,
          poolAddress: pool.poolAddress.toString({
            urlSafe: true,
            bounceable: true,
          }),
          gasAttachedTon: new BigNumber(message.value.toString())
            .minus(amountIn.toString())
            .div(1e9)
            .toFormat(),
        });
      }

      const walletContract: any = client.open(
        walletContractForAccount(from, _config.network),
      );
      const seqno = await walletContract.getSeqno();
      await walletContract.sendTransfer({
        seqno,
        secretKey: from.secretKey,
        sendMode:
          message.sendMode ??
          SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
        messages: [
          internal({
            to: message.to,
            value: message.value,
            body: message.body,
            bounce: true,
          }),
        ],
      });

      const newSeqno = await waitForSeqno(
        () => walletContract.getSeqno(),
        seqno,
      );
      return {
        oldSeqno: seqno,
        newSeqno,
        expectedOut: quote.expectedOut,
        minimumOut: quote.minimumOut,
      };
    },

    async runCli(
      config: IConfig,
      options: Record<string, any>,
      accounts: ITonAccount[],
    ) {
      const res = await this.execute(config, options, accounts);
      Vomit.singleLine(
        `Swap submitted (seqno ${res.oldSeqno} → ${res.newSeqno}). Expected out: ${res.expectedOut.toString()}; floor: ${res.minimumOut.toString()}.`,
      );
      Vomit.singleLine(
        "Note: the swap can take 10-60s to fully settle through router → pool → jetton transfer hops. Re-run `tonkey balance -t <jettonMaster>` shortly to confirm.",
        0,
      );
      await BalanceCommand(client).runCli(
        config,
        { ...options, token: options.token },
        accounts,
      );
    },
  };
}

function assertSlippage(bps: number, force: boolean) {
  assert(Number.isFinite(bps), "slippage must be a number");
  assert(bps >= 0, "slippage must be >= 0");
  assert(bps <= 10_000, "slippage must be <= 10000 bps (100%)");
  if (bps > MAX_REASONABLE_SLIPPAGE_BPS) {
    assert(
      force,
      `Refusing slippage > ${MAX_REASONABLE_SLIPPAGE_BPS} bps without --force.`,
    );
  }
}

interface IConfirmArgs {
  action: "BUY" | "SELL";
  fromFriendly: string;
  inLabel: string;
  inAmountHuman: string;
  outLabel: string;
  outExpectedHuman: string;
  outMinHuman: string;
  slippageBps: number;
  poolAddress: string;
  gasAttachedTon: string;
}

async function confirmOrAbort(args: IConfirmArgs) {
  Vomit.singleLine(
    `
${args.action}
  from:           ${args.fromFriendly}
  spend:          ${args.inAmountHuman} ${args.inLabel}
  expected out:   ${args.outExpectedHuman} ${args.outLabel}
  minimum out:    ${args.outMinHuman} ${args.outLabel} (slippage ${args.slippageBps} bps)
  pool:           ${args.poolAddress}
  TON gas attach: ${args.gasAttachedTon} TON
`,
    0,
  );
  const { ok } = await inquirer.prompt([
    {
      name: "ok",
      type: "confirm",
      message: "Proceed?",
      default: false,
    },
  ]);
  assert(ok, "Aborted by user.");
}

async function waitForSeqno(
  getSeqno: () => Promise<number>,
  oldSeqno: number,
  timeoutMs = 90_000,
  pollMs = 2_500,
): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(pollMs);
    try {
      const next = await getSeqno();
      if (next > oldSeqno) return next;
    } catch {
      // wallet may be uninit on its first send
    }
  }
  throw new Error("Timed out waiting for seqno to advance after swap submit.");
}

// Suppress unused-import warnings — kept available for composition.
void beginCell;
void getJettonWalletAddress;
