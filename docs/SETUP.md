# One-time setup

Five steps, all free, about 15 minutes. Steps 1–5 work from a phone browser (use "Desktop site" for GitHub settings). Nothing here ever touches real money.

## 1. A fresh wallet (2 min)

Create a **new** account in any EVM wallet (MetaMask: account menu → *Add account*). It must never hold real funds: it only ever receives free testnet MON.

Copy two things from it:
- its **address** (`0x…`, 42 characters), for the faucet;
- its **private key** (MetaMask: account menu → *Account details* → *Show private key*), for step 2 only. Never paste it anywhere else, including chat.

## 2. The key goes into a GitHub environment secret (3 min)

In this repository: **Settings → Environments → New environment**, name it exactly `monad-testnet`, then **Add environment secret**:

| Name | Value |
|---|---|
| `KEEPER_PRIVATE_KEY` | the private key from step 1 (with or without `0x`) |

Only the `keeper` workflow, running on `main`, can read it.

## 3. Free testnet MON from QuickNode (1 min, repeat every 12 h)

Open https://faucet.quicknode.com/monad/testnet, paste the **address**, claim. No account, no mainnet balance needed. Posting the faucet link on X doubles the drip; that's optional.

What the keeper spends (Monad testnet, ~100 gwei, Monad charges the gas limit):

| | MON |
|---|---|
| deploy + register (once) | ≈ 0.35 |
| each hourly seal | ≈ 0.012–0.016 |
| each grade (one per snapshot that had a LONG or SHORT) | ≈ 0.015–0.035 |
| a day at the hourly cadence | ≈ 0.4–0.7 |
| the live-positions agent: 0.5 MON top-up to its own wallet, then a seal + a 3-coin grade every 4 h | ≈ 0.3–0.4 a day |

If the drip is small, set the repository **variable** (Settings → Secrets and variables → Actions → Variables) `SEAL_EVERY_MIN` to `110` (every 2 h) or `170` (every 3 h). Below 0.05 MON the keeper stops sealing and keeps grading, so nothing already sealed expires for lack of gas. `POSITIONS` = `off` stops the live-positions agent; `POSITIONS_EVERY_MIN` changes its cadence (default: once per horizon, 240 min).

## 4. GitHub Pages (30 s)

**Settings → Pages → Build and deployment → Source: GitHub Actions.** The page then publishes at https://jannetekka.github.io/monad-hack/ on every merge that touches `web/`.

## 5. Merge, then run the keeper once

Merge the pull request. Then **Actions → keeper → Run workflow**. The first run deploys the contract to its fixed address, registers SMT and seals the current snapshot; every hour after that it seals and grades on its own. Each run's summary lists what it did, one tagged line per action:

```
[DEPLOY] ✅ 0xDF9f…7993 · tx …
[REGISTER] ✅ agent 1 "SMT - Smart Money Trading" · BTC ETH SOL BNB XRP DOGE LTC ADA · fee 12 bp
[SEAL] ✅ batch 0 · as_of … · LTC SHORT 55% (7 WAIT) · entry … → exit …
[GRADE] ✅ batch 3 · LTC ✓ +8.40 bp net · tx …
```

A red run is never silent: `[ERROR]` says what failed; `[BUDGET]` means the wallet needs another faucet claim.

## 6. Envio (5 min, for the Envio bounty and the full per-pair scoreboard)

1. https://envio.dev/app/login → log in with GitHub → install the *Envio Deployments* app on `monad-hack`.
2. **Add indexer**: repository `monad-hack`, root directory `indexer`, config file `config.yaml`, branch `main`.
3. When the deployment is green, copy its GraphQL URL and put it in `web/config.js` → `envioGraphql` (or send it to Claude, who opens a one-line PR). Until then the page reads the contract directly and its header says so.

The free Development plan lasts 30 days and 100,000 events; this indexer uses a few hundred a day.
