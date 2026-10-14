# SMT Receipts indexer (Envio HyperIndex V3)

Indexes `SMTReceipts` on Monad testnet (chain 10143) at `0xDF9f42AE4f81F086F8495c5a5339dDaa90057993`.

| Event | Entity |
|---|---|
| `AgentRegistered` | `Agent` (agent 1 = SMT's committee calls, agent 2 = SMT's held positions) |
| `Sealed` | `Batch`, one `Receipt` per coin (WAITs included), `PairStat` counters |
| `Graded` | each `Receipt`'s signed entry/exit price, move and net result |
| `Expired` | the batch's LONG/SHORT receipts, marked as misses |

Hosted on Envio Cloud (development plan), deployed from the `envio` branch:
`https://indexer.dev.hyperindex.xyz/72cc994/v1/graphql`. The page uses it with
`https://jannetekka.github.io/monad-hack/?envio=<endpoint>`.

```bash
pnpm install && pnpm codegen && pnpm test   # Vitest, createTestIndexer
```
