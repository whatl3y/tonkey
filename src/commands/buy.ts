import assert from "assert";
import BigNumber from "bignumber.js";
import inquirer from "inquirer";
import { Address, internal, SendMode, toNano } from "@ton/core";
import { TonClient } from "@ton/ton";
import {
  ALL_DEX_NAMES,
  DexName,
  IBestQuoteResult,
  defaultDexRouter,
} from "../libs/dex";
import { getJettonInfo } from "../libs/Jetton";
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
      return "Buy a Jetton with TON, routed across supported DEXs to the best output (currently TONCO and STON.fi v2).";
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
          flag: "-d, --dex <name>",
          desc: `Restrict routing to a DEX. "auto" (default) compares all supported DEXs and picks the best output. Supported: auto | ${ALL_DEX_NAMES.join(" | ")}.`,
          default: "auto",
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
      const fromAddr = Address.parse(from.address);

      const jettonInfo = await getJettonInfo(client, options.token);
      const symbol = jettonInfo.symbol || "JTON";
      const decimals = jettonInfo.decimals;

      const router = defaultDexRouter(client, _config.network);
      const only = parseDexFilter(options.dex, router.registeredNames());
      const result = await router.bestQuote({
        client,
        jettonMaster: options.token,
        amountIn,
        direction: "buy",
        slippageBps,
        decimals,
        only,
      });
      const quote = result.best;

      const message = await router.getDex(quote.dex).buildSwapMessage({
        client,
        quote,
        senderAddress: fromAddr,
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
          quotesTable: renderQuotesTable(result, decimals, "buy"),
          poolAddress: quote.poolAddress,
          gasAttachedTon: new BigNumber(message.value.toString())
            .minus(amountIn.toString())
            .div(1e9)
            .toFormat(),
          dex: quote.dex,
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
        dex: quote.dex,
        expectedOut: quote.expectedOut,
        minimumOut: quote.minimumOut,
        attempts: result.attempts,
      };
    },

    async runCli(
      config: IConfig,
      options: Record<string, any>,
      accounts: ITonAccount[],
    ) {
      const res = await this.execute(config, options, accounts);
      Vomit.singleLine(
        `Swap submitted via ${res.dex} (seqno ${res.oldSeqno} → ${res.newSeqno}). Expected out: ${res.expectedOut.toString()}; floor: ${res.minimumOut.toString()}.`,
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

function parseDexFilter(
  raw: any,
  registered: DexName[],
): DexName[] | undefined {
  if (raw == null) return undefined;
  const s = String(raw).trim().toLowerCase();
  if (!s || s === "auto" || s === "all") return undefined;
  const candidates = s.split(",").map((p) => p.trim()) as DexName[];
  for (const c of candidates) {
    if (!registered.includes(c)) {
      throw new Error(
        `Unknown --dex value "${c}". Supported: auto | ${registered.join(" | ")}.`,
      );
    }
  }
  return candidates;
}

function renderQuotesTable(
  result: IBestQuoteResult,
  outDecimals: number,
  direction: "buy" | "sell",
): string {
  const outScale = direction === "buy" ? outDecimals : 9; // sell outputs TON
  const lines: string[] = [];
  for (const a of result.attempts) {
    const winner = a.quote === result.best ? " *" : "  ";
    if (!a.quote) {
      lines.push(`${winner} ${a.dex.padEnd(10)}  —             (${a.reason})`);
      continue;
    }
    const out = new BigNumber(a.quote.expectedOut.toString())
      .div(new BigNumber(10).pow(outScale))
      .toFormat();
    const pool = a.quote.poolAddress.slice(0, 12) + "…";
    lines.push(
      `${winner} ${a.dex.padEnd(10)}  expected out: ${out}  pool: ${pool}`,
    );
  }
  return lines.join("\n");
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
  quotesTable: string;
  poolAddress: string;
  gasAttachedTon: string;
  dex: DexName;
}

async function confirmOrAbort(args: IConfirmArgs) {
  Vomit.singleLine(
    `
${args.action} via ${args.dex.toUpperCase()}
  from:           ${args.fromFriendly}
  spend:          ${args.inAmountHuman} ${args.inLabel}
  expected out:   ${args.outExpectedHuman} ${args.outLabel}
  minimum out:    ${args.outMinHuman} ${args.outLabel} (slippage ${args.slippageBps} bps)
  pool:           ${args.poolAddress}
  TON gas attach: ${args.gasAttachedTon} TON

  quotes (* = chosen):
${args.quotesTable}
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
