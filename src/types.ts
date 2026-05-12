export type TonNetwork = "mainnet" | "testnet";
export type WalletVersion = "v4" | "v5";
export type WalletSource = "env" | "mnemonic" | "hide";

export interface IConfig {
  network: TonNetwork;
  endpoint?: string;
  apiKey?: string;
  walletSource: WalletSource;
  walletVersion: WalletVersion;
  subwalletStart?: number;
  subwalletNumber?: number;
  randomize?: boolean;
  hideUID?: string;
}

export interface ITonAccount {
  address: string;
  friendly: string;
  friendlyNonBounce: string;
  publicKey: Buffer;
  secretKey: Buffer;
  subwalletId: number;
  version: WalletVersion;
  idx: number;
}

export interface ICommandOption {
  flag: string;
  desc: string;
  isRequired?: boolean;
  default?: unknown;
}

export interface ICommand {
  name: string;
  help(): string;
  options?(): ICommandOption[];
  execute(
    config: IConfig,
    options: Record<string, any>,
    accounts: ITonAccount[],
  ): Promise<any> | any;
  runCli(
    config: IConfig,
    options: Record<string, any>,
    accounts: ITonAccount[],
  ): Promise<void>;
}

export interface IStringMap {
  [key: string]: any;
}
