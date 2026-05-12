import assert from "assert";
import BigNumber from "bignumber.js";
import inquirer from "inquirer";
import { Address, internal, SendMode } from "@ton/core";
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

const DEFAULT_SLIPPAGE_BPS = 50;
const MAX_REASONABLE_SLIPPAGE_BPS = 5_000;

export default function SellCommand(client: TonClient): ICommand {
  return {
    name: "sell",

    help() {
      return "Sell a Jetton for TON via the TONCO DEX.";
    },

    options(): ICommandOption[] {
      return [
        {
          flag: "-t, --token <jettonMaster>",
          desc: "Jetton master address you want to sell.",
          isRequired: true,
        },
        {
          flag: "-a, --amount <jetton>",
          desc: "How many jettons to sell (human-readable, e.g. 100).",
          isRequired: true,
        },
        {
          flag: "-f, --from <wallet>",
          desc: "Wallet to sell from (index or address). Defaults to 0.",
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

      // Auto-detect jetton decimals from on-chain content. We refuse to
      // proceed without verified decimals — guessing here would silently
      // shift the trade size by orders of magnitude.
      const jettonInfo = await getJettonInfo(client, options.token);
      const decimals = jettonInfo.decimals;
      const symbol = jettonInfo.symbol || "JTON";

      const amountHuman = String(options.amount);
      const amountIn = BigInt(
        new BigNumber(amountHuman)
          .times(new BigNumber(10).pow(decimals))
          .toFixed(0),
      );
      assert(amountIn > 0n, "amount must be > 0");

      const from = selectAccount(accounts, options.from);
      const fromAddr = Address.parse(from.address);

      const pool = await findPool(client, options.token, "sell");
      const quote = await quoteExactIn(client, pool, amountIn, slippageBps, "sell");

      const userJettonWallet = await getJettonWalletAddress(
        client,
        Address.parse(options.token),
        fromAddr,
      );

      const message = buildSwapMessage({
        quote,
        recipient: fromAddr,
        userJettonWallet,
      });

      if (!options.yes) {
        await confirmOrAbort({
          action: "SELL",
          fromFriendly: from.friendly,
          inLabel: symbol,
          inAmountHuman: amountHuman,
          outLabel: "TON",
          outExpectedHuman: new BigNumber(quote.expectedOut.toString())
            .div(1e9)
            .toFormat(),
          outMinHuman: new BigNumber(quote.minimumOut.toString())
            .div(1e9)
            .toFormat(),
          slippageBps,
          poolAddress: pool.poolAddress.toString({
            urlSafe: true,
            bounceable: true,
          }),
          gasAttachedTon: new BigNumber(message.value.toString())
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
        `Swap submitted (seqno ${res.oldSeqno} → ${res.newSeqno}). Expected out: ${res.expectedOut.toString()} nanoton; floor: ${res.minimumOut.toString()} nanoton.`,
      );
      Vomit.singleLine(
        "Note: it may take 10-60s for the router → pool → jetton path to fully settle.",
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
  sell:           ${args.inAmountHuman} ${args.inLabel}
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
      // ignore
    }
  }
  throw new Error("Timed out waiting for seqno to advance after swap submit.");
}
