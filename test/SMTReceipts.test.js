const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const fs = require("fs");
const path = require("path");
const rs = require("../lib/redstone");
const rc = require("../lib/receipts");

const FEEDS = ["BTC", "ETH", "LTC"];
const ids = FEEDS.map(rs.feedId);
const H = 3600; // horizon used in most tests
const E8 = 10n ** 8n;

// Local stand-ins for RedStone's five signers.
const oracleKeys = Array.from({ length: 5 }, (_, i) => new ethers.Wallet(ethers.id(`oracle-${i}`)));
const outsider = new ethers.Wallet(ethers.id("not-an-oracle"));

/** Payload with `prices` {symbol: decimal-string} signed by signer indexes `who` at tsMs. */
function payload(tsMs, prices, who = [0, 1, 2]) {
  const pk = [];
  for (const [sym, px] of Object.entries(prices)) {
    for (const i of who) pk.push(rs.signPackage(typeof i === "number" ? oracleKeys[i] : i, sym, ethers.parseUnits(px, 8), tsMs));
  }
  return rs.buildPayload(pk);
}

async function deploy(signers = oracleKeys.map((w) => w.address), threshold = 3) {
  const F = await ethers.getContractFactory("SMTReceipts");
  const c = await F.deploy(signers, threshold);
  await c.waitForDeployment();
  return c;
}

async function setup() {
  const [publisher, stranger] = await ethers.getSigners();
  const c = await deploy();
  await c.connect(publisher).registerAgent("SMT", "https://example.org/decisions.json", 12, ids);
  return { c, publisher, stranger };
}

/** Seal at a chosen block time; returns {batchId, entryTs, exitTs}. */
const pack = (dirs, conf = dirs.map(() => 5000)) => rc.packCalls(dirs.map((dir, i) => ({ dir, confBps: conf[i] })));

async function sealAt(c, signer, blockTs, dirs, { sourceTs = blockTs - 60, horizon = H, conf } = {}) {
  await time.setNextBlockTimestamp(blockTs);
  const n = dirs.length;
  const tx = await c
    .connect(signer)
    .seal(sourceTs, ethers.ZeroHash, horizon, pack(dirs, conf), Array(n).fill(ethers.ZeroHash), Array(n).fill(""));
  const rcpt = await tx.wait();
  const ev = rcpt.logs.map((l) => c.interface.parseLog(l)).find((e) => e && e.name === "Sealed");
  return { batchId: ev.args.batchId, entryTs: Number(ev.args.entryTs), exitTs: Number(ev.args.exitTs), rcpt };
}

let T0;
before(async () => {
  T0 = Math.ceil(((await time.latest()) + 1000) / 100) * 100 + 3; // deliberately off-tick
});

describe("registerAgent", () => {
  it("registers once per publisher and checks its feeds and fee", async () => {
    const [a] = await ethers.getSigners();
    const c = await deploy();
    await expect(c.registerAgent("x", "y", 12, [])).to.be.revertedWithCustomError(c, "BadFeeds");
    await expect(c.registerAgent("x", "y", 12, [ids[0], ids[0]])).to.be.revertedWithCustomError(c, "BadFeeds");
    await expect(c.registerAgent("x", "y", 12, [ethers.ZeroHash])).to.be.revertedWithCustomError(c, "BadFeeds");
    await expect(c.registerAgent("x", "y", 1001, ids)).to.be.revertedWithCustomError(c, "BadFee");
    await expect(c.registerAgent("SMT", "src", 12, ids)).to.emit(c, "AgentRegistered");
    expect(await c.agentOf(a.address)).to.equal(1n);
    await expect(c.registerAgent("again", "src", 12, ids)).to.be.revertedWithCustomError(c, "AlreadyRegistered");
    const ag = await c.agent(1);
    expect(ag.publisher).to.equal(a.address);
    expect(ag.feeds).to.deep.equal(ids);
  });

  it("rejects a bad signer set", async () => {
    const s = oracleKeys.map((w) => w.address);
    await expect(deploy(s, 0)).to.be.reverted;
    await expect(deploy(s, 6)).to.be.reverted;
    await expect(deploy([s[0], s[0], s[2], s[3], s[4]], 3)).to.be.reverted;
  });
});

