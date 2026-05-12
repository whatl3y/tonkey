#!/usr/bin/env node

import dotenv from "dotenv";
dotenv.config();

import { program } from "commander";
import Config from "./libs/Config";
import createTonClient from "./libs/TonClientFactory";
import Wallets from "./libs/Wallets";
import Vomit from "./libs/Vomit";
import commandFactories from "./commands";

(async function tonCli() {
  try {
    const pkg = require("../package.json");
    program.version(pkg.version, "-v, --version");

    const config = await Config.get();
    const client = createTonClient(config);

    let accounts = [] as Awaited<ReturnType<ReturnType<typeof Wallets>["getAccounts"]>>;
    try {
      accounts = await Wallets(config).getAccounts();
    } catch (err: any) {
      Vomit.error(`Error loading wallets: ${err?.stack || err}`);
    }

    for (const factory of commandFactories()) {
      const cmd = factory(client);
      const cli = program.command(cmd.name);
      cli.description(cmd.help());

      const opts = (cmd.options && cmd.options()) || [];
      for (const opt of opts) {
        const method: "option" | "requiredOption" = opt.isRequired
          ? "requiredOption"
          : "option";
        cli[method](opt.flag, opt.desc, opt.default as any);
      }

      cli.action(async (options) => {
        try {
          await cmd.runCli(config, options, accounts);
        } catch (err: any) {
          const msg =
            err instanceof Error
              ? `${err.name} - ${err.message}\n${err.stack}`
              : err;
          Vomit.error(msg);
          process.exit(1);
        }
      });
    }

    program.on("command:*", () => {
      console.error(
        "Invalid command: %s\nSee --help for available commands.",
        program.args.join(" "),
      );
      process.exit(1);
    });

    program.parse(process.argv);

    if (program.args.length === 0) {
      console.error(
        "Please provide a valid command\nSee --help for a list of available commands.",
      );
    }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
