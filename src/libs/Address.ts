import { Address } from "@ton/core";
import { TonNetwork } from "../types";

export function parseAnyAddress(input: string): Address {
  return Address.parse(input.trim());
}

export interface IFormattedAddress {
  raw: string;
  friendly: string;
  friendlyNonBounce: string;
}

export function formatAddress(
  addr: Address,
  network: TonNetwork,
): IFormattedAddress {
  const testOnly = network === "testnet";
  return {
    raw: addr.toRawString(),
    friendly: addr.toString({
      urlSafe: true,
      bounceable: true,
      testOnly,
    }),
    friendlyNonBounce: addr.toString({
      urlSafe: true,
      bounceable: false,
      testOnly,
    }),
  };
}

export function equalAddresses(a: string, b: string): boolean {
  try {
    return parseAnyAddress(a).equals(parseAnyAddress(b));
  } catch {
    return false;
  }
}

export function shortenAddress(addr: string, head = 6, tail = 4): string {
  if (addr.length <= head + tail + 3) return addr;
  return `${addr.slice(0, head)}...${addr.slice(-tail)}`;
}
