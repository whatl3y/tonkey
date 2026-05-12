import { TonClient } from "@ton/ton";
import { IConfig } from "../types";
import { defaultEndpoint } from "./Config";

export default function createTonClient(config: IConfig): TonClient {
  const endpoint = config.endpoint || defaultEndpoint(config.network);
  return new TonClient({
    endpoint,
    apiKey: config.apiKey,
  });
}
