# ton-cli

A CLI wallet for the TON blockchain. Review balances and transfer TON / Jettons from the terminal.

## Install

```sh
$ npm install -g ton-cli
```

Or run locally from source:

```sh
$ npm ci --ignore-scripts
$ npm run audit:deps
$ npm run build
$ ./dist/index.js --help
```

## Commands

| Command | What it does |
|---|---|
| `tond seed` | Generate a fresh 24-word TON mnemonic. |
| `tond address` | Show the bounceable / non-bounceable / raw forms of a wallet. |
| `tond config` | Interactive config (network, RPC, wallet source, wallet version). |
| `tond balance [-t <jettonMaster>]` | Native TON (and optional Jetton) balances across all loaded wallets. |
| `tond transfer -f <from> -t <to> [--token <jettonMaster>] [-a <amount>]` | Send TON or a Jetton. |

## Wallet versions

By default `tond` derives **W5 (V5R1)** addresses. To work with legacy V4R2 funds, run `tond config` and change `walletVersion` to `v4`, or pass `--version v4` to commands that take a wallet selector.

The same private key derives a **different** address per contract version — `EQ...(v5)` and `EQ...(v4)` are two distinct on-chain accounts.

## Wallet sources

- **`env` (default)**: per-wallet env vars.
  - `WALLET_MNEMONIC_N` — one 24-word TON mnemonic per wallet (recommended; addresses are importable into Tonkeeper / Wallet.tg).
  - `WALLET_PKEY_N` — raw 64-byte ed25519 secret in hex (advanced).
- **`mnemonic`**: a single `MNEMONIC` env var, enumerated across `subwallet_id` values. Convenient for bulk operations. **Subwallet addresses are NOT importable into stock TON wallet apps** — keep them inside this CLI.

## Network & RPC

Defaults to TonCenter mainnet (`https://toncenter.com/api/v2/jsonRPC`). Set `TONCENTER_API_KEY` for the 10 RPS tier (the unauthenticated tier is 1 RPS, which the CLI will throttle to).

## Supply-chain safety

Every dependency is pinned to an exact version. `npm run audit:deps` walks `package-lock.json` and flags any tarball whose registry entry was modified in the May 2026 attack window (or matches a known-compromised name list).

Before any `npm install` after the initial scaffold:

```sh
$ npm ci --ignore-scripts
$ npm run audit:deps
```

## Tipping

- TON: _(set after you have an address you want to publish)_
