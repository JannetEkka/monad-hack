import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";
import { symbolOf, unpackCall } from "./decode.js";

const b32 = (s: string) => "0x" + Buffer.from(s.padEnd(32, "\0"), "latin1").toString("hex");
const pack = (calls: [number, number][]) =>
  calls.reduce((acc, [dir, conf], i) => acc | (((BigInt(dir) << 14n) | BigInt(conf)) << BigInt(16 * i)), 0n);
const tx = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const H = (s: string) => "0x" + Buffer.from(s.padEnd(32, "#")).toString("hex").slice(0, 64);

describe("helpers", () => {
  it("decodes feed ids and the packed calls word", () => {
    expect(symbolOf(b32("DOGE"))).toBe("DOGE");
    const w = pack([[1, 6100], [0, 2000], [2, 5400]]);
    expect([0, 1, 2].map((i) => unpackCall(w, i))).toEqual([
      { direction: 1, confBps: 6100 },
      { direction: 0, confBps: 2000 },
      { direction: 2, confBps: 5400 },
    ]);
  });
});

describe("SMT Receipts indexer", () => {
  it("builds the agent, batches, receipts and per-pair scoreboard from the four events", async () => {
    const indexer = createTestIndexer();
    const T = 1_791_300_000;
    const B = 68_750_000; // config.yaml start_block
    await indexer.process({
      chains: {
        10143: {
          simulate: [
            {
              contract: "SMTReceipts",
              event: "AgentRegistered",
              block: { number: B + 100 },
              params: { agentId: 1n, name: "SMT", source: "https://example.org/decisions.json", feeBps: 12n, feeds: ["BTC", "ETH", "LTC"].map(b32) },
            },
            {
              contract: "SMTReceipts",
              event: "Sealed",
              block: { number: B + 101, timestamp: T },
              transaction: { hash: tx(1) },
              params: {
                batchId: 0n, agentId: 1n, sourceTs: BigInt(T - 60), snapshotHash: H("snap"), entryTs: BigInt(T + 10), exitTs: BigInt(T + 3610),
                calls: pack([[1, 6100], [0, 2000], [2, 5400]]), reasonHashes: [H("a"), H("b"), H("c")], whys: ["up", "", "down"],
              },
            },
            {
              contract: "SMTReceipts",
              event: "Graded",
              block: { number: B + 200, timestamp: T + 3700 },
              transaction: { hash: tx(2) },
              params: {
                batchId: 0n, agentId: 1n, feedIndex: [0n, 2n], entryPrice: [10_000_000_000_000n, 10_000_000_000n],
                exitPrice: [10_050_000_000_000n, 10_010_000_000n], movePpm: [5000n, 1000n], netPpm: [3800n, -2200n], hits: 1n,
              },
            },
            {
              contract: "SMTReceipts",
              event: "Sealed",
              block: { number: B + 300, timestamp: T + 4000 },
              transaction: { hash: tx(3) },
              params: {
                batchId: 1n, agentId: 1n, sourceTs: BigInt(T + 3900), snapshotHash: H("snap2"), entryTs: BigInt(T + 4010), exitTs: BigInt(T + 7610),
                calls: pack([[0, 100], [1, 7000], [0, 300]]), reasonHashes: [H("d"), H("e"), H("f")], whys: ["", "eth up", ""],
              },
            },
            {
              contract: "SMTReceipts",
              event: "Sealed",
              block: { number: B + 301, timestamp: T + 4001 },
              transaction: { hash: tx(4) },
              params: {
                batchId: 2n, agentId: 1n, sourceTs: BigInt(T + 3950), snapshotHash: H("snap3"), entryTs: BigInt(T + 4010), exitTs: BigInt(T + 7610),
                calls: pack([[0, 100], [0, 200], [0, 300]]), reasonHashes: [H("g"), H("h"), H("i")], whys: ["", "", ""],
              },
            },
            {
              contract: "SMTReceipts",
              event: "Expired",
              block: { number: B + 900, timestamp: T + 4010 + 22 * 3600 },
              transaction: { hash: tx(5) },
              params: { batchId: 1n, agentId: 1n, missed: 1n },
            },
          ],
        },
      },
    });

    const agent = await indexer.Agent.getOrThrow("1");
    expect(agent).toMatchObject({ pairs: ["BTC", "ETH", "LTC"], batches: 3, calls: 3, waits: 6, graded: 2, hits: 1, expired: 1, feeBps: 12 });
    expect(agent.sumNetPpm).toBe(3800n - 2200n - 1200n);

    const b0 = await indexer.Batch.getOrThrow("0");
    expect(b0).toMatchObject({ status: "GRADED", nDir: 2, hits: 1, sealTx: tx(1), closeTx: tx(2), entryTs: T + 10, exitTs: T + 3610 });
    expect((await indexer.Batch.getOrThrow("1")).status).toBe("EXPIRED");
    expect((await indexer.Batch.getOrThrow("2"))).toMatchObject({ status: "CLOSED", nDir: 0 });

    expect(await indexer.Receipt.getOrThrow("0-0")).toMatchObject({ pair: "BTC", direction: "LONG", confBps: 6100, status: "HIT", netPpm: 3800, why: "up" });
    expect(await indexer.Receipt.getOrThrow("0-1")).toMatchObject({ pair: "ETH", direction: "WAIT", status: "WAIT" });
    expect(await indexer.Receipt.getOrThrow("0-2")).toMatchObject({ pair: "LTC", direction: "SHORT", status: "MISS", movePpm: 1000, netPpm: -2200 });
    expect(await indexer.Receipt.getOrThrow("1-1")).toMatchObject({ pair: "ETH", direction: "LONG", status: "EXPIRED", netPpm: -1200 });

    expect(await indexer.PairStat.getOrThrow("1-BTC")).toMatchObject({ longs: 1, waits: 2, graded: 1, hits: 1, sumNetPpm: 3800n });
    expect(await indexer.PairStat.getOrThrow("1-ETH")).toMatchObject({ longs: 1, waits: 2, expired: 1, sumNetPpm: -1200n });
    expect(await indexer.PairStat.getOrThrow("1-LTC")).toMatchObject({ shorts: 1, waits: 2, graded: 1, hits: 0, sumNetPpm: -2200n });
  });
});
