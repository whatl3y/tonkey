import { ICommand, ICommandOption, IConfig, ITonAccount } from "../types";
import { selectAccount } from "../libs/Wallets";
import Vomit from "../libs/Vomit";

export default function AddressCommand(): ICommand {
  return {
    name: "address",

    help() {
      return "Show bounceable / non-bounceable / raw forms for a wallet (or all loaded wallets).";
    },

    options(): ICommandOption[] {
      return [
        {
          flag: "-w, --wallet <id>",
          desc: "OPTIONAL: wallet index or address (omit to list all loaded wallets).",
        },
      ];
    },

    async execute(
      _config: IConfig,
      options: Record<string, any>,
      accounts: ITonAccount[],
    ) {
      if (options.wallet) {
        return [selectAccount(accounts, options.wallet)];
      }
      return accounts;
    },

    async runCli(
      _config: IConfig,
      options: Record<string, any>,
      accounts: ITonAccount[],
    ) {
      const list: ITonAccount[] = await this.execute(_config, options, accounts);
      Vomit.table(
        list.map((a) => ({
          idx: a.idx,
          version: a.version,
          subwallet: a.subwalletId,
          friendly: a.friendly,
          nonBounce: a.friendlyNonBounce,
          raw: a.address,
        })),
      );
    },
  };
}
