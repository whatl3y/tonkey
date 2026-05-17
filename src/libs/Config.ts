import assert from "assert";
import path from "path";
import FileManagement from "./FileManagement";
import { IConfig, TonNetwork } from "../types";

const fileMgmt = FileManagement();

const homeDir =
  process.env[process.platform === "win32" ? "USERPROFILE" : "HOME"];
assert(homeDir, "home directory was not found to store tonkey configuration.");

const confDir = path.join(homeDir, ".tonkey");
const confFile = path.join(confDir, "config.json");

const DEFAULT_ENDPOINTS: Record<TonNetwork, string> = {
  mainnet: "https://toncenter.com/api/v2/jsonRPC",
  testnet: "https://testnet.toncenter.com/api/v2/jsonRPC",
};

export function defaultEndpoint(net: TonNetwork): string {
  return DEFAULT_ENDPOINTS[net];
}

const DEFAULTS: IConfig = {
  network: "mainnet",
  walletSource: "env",
  walletVersion: "v5",
  subwalletStart: 0,
  subwalletNumber: 10,
  randomize: false,
};

export default {
  confDir,
  confFile,

  async ensureConfigFile(): Promise<void> {
    const dirExists = await fileMgmt.doesDirectoryExist(confDir);
    const fileExists = await fileMgmt.doesFileExist(confFile);
    if (!dirExists) {
      await fileMgmt.checkAndCreateDirectoryOrFile(confDir);
    }
    if (!fileExists) {
      await fileMgmt.checkAndCreateDirectoryOrFile(
        confFile,
        true,
        JSON.stringify({}, null, 2),
      );
    }
  },

  async get(): Promise<IConfig> {
    await this.ensureConfigFile();
    const raw = await fileMgmt.getLocalFile(confFile, "utf-8");
    assert(typeof raw === "string", "config should be a string");
    const parsed = JSON.parse(raw);
    const merged: IConfig = { ...DEFAULTS, ...parsed };
    if (!merged.apiKey && process.env.TONCENTER_API_KEY) {
      merged.apiKey = process.env.TONCENTER_API_KEY;
    }
    return merged;
  },

  async write(conf: IConfig): Promise<void> {
    await this.ensureConfigFile();
    await fileMgmt.writeFile(confFile, JSON.stringify(conf, null, 2));
  },
};
