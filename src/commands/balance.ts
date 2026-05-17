import BigNumber from "bignumber.js";
import { TonClient } from "@ton/ton";
import {
  getNativeAndJettonBalances,
  getNativeBalances,
  IBalanceRow,
} from "../libs/Balance";
import { formatDynamicDecimals } from "../libs/Helpers";
import Vomit from "../libs/Vomit";
import { ICommand, ICommandOption, IConfig, ITonAccount } from "../types";

export default function BalanceCommand(client: TonClient): ICommand {
  return {
    name: "balance",

    help() {
      return "Get TON (and optional Jetton) balances for all loaded wallets.";
    },

    options(): ICommandOption[] {
      return [
        {
          flag: "-t, --token <jettonMaster>",
          desc: "OPTIONAL: Jetton master address. Adds a per-wallet jetton balance column. Decimals/symbol auto-detected from on-chain content.",
        },
        {
          flag: "-q, --query <search>",
          desc: "OPTIONAL: filter wallets whose address includes <search>.",
        },
        {
          flag: "-b, --onlyBalances",
          desc: "OPTIONAL: hide wallets with zero balance.",
          default: false,
        },
        {
          flag: "-P, --pkey",
          desc: "OPTIONAL & SENSITIVE: include secret key column.",
          default: false,
        },
      ];
    },

    async execute(
      _config: IConfig,
      options: Record<string, any>,
      accounts: ITonAccount[],
    ) {
      const filtered = options.query
        ? accounts.filter(
            (a) =>
              a.friendly.toLowerCase().includes(options.query.toLowerCase()) ||
              a.friendlyNonBounce
                .toLowerCase()
                .includes(options.query.toLowerCase()) ||
              a.address.toLowerCase().includes(options.query.toLowerCase()),
          )
        : accounts;

      if (options.token) {
        return await getNativeAndJettonBalances(client, filtered, options.token);
      }
      const rows = await getNativeBalances(client, filtered);
      return { rows };
    },

    async runCli(
      config: IConfig,
      options: Record<string, any>,
      accounts: ITonAccount[],
    ) {
      const result = await this.execute(config, options, accounts);
      const rows: IBalanceRow[] = result.rows;
      const decimals = result.jetton?.decimals ?? 9;
      const symbol = result.jetton?.symbol || "JTON";

      let nativeTotal = new BigNumber(0);
      let jettonTotal = new BigNumber(0);

      const tableRows = rows
        .map((r) => {
          const native = new BigNumber(r.nativeNano.toString()).div(
            new BigNumber(10).pow(9),
          );
          nativeTotal = nativeTotal.plus(native);

          const baseRow: Record<string, any> = {
            idx: r.account.idx,
            version: r.account.version,
            address: r.account.friendlyNonBounce,
            bounceAddy: r.account.friendly,
            TON: native.toFormat(4),
          };

          if (options.pkey) {
            baseRow.secretKey = r.account.secretKey.toString("hex");
          }

          if (result.jetton && r.jettonRaw != null) {
            const jetton = new BigNumber(r.jettonRaw.toString()).div(
              new BigNumber(10).pow(decimals),
            );
            jettonTotal = jettonTotal.plus(jetton);
            baseRow[symbol] = jetton.toFormat(decimals > 4 ? 4 : decimals);
          } else if (result.jetton) {
            baseRow[symbol] = "—";
          }

          if (options.onlyBalances) {
            if (result.jetton) {
              if (!r.jettonRaw || r.jettonRaw === 0n) return null;
            } else if (native.eq(0)) {
              return null;
            }
          }
          return baseRow;
        })
        .filter((r): r is Record<string, any> => !!r);

      if (tableRows.length === 0) {
        Vomit.singleLine("No wallets to show.");
        return;
      }
      Vomit.table(tableRows);

      Vomit.singleLine(`\nTON total: ${nativeTotal.toFormat()} TON`, 0);
      if (result.jetton) {
        Vomit.singleLine(
          `${symbol} total: ${jettonTotal.toFormat()} ${symbol} (${formatDynamicDecimals(jettonTotal)}; master ${result.jetton.master})`,
          0,
        );
      }
    },
  };
}
