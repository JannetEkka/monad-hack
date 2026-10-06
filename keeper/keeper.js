#!/usr/bin/env node
// SMT Receipts keeper. One run:
//   1. deploys the contract if its CREATE2 address is empty, registers SMT if it isn't yet;
//   2. SEAL   - seals the newest public SMT World snapshot (all 8 pairs, WAITs included);
//   3. GRADE  - grades every batch whose horizon has passed, with RedStone-signed prices;
//   4. EXPIRE - closes batches nobody graded inside the window (they count as misses).
// Every action is one log line starting with a tag: [DEPLOY] [REGISTER] [SEAL] [GRADE]
// [EXPIRE] [BUDGET] [ERROR]. The key comes only from KEEPER_PRIVATE_KEY.
//
//   node keeper/keeper.js            act
//   node keeper/keeper.js --dry-run  read everything, build every transaction, send nothing
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const rc = require("../lib/receipts");
const rs = require("../lib/redstone");

const env = process.env;
const RPC = env.MONAD_RPC_URL || "https://testnet-rpc.monad.xyz";
const CHAIN_ID = 10143;
const EXPLORER = "https://testnet.monadvision.com";
const FEED_URL = env.FEED_URL || rc.SMT_FEED_URL;
const HORIZON = Number(env.HORIZON_SECONDS || rc.DEFAULT_HORIZON_S);
const LOOKBACK = Number(env.GRADE_LOOKBACK || 72);
// Seal at most once per this many minutes (by SMT World's publish time). 50 = every hourly
// snapshot; raise it (repo variable SEAL_EVERY_MIN) to stretch a small faucet drip.
const SEAL_EVERY_MIN = Number(env.SEAL_EVERY_MIN || 50);
const MIN_BALANCE = ethers.parseEther(env.MIN_BALANCE_MON || "0.05");
const ARCHIVE_DIR = env.ARCHIVE_DIR || path.join(__dirname, "..", "archive-out");
const GRADE_DELAY_S = 30; // let the exit tick reach the gateway before asking for it
// MetaMask exports a key as 64 hex characters without 0x; accept either, and stray whitespace
const KEY = (() => {
  const k = String(env.KEEPER_PRIVATE_KEY || "").trim();
  return k ? (k.startsWith("0x") ? k : `0x${k}`) : "";
})();
const DRY = process.argv.includes("--dry-run") || !KEY;

const summary = [];
let failed = false;
const say = (line) => {
  console.log(line);
  summary.push(line);
};
const fail = (line) => {
  failed = true;
  say(`[ERROR] ${line}`);
};
const pct = (bps) => `${(bps / 100).toFixed(0)}%`;
const bp = (ppm) => `${ppm >= 0 ? "+" : ""}${(Number(ppm) / 100).toFixed(2)} bp`;
const iso = (s) => new Date(Number(s) * 1000).toISOString().replace(".000Z", "Z");

async function send(wallet, label, txReq) {
  const est = await wallet.estimateGas(txReq);
  const gasLimit = (est * 12n) / 10n + 5_000n; // Monad charges the limit, so keep it tight
  if (DRY) {
    say(`  (dry run) would send ${label}: ~${est} gas`);
    return null;
  }
  const tx = await wallet.sendTransaction({ ...txReq, gasLimit });
  const rcpt = await tx.wait();
  if (rcpt.status !== 1) throw new Error(`${label} reverted: ${tx.hash}`);
  return rcpt;
}

