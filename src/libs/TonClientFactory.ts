import { TonClient } from "@ton/ton";
import { IConfig } from "../types";
import { defaultEndpoint } from "./Config";

export default function createTonClient(config: IConfig): TonClient {
  return new TonClient({
    endpoint: defaultEndpoint(config.network),
    apiKey: config.apiKey,
  });
}
