# SMT Receipts indexer (Envio HyperIndex V3)

Indexes `SMTReceipts` on Monad testnet (chain 10143) at `0xDF9f42AE4f81F086F8495c5a5339dDaa90057993`.

| Event | Entity |
|---|---|
| `AgentRegistered` | `Agent` (agent 1 = SMT's committee calls, agent 2 = SMT's held positions) |
| `Sealed` | `Batch`, one `Receipt` per coin (WAITs included), `PairStat` counters |
| `Graded` | each `Receipt`'s signed entry/exit price, move and net result |
| `Expired` | the batch's LONG/SHORT receipts, marked as misses |

Hosted on Envio Cloud (development plan), deployed from the `envio` branch; every push there is a new
deployment with its own endpoint. On 10-14 the hosted dev-plan deployments never got a block height from their default data
source (HyperSync, then "Source: RPC" with no height), so `config.yaml` names Monad's public RPC
as the sync source, 100 blocks per `eth_getLogs` (the RPC refuses 500 with 413), starting at the
contract's deploy block. A local `envio dev` run synced deploy block → head in ~45 s and matched
the contract's `stats()` for both agents. `ENVIO_API_TOKEN` is also set on the project, which
HyperSync needs if it is ever used again.
The page uses an endpoint via `web/config.js` (`envioGraphql`) or `?envio=<endpoint>`.

```bash
pnpm install && pnpm codegen && pnpm test   # Vitest, createTestIndexer
```