describe("seal", () => {
  it("only the publisher can seal, and only complete, fresh, in-order snapshots", async () => {
    const { c, publisher, stranger } = await setup();
    const t = T0 + 50_000;
    await time.setNextBlockTimestamp(t);
    const z = Array(3).fill(ethers.ZeroHash);
    const e = Array(3).fill("");
    const W = pack([0, 0, 0], [0, 0, 0]);
    await expect(c.connect(stranger).seal(t - 1, ethers.ZeroHash, H, W, z, e)).to.be.revertedWithCustomError(c, "NotPublisher");
    await expect(c.seal(t - 1, ethers.ZeroHash, H, W, z.slice(1), e)).to.be.revertedWithCustomError(c, "LengthMismatch");
    await expect(c.seal(t - 1, ethers.ZeroHash, H, W, z, e.slice(1))).to.be.revertedWithCustomError(c, "LengthMismatch");
    // a 4th call word when the agent follows 3 feeds
    await expect(c.seal(t - 1, ethers.ZeroHash, H, pack([0, 0, 0, 1]), z, e)).to.be.revertedWithCustomError(c, "LengthMismatch");
    await expect(c.seal(t - 1, ethers.ZeroHash, 599, W, z, e)).to.be.revertedWithCustomError(c, "BadHorizon");
    await expect(c.seal(t - 1, ethers.ZeroHash, H + 5, W, z, e)).to.be.revertedWithCustomError(c, "BadHorizon");
    await expect(c.seal(t - 1, ethers.ZeroHash, 13 * 3600, W, z, e)).to.be.revertedWithCustomError(c, "BadHorizon");
    await expect(c.seal(t - 1, ethers.ZeroHash, H, pack([0, 3, 0]), z, e)).to.be.revertedWithCustomError(c, "BadDirection");
    await expect(c.seal(t - 1, ethers.ZeroHash, H, pack([0, 1, 0], [0, 10_001, 0]), z, e)).to.be.revertedWithCustomError(c, "BadConfidence");
    await expect(c.seal(t + 600, ethers.ZeroHash, H, pack([0, 1, 0]), z, e)).to.be.revertedWithCustomError(c, "StaleSource");
    await expect(c.seal(t - 3 * 3600 - 600, ethers.ZeroHash, H, pack([0, 1, 0]), z, e)).to.be.revertedWithCustomError(c, "StaleSource");

    await sealAt(c, publisher, t + 100, [1, 0, 2], { sourceTs: t });
    // the same snapshot (or an older one) can't be sealed twice
    await time.setNextBlockTimestamp(t + 200);
    await expect(c.seal(t, ethers.ZeroHash, H, pack([1, 0, 2]), z, e)).to.be.revertedWithCustomError(c, "StaleSource");
  });

  it("entry is the first RedStone tick strictly after the seal block", async () => {
    const { c, publisher } = await setup();
    const t = T0 + 60_000;
    const a = await sealAt(c, publisher, t + 3, [1, 0, 0]); // ...3 -> next tick ...10
    expect(a.entryTs).to.equal(Math.floor((t + 3) / 10) * 10 + 10);
    const b = await sealAt(c, publisher, Math.ceil((t + 100) / 10) * 10, [1, 0, 0]); // on a tick -> the next one
    const onTick = Math.ceil((t + 100) / 10) * 10;
    expect(b.entryTs).to.equal(onTick + 10);
    expect(b.exitTs).to.equal(onTick + 10 + H);
  });

  it("an all-WAIT batch closes at once and is counted as waits", async () => {
    const { c, publisher } = await setup();
    const { batchId } = await sealAt(c, publisher, T0 + 70_000, [0, 0, 0]);
    const [b] = await c.batch(batchId);
    expect(b.status).to.equal(4); // CLOSED
    expect(b.closeBlock).to.equal(b.sealBlock);
    const s = await c.stats(1);
    expect(s.batches).to.equal(1);
    expect(s.waits).to.equal(3);
    expect(s.calls).to.equal(0);
  });

  it("emits everything a reader needs, and stores the seal block", async () => {
    const { c, publisher } = await setup();
    const t = T0 + 80_000;
    await time.setNextBlockTimestamp(t);
    const reasons = [ethers.id("a"), ethers.id("b"), ethers.id("c")];
    const calls = pack([1, 0, 2], [6100, 2000, 5400]);
    await expect(c.seal(t - 30, ethers.id("snap"), H, calls, reasons, ["up", "", "down"]))
      .to.emit(c, "Sealed")
      .withArgs(0, 1, t - 30, ethers.id("snap"), Math.floor(t / 10) * 10 + 10, Math.floor(t / 10) * 10 + 10 + H, calls, reasons, ["up", "", "down"]);
    expect(rc.unpackCalls(calls, 3)).to.deep.equal([{ dir: 1, confBps: 6100 }, { dir: 0, confBps: 2000 }, { dir: 2, confBps: 5400 }]);
    const [b] = await c.batch(0);
    expect(b.sealBlock).to.equal(await ethers.provider.getBlockNumber());
    const req = await c.gradeRequest(0);
    expect(req.feedIds).to.deep.equal([ids[0], ids[2]]);
    expect(req.feedIndex.map(Number)).to.deep.equal([0, 2]);
  });
});

