// SMT Receipts -> queryable scoreboard. Four events, four entities:
//   AgentRegistered -> Agent
//   Sealed          -> Batch + one Receipt per pair (WAITs included) + PairStat counters
//   Graded          -> Receipt prices and net result, Batch GRADED, counters
//   Expired         -> Receipts EXPIRED (a miss that paid the fee), Batch EXPIRED, counters
import { indexer } from "envio";
import type { Agent, PairStat, Receipt } from "envio";
import { symbolOf, unpackCall } from "../decode.js";

const DIRECTION = ["WAIT", "LONG", "SHORT"] as const;

const newPairStat = (agentId: string, pair: string): PairStat => ({
  id: `${agentId}-${pair}`,
  agent_id: agentId,
  pair,
  longs: 0,
  shorts: 0,
  waits: 0,
  graded: 0,
  hits: 0,
  expired: 0,
  sumNetPpm: 0n,
});

indexer.onEvent({ contract: "SMTReceipts", event: "AgentRegistered" }, async ({ event, context }) => {
  const id = event.params.agentId.toString();
  const pairs = event.params.feeds.map(symbolOf);
  const agent: Agent = {
    id,
    agentId: event.params.agentId,
    publisher: event.params.publisher,
    name: event.params.name,
    source: event.params.source,
    feeBps: Number(event.params.feeBps),
    pairs,
    batches: 0,
    calls: 0,
    waits: 0,
    graded: 0,
    hits: 0,
    expired: 0,
    sumNetPpm: 0n,
    lastSealedAt: 0,
  };
  context.Agent.set(agent);
  for (const pair of pairs) context.PairStat.set(newPairStat(id, pair));
});

indexer.onEvent(
  { contract: "SMTReceipts", event: "Sealed" },
  async ({ event, context }) => {
    const agentId = event.params.agentId.toString();
    const batchId = event.params.batchId.toString();
    const agent = await context.Agent.getOrThrow(agentId);
    const sealedAt = Number(event.block.timestamp);
    const exitTs = Number(event.params.exitTs);
    let nDir = 0;
    let waits = 0;

    for (let i = 0; i < agent.pairs.length; i++) {
      const pair = agent.pairs[i]!;
      const { direction, confBps } = unpackCall(event.params.calls, i);
      const dir = DIRECTION[direction] ?? "WAIT";
      const receipt: Receipt = {
        id: `${batchId}-${i}`,
        batch_id: batchId,
        agent_id: agentId,
        feedIndex: i,
        pair,
        direction: dir,
        confBps,
        reasonHash: event.params.reasonHashes[i] ?? "",
        why: event.params.whys[i] ?? "",
        sealedAt,
        exitTs,
        status: dir === "WAIT" ? "WAIT" : "PENDING",
        entryPrice: undefined,
        exitPrice: undefined,
        movePpm: undefined,
        netPpm: undefined,
      };
      context.Receipt.set(receipt);

      const ps = (await context.PairStat.get(`${agentId}-${pair}`)) ?? newPairStat(agentId, pair);
      context.PairStat.set({
        ...ps,
        longs: ps.longs + (dir === "LONG" ? 1 : 0),
        shorts: ps.shorts + (dir === "SHORT" ? 1 : 0),
        waits: ps.waits + (dir === "WAIT" ? 1 : 0),
      });
      if (dir === "WAIT") waits++;
      else nDir++;
    }

    context.Batch.set({
      id: batchId,
      batchId: event.params.batchId,
      agent_id: agentId,
      sourceTs: Number(event.params.sourceTs),
      sealedAt,
      sealBlock: event.block.number,
      sealTx: event.transaction.hash,
      snapshotHash: event.params.snapshotHash,
      entryTs: Number(event.params.entryTs),
      exitTs,
      status: nDir === 0 ? "CLOSED" : "SEALED",
      nDir,
      hits: 0,
      closeTx: nDir === 0 ? event.transaction.hash : undefined,
      closedAt: nDir === 0 ? sealedAt : undefined,
    });
    context.Agent.set({
      ...agent,
      batches: agent.batches + 1,
      calls: agent.calls + nDir,
      waits: agent.waits + waits,
      lastSealedAt: sealedAt,
    });
  },
);

indexer.onEvent(
  { contract: "SMTReceipts", event: "Graded" },
  async ({ event, context }) => {
    const agentId = event.params.agentId.toString();
    const batchId = event.params.batchId.toString();
    const agent = await context.Agent.getOrThrow(agentId);
    const batch = await context.Batch.getOrThrow(batchId);
    let sum = 0n;
    for (let k = 0; k < event.params.feedIndex.length; k++) {
      const i = Number(event.params.feedIndex[k]);
      const net = Number(event.params.netPpm[k]);
      const r = await context.Receipt.getOrThrow(`${batchId}-${i}`);
      context.Receipt.set({
        ...r,
        status: net > 0 ? "HIT" : "MISS",
        entryPrice: event.params.entryPrice[k],
        exitPrice: event.params.exitPrice[k],
        movePpm: Number(event.params.movePpm[k]),
        netPpm: net,
      });
      const ps = (await context.PairStat.get(`${agentId}-${r.pair}`)) ?? newPairStat(agentId, r.pair);
      context.PairStat.set({
        ...ps,
        graded: ps.graded + 1,
        hits: ps.hits + (net > 0 ? 1 : 0),
        sumNetPpm: ps.sumNetPpm + BigInt(net),
      });
      sum += BigInt(net);
    }
    const hits = Number(event.params.hits);
    context.Batch.set({
      ...batch,
      status: "GRADED",
      hits,
      closeTx: event.transaction.hash,
      closedAt: Number(event.block.timestamp),
    });
    context.Agent.set({
      ...agent,
      graded: agent.graded + event.params.feedIndex.length,
      hits: agent.hits + hits,
      sumNetPpm: agent.sumNetPpm + sum,
    });
  },
);

indexer.onEvent(
  { contract: "SMTReceipts", event: "Expired" },
  async ({ event, context }) => {
    const agentId = event.params.agentId.toString();
    const batchId = event.params.batchId.toString();
    const agent = await context.Agent.getOrThrow(agentId);
    const batch = await context.Batch.getOrThrow(batchId);
    const feePpm = agent.feeBps * 100;
    for (let i = 0; i < agent.pairs.length; i++) {
      const r = await context.Receipt.get(`${batchId}-${i}`);
      if (!r || r.direction === "WAIT") continue;
      context.Receipt.set({ ...r, status: "EXPIRED", netPpm: -feePpm });
      const ps = (await context.PairStat.get(`${agentId}-${r.pair}`)) ?? newPairStat(agentId, r.pair);
      context.PairStat.set({ ...ps, expired: ps.expired + 1, sumNetPpm: ps.sumNetPpm - BigInt(feePpm) });
    }
    const missed = Number(event.params.missed);
    context.Batch.set({ ...batch, status: "EXPIRED", closeTx: event.transaction.hash, closedAt: Number(event.block.timestamp) });
    context.Agent.set({
      ...agent,
      expired: agent.expired + missed,
      sumNetPpm: agent.sumNetPpm - BigInt(feePpm * missed),
    });
  },
);
