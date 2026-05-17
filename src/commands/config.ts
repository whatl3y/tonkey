import inquirer from "inquirer";
import Config from "../libs/Config";
import Vomit from "../libs/Vomit";
import { ICommand, IConfig, TonNetwork, WalletVersion } from "../types";

export default function ConfigCommand(): ICommand {
  return {
    name: "config",

    help() {
      return "Configure the CLI (network, wallet source, wallet version).";
    },

    async execute(currentConfig: IConfig) {
      const answers = await inquirer.prompt([
        {
          name: "network",
          message: "Network:",
          type: "list",
          default: currentConfig.network,
          choices: [
            { name: "Mainnet", value: "mainnet" as TonNetwork },
            { name: "Testnet", value: "testnet" as TonNetwork },
          ],
        },
        {
          name: "apiKey",
          message: "TonCenter API key (blank = unauthenticated, 1 RPS):",
          type: "input",
          default: currentConfig.apiKey || "",
        },
        {
          name: "walletVersion",
          message: "Default wallet contract version:",
          type: "list",
          default: currentConfig.walletVersion,
          choices: [
            { name: "v5 (W5 / V5R1) — recommended", value: "v5" as WalletVersion },
            { name: "v4 (V4R2) — legacy", value: "v4" as WalletVersion },
          ],
        },
        {
          name: "walletSource",
          message: "How should wallets be loaded?",
          type: "list",
          default: currentConfig.walletSource,
          choices: [
            {
              name: "Env vars (WALLET_MNEMONIC_N or WALLET_PKEY_N) — recommended",
              value: "env",
            },
            {
              name: "Single MNEMONIC + subwallet enumeration",
              value: "mnemonic",
            },
          ],
        },
        {
          name: "subwalletStart",
          message: "OPTIONAL: subwallet start index (mnemonic source only)",
          type: "number",
          default: currentConfig.subwalletStart ?? 0,
          when: (a: any) => a.walletSource === "mnemonic",
        },
        {
          name: "subwalletNumber",
          message: "OPTIONAL: number of subwallets to enumerate (mnemonic source only)",
          type: "number",
          default: currentConfig.subwalletNumber ?? 10,
          when: (a: any) => a.walletSource === "mnemonic",
        },
        {
          name: "randomize",
          message: "Randomize wallet order?",
          type: "confirm",
          default: !!currentConfig.randomize,
        },
      ]);

      const next: IConfig = {
        network: answers.network,
        apiKey: answers.apiKey || undefined,
        walletVersion: answers.walletVersion,
        walletSource: answers.walletSource,
        subwalletStart: answers.subwalletStart,
        subwalletNumber: answers.subwalletNumber,
        randomize: answers.randomize,
      };
      await Config.write(next);
      return next;
    },

    async runCli(currentConfig: IConfig) {
      await this.execute(currentConfig, {}, []);
      Vomit.singleLine("Successfully updated config!");
    },
  };
}
