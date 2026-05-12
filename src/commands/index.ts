import { TonClient } from "@ton/ton";
import { ICommand, IConfig, ITonAccount } from "../types";
import AddressCommand from "./address";
import BalanceCommand from "./balance";
import BuyCommand from "./buy";
import ConfigCommand from "./config";
import SeedCommand from "./seed";
import SellCommand from "./sell";
import TransferCommand from "./transfer";

export type CommandFactory = (client: TonClient) => ICommand;

export default function commandFactories(): CommandFactory[] {
  return [
    () => SeedCommand(),
    () => AddressCommand(),
    () => ConfigCommand(),
    (client) => BalanceCommand(client),
    (client) => TransferCommand(client),
    (client) => BuyCommand(client),
    (client) => SellCommand(client),
  ];
}

export type { IConfig, ITonAccount };