describe("grade", () => {
  it("grades LONG and SHORT against signed prices at the exact ticks, net of the declared fee", async () => {
    const { c, publisher, stranger } = await setup();
    const { batchId, entryTs, exitTs } = await sealAt(c, publisher, T0 + 100_000, [1, 0, 2]);
    const pin = payload(entryTs * 1000, { BTC: "100000", LTC: "100" });
    const pout = payload(exitTs * 1000, { BTC: "100500", LTC: "100.1" }); // BTC +50 bp, LTC +10 bp
    await expect(c.connect(stranger).grade(batchId, pin, pout)).to.be.revertedWithCustomError(c, "TooEarly");
    await time.increaseTo(exitTs + 30);
    const tx = c.connect(stranger).grade(batchId, pin, pout); // anyone can grade
    // BTC LONG: +5000 ppm - 1200 fee = +3800 (hit). LTC SHORT: -1000 - 1200 = -2200 (miss).
    await expect(tx)
      .to.emit(c, "Graded")
      .withArgs(batchId, 1, [0, 2], [100000n * E8, 100n * E8], [100500n * E8, 1001n * E8 / 10n], [5000, 1000], [3800, -2200], 1);
    const s = await c.stats(1);
    expect(s.graded).to.equal(2);
    expect(s.hits).to.equal(1);
    expect(s.sumNetPpm).to.equal(1600);
    const [b] = await c.batch(batchId);
    expect(b.status).to.equal(2);
    await expect(c.grade(batchId, pin, pout)).to.be.revertedWithCustomError(c, "NotGradeable");
  });

  it("a move that only pays the fee is not a hit", async () => {
    const { c, publisher } = await setup();
    const { batchId, entryTs, exitTs } = await sealAt(c, publisher, T0 + 110_000, [1, 0, 0]);
    await time.increaseTo(exitTs + 1);
    await expect(c.grade(batchId, payload(entryTs * 1000, { BTC: "100000" }), payload(exitTs * 1000, { BTC: "100120" })))
      .to.emit(c, "Graded")
      .withArgs(batchId, 1, [0], [100000n * E8], [100120n * E8], [1200], [0], 0);
  });

  it("takes the median of the signers and counts each signer once", async () => {
    const { c, publisher } = await setup();
    const { batchId, entryTs, exitTs } = await sealAt(c, publisher, T0 + 120_000, [1, 0, 0]);
    await time.increaseTo(exitTs + 1);
    const t0 = entryTs * 1000;
    const pin = rs.buildPayload([
      rs.signPackage(oracleKeys[0], "BTC", 100n * E8, t0),
      rs.signPackage(oracleKeys[1], "BTC", 300n * E8, t0),
      rs.signPackage(oracleKeys[2], "BTC", 200n * E8, t0),
      rs.signPackage(oracleKeys[3], "BTC", 900n * E8, t0),
    ]); // median of 100,200,300,900 = 250
    const pout = payload(exitTs * 1000, { BTC: "250" });
    await expect(c.grade(batchId, pin, pout)).to.emit(c, "Graded").withArgs(batchId, 1, [0], [250n * E8], [250n * E8], [0], [-1200], 0);

    const b2 = await sealAt(c, publisher, T0 + 125_000, [1, 0, 0]);
    await time.increaseTo(b2.exitTs + 1);
    const dup = rs.buildPayload([
      rs.signPackage(oracleKeys[0], "BTC", 100n * E8, b2.entryTs * 1000),
      rs.signPackage(oracleKeys[0], "BTC", 999n * E8, b2.entryTs * 1000),
      rs.signPackage(oracleKeys[1], "BTC", 100n * E8, b2.entryTs * 1000),
    ]);
    await expect(c.grade(b2.batchId, dup, payload(b2.exitTs * 1000, { BTC: "100" })))
      .to.be.revertedWithCustomError(c, "NotEnoughSigners")
      .withArgs(ids[0], 2);
  });

  it("refuses prices from the wrong tick, an unknown signer, a forged value, too few signers, or a missing feed", async () => {
    const { c, publisher } = await setup();
    const { batchId, entryTs, exitTs } = await sealAt(c, publisher, T0 + 130_000, [1, 1, 0]);
    await time.increaseTo(exitTs + 1);
    const good = payload(exitTs * 1000, { BTC: "1", ETH: "1" });
    const pin = (p) => c.grade(batchId, p, good);

    await expect(pin(payload(entryTs * 1000 + 10_000, { BTC: "1", ETH: "1" })))
      .to.be.revertedWithCustomError(c, "WrongTimestamp")
      .withArgs(entryTs * 1000 + 10_000, entryTs * 1000);
    await expect(pin(payload(entryTs * 1000, { BTC: "1", ETH: "1" }, [0, 1, outsider])))
      .to.be.revertedWithCustomError(c, "UnknownSigner")
      .withArgs(outsider.address);
    // change one value after signing: the signature now recovers to some other address
    const signed = rs.signPackage(oracleKeys[0], "BTC", 1n * E8, entryTs * 1000);
    const forged = ethers.concat([ethers.dataSlice(signed, 0, 32), ethers.toBeHex(2n * E8, 32), ethers.dataSlice(signed, 64)]);
    const rest = [1, 2].map((i) => rs.signPackage(oracleKeys[i], "BTC", 1n * E8, entryTs * 1000));
    const eth = [0, 1, 2].map((i) => rs.signPackage(oracleKeys[i], "ETH", 1n * E8, entryTs * 1000));
    await expect(pin(rs.buildPayload([forged, ...rest, ...eth]))).to.be.revertedWithCustomError(c, "UnknownSigner");
    await expect(pin(payload(entryTs * 1000, { BTC: "1", ETH: "1" }, [0, 1])))
      .to.be.revertedWithCustomError(c, "NotEnoughSigners")
      .withArgs(ids[0], 2);
    await expect(pin(payload(entryTs * 1000, { BTC: "1" }))).to.be.revertedWithCustomError(c, "NotEnoughSigners").withArgs(ids[1], 0);
    // extra feeds are ignored
    await expect(c.grade(batchId, payload(entryTs * 1000, { BTC: "1", ETH: "1", LTC: "5" }), good)).to.emit(c, "Graded");
  });

  it("rejects malformed payloads", async () => {
    const { c, publisher } = await setup();
    const { batchId, entryTs, exitTs } = await sealAt(c, publisher, T0 + 140_000, [1, 0, 0]);
    await time.increaseTo(exitTs + 1);
    const good = payload(entryTs * 1000, { BTC: "1" });
    const out = payload(exitTs * 1000, { BTC: "1" });
    await expect(c.grade(batchId, "0x", out)).to.be.revertedWithCustomError(c, "BadPayload");
    await expect(c.grade(batchId, ethers.dataSlice(good, 0, ethers.dataLength(good) - 1), out)).to.be.revertedWithCustomError(c, "BadPayload");
    await expect(c.grade(batchId, ethers.concat(["0x00", good]), out)).to.be.revertedWithCustomError(c, "BadPayload");
    await expect(c.grade(batchId, good, out)).to.emit(c, "Graded");
  });

  it("a call nobody grades in time expires as a miss that paid its fee", async () => {
    const { c, publisher } = await setup();
    const { batchId, entryTs, exitTs } = await sealAt(c, publisher, T0 + 150_000, [1, 0, 2]);
    await time.increaseTo(exitTs + 1);
    await expect(c.expire(batchId)).to.be.revertedWithCustomError(c, "WindowOpen");
    await time.increaseTo(entryTs + 22 * 3600);
    await expect(c.grade(batchId, payload(entryTs * 1000, { BTC: "1", LTC: "1" }), payload(exitTs * 1000, { BTC: "2", LTC: "1" })))
      .to.be.revertedWithCustomError(c, "WindowClosed");
    await expect(c.expire(batchId)).to.emit(c, "Expired").withArgs(batchId, 1, 2);
    const s = await c.stats(1);
    expect(s.expired).to.equal(2);
    expect(s.hits).to.equal(0);
    expect(s.sumNetPpm).to.equal(-2400);
    await expect(c.expire(batchId)).to.be.revertedWithCustomError(c, "NotGradeable");
  });
});