async function main() {
  // cacheTimeout -1: ethers otherwise answers a repeated read from a 250 ms cache, which hides
  // a contract deployed a moment ago
  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true, cacheTimeout: -1 });
  const wallet = KEY ? new ethers.Wallet(KEY, provider) : ethers.Wallet.createRandom().connect(provider);
  if (!KEY) {
    say("[BUDGET] KEEPER_PRIVATE_KEY is not set: dry run only, nothing will be sealed or graded");
  }

  const art = rc.artifact();
  const initCode = rc.initCode(art);
  const address = rc.create2Address(initCode);
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "monad-testnet.json"), "utf8"));
  if (dep.address !== address) {
    throw new Error(`deployments/monad-testnet.json says ${dep.address}, the compiled contract is ${address}: run node scripts/address.js`);
  }
  const c = new ethers.Contract(address, art.abi, wallet);
  const balance0 = await provider.getBalance(wallet.address);
  say(`keeper ${wallet.address} · balance ${ethers.formatEther(balance0)} MON · contract ${address}`);

  // ── 1. deploy + register (idempotent) ──────────────────────────────────────────────────
  const deployed = (await provider.getCode(address)) !== "0x";
  if (!deployed) {
    say(`[DEPLOY] no code at ${address}: deploying through the CREATE2 proxy`);
    const r = await send(wallet, "deploy", { to: rc.CREATE2_PROXY, data: ethers.concat([rc.SALT, initCode]) });
    if (r) {
      if ((await provider.getCode(address)) === "0x") {
        throw new Error(`deploy mined (status ${r.status}, ${r.gasUsed} gas, block ${r.blockNumber}) but there is no code at ${address}`);
      }
      say(`[DEPLOY] ✅ ${address} · tx ${EXPLORER}/tx/${r.hash}`);
    }
  }
  let agentId = deployed || !DRY ? Number(await c.agentOf(wallet.address)) : 0;
  if (agentId === 0) {
    const args = [rc.SMT_AGENT_NAME, FEED_URL, rc.SMT_FEE_BPS, rc.smtFeedIds()];
    if (deployed || !DRY) {
      const r = await send(wallet, "registerAgent", { to: address, data: c.interface.encodeFunctionData("registerAgent", args) });
      if (r) {
        agentId = Number(await c.agentOf(wallet.address));
        say(`[REGISTER] ✅ agent ${agentId} "${rc.SMT_AGENT_NAME}" · ${rc.SMT_PAIRS.join(" ")} · fee ${rc.SMT_FEE_BPS} bp`);
      }
    } else {
      say(`  (dry run) would register "${rc.SMT_AGENT_NAME}" for ${rc.SMT_PAIRS.join(" ")}`);
    }
  }

  // ── 2. seal ─────────────────────────────────────────────────────────────────────────────
  try {
    await sealStep({ provider, wallet, c, address, agentId, balance: balance0 });
  } catch (e) {
    fail(`seal: ${e.shortMessage || e.message}`);
  }

  // ── 3 + 4. grade / expire ────────────────────────────────────────────────────────────────
  if (agentId !== 0) {
    try {
      await gradeStep({ provider, wallet, c, agentId });
    } catch (e) {
      fail(`grade: ${e.shortMessage || e.message}`);
    }
  }

  const balance1 = await provider.getBalance(wallet.address);
  say(`balance ${ethers.formatEther(balance1)} MON (spent ${ethers.formatEther(balance0 - balance1)} this run)`);
  if (balance1 < MIN_BALANCE) {
    say(`[BUDGET] ⚠️ balance below ${ethers.formatEther(MIN_BALANCE)} MON: sealing pauses until the keeper is topped up (grading continues)`);
  }
}

async function sealStep({ provider, wallet, c, address, agentId, balance }) {
  if (balance < MIN_BALANCE && !DRY) {
    say(`[SEAL] skipped: balance ${ethers.formatEther(balance)} MON is under ${ethers.formatEther(MIN_BALANCE)} MON, kept for grading`);
    return;
  }
  const res = await fetch(FEED_URL, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`SMT World feed answered HTTP ${res.status}`);
  const raw = await res.text();
  const fetchedAt = new Date().toISOString();
  const s = rc.buildSeal(raw, { horizon: HORIZON });
  const now = (await provider.getBlock("latest")).timestamp;
  const ageMin = Math.round((now - s.sourceTs) / 60);
  const last = agentId ? Number((await c.agent(agentId)).lastSourceTs) : 0;
  const calls = s.receipts
    .filter((r) => r.dir !== rc.WAIT)
    .map((r) => `${r.pair} ${rc.DIR_NAME[r.dir]} ${pct(r.confBps)}`);
  const line = `${calls.length ? calls.join(", ") : "all WAIT"} (${8 - calls.length} WAIT)`;

  if (s.sourceTs <= last) {
    say(`[SEAL] skipped: SMT World has not published since the last seal (as_of ${iso(s.sourceTs)}, ${ageMin} min old)`);
    return;
  }
  if (last && s.sourceTs - last < SEAL_EVERY_MIN * 60) {
    say(`[SEAL] skipped: last seal was ${Math.round((s.sourceTs - last) / 60)} min of SMT time ago; sealing every ${SEAL_EVERY_MIN} min`);
    return;
  }
  if (now - s.sourceTs > 3 * 3600 - 120) {
    say(`[SEAL] skipped: ⚠️ the SMT World snapshot is ${ageMin} min old; a receipt has to be fresh (≤ 3 h). Is the bot publishing?`);
    return;
  }
  if (!agentId) {
    say(`  (dry run) would seal as_of ${iso(s.sourceTs)}: ${line}`);
    return;
  }
  const r = await send(wallet, "seal", { to: await c.getAddress(), data: c.interface.encodeFunctionData("seal", s.args) });
  if (!r) {
    say(`  (dry run) would seal as_of ${iso(s.sourceTs)}: ${line}`);
    return;
  }
  const ev = r.logs.map((l) => safeParse(c, l)).find((e) => e && e.name === "Sealed");
  const batchId = Number(ev.args.batchId);
  say(`[SEAL] ✅ batch ${batchId} · as_of ${iso(s.sourceTs)} · ${line} · entry ${iso(ev.args.entryTs)} → exit ${iso(ev.args.exitTs)} · ${EXPLORER}/tx/${r.hash}`);

  fs.mkdirSync(path.join(ARCHIVE_DIR, "batches"), { recursive: true });
  const record = {
    schema: 1,
    chainId: CHAIN_ID,
    contract: address,
    batchId,
    agentId,
    txHash: r.hash,
    sealBlock: r.blockNumber,
    entryTs: Number(ev.args.entryTs),
    exitTs: Number(ev.args.exitTs),
    horizon: HORIZON,
    source: { url: FEED_URL, fetchedAt, sourceTs: s.sourceTs, snapshotHash: s.snapshotHash, raw },
    receipts: s.receipts.map(({ pair, dir, confBps, reasonHash, canonical }) => ({ pair, dir, confBps, reasonHash, canonical })),
  };
  fs.writeFileSync(path.join(ARCHIVE_DIR, "batches", `${batchId}.json`), JSON.stringify(record, null, 1) + "\n");
}

