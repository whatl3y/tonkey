import { ICommand, IConfig } from "../types";
import { randomMnemonic } from "../libs/Wallets";
import Vomit from "../libs/Vomit";

export default function SeedCommand(): ICommand {
  return {
    name: "seed",

    help() {
      return "Generate a new random 24-word TON mnemonic.";
    },

    async execute() {
      return await randomMnemonic();
    },

    async runCli(_config: IConfig) {
      const phrase = await this.execute(_config, {}, []);
      Vomit.singleLine(phrase);
    },
  };
}