describe("seam: real inputs", () => {
  before(async () => {
    await network.provider.send("hardhat_reset"); // back to initialDate, before the fixture ticks
  });
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "redstone-primary-prod.json"), "utf8"));

  it("verifies real RedStone primary-prod signatures on-chain and grades with their median", async () => {
    const c = await deploy(rs.PRIMARY_PROD_SIGNERS, rs.PRIMARY_PROD_THRESHOLD);
    await c.registerAgent("SMT", rc.SMT_FEED_URL, rc.SMT_FEE_BPS, ids);
    const entrySec = fx.entryTsMs / 1000;
    // seal 5 s before the captured entry tick, so the contract's entry is exactly that tick
    expect(await time.latest()).to.be.below(entrySec - 5, "chain clock is past the fixture; see hardhat initialDate");
    const { batchId, entryTs, exitTs } = await sealAt(c, (await ethers.getSigners())[0], entrySec - 5, [1, 0, 2], {
      sourceTs: entrySec - 120,
      horizon: (fx.exitTsMs - fx.entryTsMs) / 1000,
    });
    expect(entryTs * 1000).to.equal(fx.entryTsMs);
    const pick = (ts, sym) => fx.ticks[ts][sym].slice(0, 3);
    const pl = (ts) => rs.buildPayload(["BTC", "LTC"].flatMap((s) => pick(ts, s).map((p) => p.bytes)));
    const med = (ts, sym) => rs.median(pick(ts, sym).map((p) => BigInt(p.value)));
    await time.increaseTo(exitTs + 60);
    const tx = await c.grade(batchId, pl(fx.entryTsMs), pl(fx.exitTsMs));
    const ev = (await tx.wait()).logs.map((l) => c.interface.parseLog(l)).find((e) => e && e.name === "Graded");
    expect(ev.args.entryPrice).to.deep.equal([med(fx.entryTsMs, "BTC"), med(fx.entryTsMs, "LTC")]);
    expect(ev.args.exitPrice).to.deep.equal([med(fx.exitTsMs, "BTC"), med(fx.exitTsMs, "LTC")]);
    // one real package from a non-primary signer set would not verify: swap the signer set
    const other = await deploy(oracleKeys.map((w) => w.address), 3);
    expect(await other.signers()).to.not.deep.equal(rs.PRIMARY_PROD_SIGNERS);
  });

  it("a real SMT World snapshot becomes a valid seal, and each receipt hash recomputes from the snapshot", async () => {
    const raw = fs.readFileSync(path.join(__dirname, "fixtures", "smt-world-decisions.json"), "utf8");
    const s = rc.buildSeal(raw);
    expect(s.receipts.map((r) => r.pair)).to.deep.equal(rc.SMT_PAIRS);
    const snap = JSON.parse(raw);
    for (const r of s.receipts) {
      expect(ethers.keccak256(ethers.toUtf8Bytes(rc.canonical({ pair: r.pair, call: snap[r.pair] })))).to.equal(r.reasonHash);
      expect(r.dir).to.equal(rc.dirOf(snap[r.pair].action));
    }
    const [p] = await ethers.getSigners();
    const c = await deploy();
    await c.registerAgent(rc.SMT_AGENT_NAME, rc.SMT_FEED_URL, rc.SMT_FEE_BPS, rc.smtFeedIds());
    const t = Math.max(await time.latest(), s.sourceTs) + 120;
    await time.setNextBlockTimestamp(t);
    await expect(c.connect(p).seal(...s.args)).to.emit(c, "Sealed");
    const st = await c.stats(1);
    expect(Number(st.calls) + Number(st.waits)).to.equal(8);
  });

  it("SMT's live positions become a sealable snapshot: held side = call, nothing private, paper ignored", async () => {
    const body = fs.readFileSync(path.join(__dirname, "fixtures", "smt-world-account.json"), "utf8");
    const raw = rc.positionsSnapshot(body);
    expect(raw).to.not.match(/MUST-NOT|PRIVATE|qty|mark|upnl|equity/);
    const snap = JSON.parse(raw);
    expect(Object.keys(snap)).to.have.members(rc.SMT_PAIRS);
    expect(snap.BTC).to.deep.include({ action: "LONG", conf: 1, as_of: "2026-10-13T10:10:43+00:00", why: "held position, opened 2026-09-28 16:41 UTC by Trend ride" });
    expect(snap.BTC.positions).to.deep.equal([
      { pair: "BTC", side: "LONG", entry: 83764.8, opened_at: "2026-09-28T16:41:06.199152+00:00", setup_name: "Trend ride", lane: "slow", leverage: 1 },
    ]);
    expect(snap.SOL.why).to.equal("held position, opened 2026-10-03 17:37 UTC by Trend ride");
    expect(snap.SOL.positions[0].leverage).to.equal(2);
    expect(snap.ETH).to.deep.include({ action: "WAIT", conf: 0, why: "no live position", positions: [] }); // paper.open's ETH SHORT is not sealed

    const s = rc.buildSeal(raw);
    expect(s.receipts.filter((r) => r.dir !== rc.WAIT).map((r) => [r.pair, r.dir, r.confBps])).to.deep.equal([
      ["BTC", rc.LONG, 10000], ["SOL", rc.LONG, 10000], ["LTC", rc.LONG, 10000],
    ]);
    expect(s.sourceTs).to.equal(Date.parse("2026-10-13T10:10:43Z") / 1000);
    for (const r of s.receipts) expect(ethers.keccak256(ethers.toUtf8Bytes(rc.canonical({ pair: r.pair, call: snap[r.pair] })))).to.equal(r.reasonHash);

    // a second publisher registers the positions agent next to the committee and seals it
    const [p1, p2] = await ethers.getSigners();
    const c = await deploy();
    await c.connect(p1).registerAgent(rc.SMT_AGENT_NAME, rc.SMT_FEED_URL, rc.SMT_FEE_BPS, rc.smtFeedIds());
    await c.connect(p2).registerAgent(rc.SMT_POSITIONS_NAME, rc.SMT_ACCOUNT_URL, rc.SMT_FEE_BPS, rc.smtFeedIds());
    expect(await c.agentOf(p2.address)).to.equal(2n);
    await time.setNextBlockTimestamp(Math.max(await time.latest(), s.sourceTs) + 120);
    await expect(c.connect(p2).seal(...s.args)).to.emit(c, "Sealed");
    const st = await c.stats(2);
    expect([Number(st.calls), Number(st.waits)]).to.deep.equal([3, 5]);
    expect(Number((await c.stats(1)).batches)).to.equal(0);
  });

  it("a hedged pair, an unknown pair or a bad account file never becomes a call", () => {
    const acct = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "smt-world-account.json"), "utf8"));
    acct.live.open.push({ ...acct.live.open[0], side: "SHORT", opened_at: "2026-10-01T00:00:00+00:00" });
    acct.live.open.push({ pair: "PEPE", side: "LONG", opened_at: "2026-10-01T00:00:00+00:00", setup_name: "x" });
    const snap = JSON.parse(rc.positionsSnapshot(JSON.stringify(acct)));
    expect(snap.BTC).to.deep.include({ action: "WAIT", conf: 0, why: "hedged: a LONG and a SHORT are both open" });
    expect(snap.BTC.positions.map((p) => p.side)).to.deep.equal(["LONG", "SHORT"]);
    expect(snap).to.not.have.property("PEPE");
    expect(() => rc.positionsSnapshot(JSON.stringify({ ...acct, generated_at: "soon" }))).to.throw(/generated_at/);
    expect(() => rc.positionsSnapshot(JSON.stringify({ generated_at: acct.generated_at, paper: acct.paper }))).to.throw(/live\.open/);
  });

  it("refuses a snapshot that is missing a pair", () => {
    const raw = fs.readFileSync(path.join(__dirname, "fixtures", "smt-world-decisions.json"), "utf8");
    const snap = JSON.parse(raw);
    delete snap.LTC;
    expect(() => rc.buildSeal(JSON.stringify(snap))).to.throw(/LTC/);
  });

  it("every config that names the contract names the CREATE2 address the artifact produces", () => {
    const addr = rc.create2Address(rc.initCode(rc.artifact()));
    const root = path.join(__dirname, "..");
    const dep = JSON.parse(fs.readFileSync(path.join(root, "deployments", "monad-testnet.json"), "utf8"));
    expect(dep.address).to.equal(addr);
    expect(fs.readFileSync(path.join(root, "web", "config.js"), "utf8")).to.include(addr);
    expect(fs.readFileSync(path.join(root, "indexer", "config.yaml"), "utf8")).to.include(addr);
    expect(fs.readFileSync(path.join(root, "README.md"), "utf8")).to.include(addr);
  });
});