async function gradeStep({ provider, wallet, c, agentId }) {
  const count = Number(await c.batchCount());
  const now = (await provider.getBlock("latest")).timestamp;
  const window = Number(await c.GRADE_WINDOW());
  let pending = 0;
  for (let id = Math.max(0, count - LOOKBACK); id < count; id++) {
    const [b, entryTs, exitTs] = await c.batch(id);
    if (Number(b.agentId) !== agentId || Number(b.status) !== 1) continue;
    const entry = Number(entryTs);
    const exit = Number(exitTs);
    if (now >= entry + window) {
      const r = await send(wallet, `expire ${id}`, { to: await c.getAddress(), data: c.interface.encodeFunctionData("expire", [id]) });
      say(`[EXPIRE] batch ${id}: ${b.nDir} call(s) never graded inside the window → counted as misses${r ? ` · ${EXPLORER}/tx/${r.hash}` : ""}`);
      continue;
    }
    if (now < exit + GRADE_DELAY_S) {
      pending++;
      continue;
    }
    try {
      const req = await c.gradeRequest(id);
      const symbols = req.feedIds.map((f) => ethers.decodeBytes32String(f));
      const pin = await rs.payloadAt(Number(req.entryTsMs), symbols);
      const pout = await rs.payloadAt(Number(req.exitTsMs), symbols);
      const r = await send(wallet, `grade ${id}`, {
        to: await c.getAddress(),
        data: c.interface.encodeFunctionData("grade", [id, pin.payload, pout.payload]),
      });
      if (!r) {
        const preview = symbols.map((sym) => {
          const m = Number(((pout.prices[sym] - pin.prices[sym]) * 1_000_000n) / pin.prices[sym]);
          return `${sym} ${bp(m)} move`;
        });
        say(`  (dry run) would grade batch ${id}: ${preview.join(", ")}`);
        continue;
      }
      const ev = r.logs.map((l) => safeParse(c, l)).find((e) => e && e.name === "Graded");
      const parts = ev.args.feedIndex.map((fi, k) => {
        const sym = rc.SMT_PAIRS[Number(fi)];
        const net = Number(ev.args.netPpm[k]);
        return `${sym} ${net > 0 ? "✓" : "✗"} ${bp(net)} net`;
      });
      say(`[GRADE] ✅ batch ${id} · ${parts.join(", ")} · ${EXPLORER}/tx/${r.hash}`);
    } catch (e) {
      fail(`grade batch ${id}: ${e.shortMessage || e.message}`);
    }
  }
  say(`[GRADE] ${pending} batch(es) still inside their horizon`);
  const st = await c.stats(agentId);
  const scored = Number(st.graded) + Number(st.expired);
  if (scored > 0) {
    say(
      `scoreboard: ${st.hits}/${scored} hits net of fees (${((100 * Number(st.hits)) / scored).toFixed(1)}%) · ` +
        `avg ${bp(Number(st.sumNetPpm) / scored)} per call · ${st.expired} expired · ${st.waits} waits · ${st.batches} batches`
    );
  }
}

function safeParse(c, log) {
  try {
    return c.interface.parseLog(log);
  } catch {
    return null;
  }
}

main()
  .catch((e) => fail(e.shortMessage || e.message))
  .finally(() => {
    if (env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(env.GITHUB_STEP_SUMMARY, ["### SMT Receipts keeper", "", ...summary.map((l) => `- ${l}`), ""].join("\n"));
    }
    process.exitCode = failed ? 1 : 0;
  });
