# SMT Receipts indexer (Envio HyperIndex V3)

Indexes `SMTReceipts` on Monad testnet (chain 10143) at `0xDF9f42AE4f81F086F8495c5a5339dDaa90057993`.

| Event | Entity |
|---|---|
| `AgentRegistered` | `Agent` (agent 1 = SMT's committee calls, agent 2 = SMT's held positions) |
| `Sealed` | `Batch`, one `Receipt` per coin (WAITs included), `PairStat` counters |
| `Graded` | each `Receipt`'s signed entry/exit price, move and net result |
| `Expired` | the batch's LONG/SHORT receipts, marked as misses |

Hosted on Envio Cloud (development plan), deployed from the `envio` branch; every push there is a new
deployment with its own endpoint. Envio 3.14 reads HyperSync only with an API token, so the project
sets `ENVIO_API_TOKEN` under Environment Variables (a free token from envio.dev/app/api-tokens).
Without it the indexer stops right after "Starting indexing!" and its endpoint answers 503.
The page uses an endpoint via `web/config.js` (`envioGraphql`) or `?envio=<endpoint>`.

```bash
pnpm install && pnpm codegen && pnpm test   # Vitest, createTestIndexer
```
