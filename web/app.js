// SMT Receipts page. Reads the scoreboard from Envio when an endpoint is configured, and
// straight from the contract otherwise; the pill in the header always says which.
(() => {
  const qs0 = new URLSearchParams(location.search);
  // ?rpc= and ?archive= let a local rehearsal point the same page at a local node
  const C = { ...window.SMT_RECEIPTS, ...(qs0.get("rpc") ? { rpc: qs0.get("rpc") } : {}), ...(qs0.get("archive") ? { archive: qs0.get("archive") } : {}) };
  const E = window.ethers;
  const $ = (s) => document.querySelector(s);
  const qs = new URLSearchParams(location.search);
  const ENVIO = qs.get("envio") || C.envioGraphql;

  const ABI = [
    "function agentCount() view returns (uint256)",
    "function agent(uint256) view returns (address publisher, uint16 feeBps, uint40 lastSourceTs, string name, string source, bytes32[] feeds)",
    "function stats(uint256) view returns (uint32 batches, uint32 calls, uint32 waits, uint32 graded, uint32 hits, uint32 expired, int64 sumNetPpm)",
    "function batchCount() view returns (uint256)",
    "function batch(uint256) view returns (tuple(uint32 agentId, uint40 sealedAt, uint32 horizon, uint32 dirs, uint8 nDir, uint8 status, uint40 sealBlock, uint40 closeBlock) b, uint256 entryTs, uint256 exitTs)",
    "event Sealed(uint256 indexed batchId, uint256 indexed agentId, uint64 sourceTs, bytes32 snapshotHash, uint64 entryTs, uint64 exitTs, uint256 calls, bytes32[] reasonHashes, string[] whys)",
    "event Graded(uint256 indexed batchId, uint256 indexed agentId, uint8[] feedIndex, uint256[] entryPrice, uint256[] exitPrice, int32[] movePpm, int32[] netPpm, uint8 hits)",
    "event Expired(uint256 indexed batchId, uint256 indexed agentId, uint8 missed)",
  ];
  const STATUS = { 1: "SEALED", 2: "GRADED", 3: "EXPIRED", 4: "CLOSED" };
  const DIR = ["WAIT", "LONG", "SHORT"];
  const iface = new E.Interface(ABI);

  // ── formatting ────────────────────────────────────────────────────────────────────────
  const bp = (ppm) => {
    if (ppm == null || !isFinite(ppm)) return "—";
    const x = Number(ppm) / 100;
    return `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(Math.abs(x) < 10 ? 2 : 1)} bp`;
  };
  const pct = (x) => (x == null || !isFinite(x) ? "—" : `${(100 * x).toFixed(1)}%`);
  const when = (s) =>
    new Date(Number(s) * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  const utc = (s) => new Date(Number(s) * 1000).toISOString().replace(".000Z", " UTC").replace("T", " ");
  const px = (v) => (v == null ? "—" : Number(E.formatUnits(BigInt(v), 8)).toLocaleString(undefined, { maximumSignificantDigits: 8 }));
  const short = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "—");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const txLink = (h) => (h ? `<a href="${C.explorer}/tx/${h}" target="_blank" rel="noopener">${short(h)}</a>` : "—");
  const canonical = (v) =>
    Array.isArray(v)
      ? `[${v.map(canonical).join(",")}]`
      : v && typeof v === "object"
        ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
        : JSON.stringify(v);
  const symbolOf = (b32) => {
    try { return E.decodeBytes32String(b32); } catch { return b32; }
  };

  // ── data: Envio ───────────────────────────────────────────────────────────────────────
  async function fromEnvio() {
    const query = `query($a: String!, $n: Int!) {
      Agent(where: {id: {_eq: $a}}) { name source feeBps pairs batches calls waits graded hits expired sumNetPpm lastSealedAt
        pairStats { pair longs shorts waits graded hits expired sumNetPpm } }
      Batch(where: {agent_id: {_eq: $a}}, order_by: {batchId: desc}, limit: $n) {
        batchId sourceTs sealedAt sealBlock sealTx snapshotHash entryTs exitTs status nDir hits closeTx closedAt
        receipts(order_by: {feedIndex: asc}) { feedIndex pair direction confBps reasonHash why status entryPrice exitPrice movePpm netPpm } } }`;
    const r = await fetch(ENVIO, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { a: String(C.agentId), n: C.recent } }),
      signal: AbortSignal.timeout(12000),
    });
    const j = await r.json();
    if (j.errors || !j.data) throw new Error(j.errors ? j.errors[0].message : `HTTP ${r.status}`);
    const a = j.data.Agent[0];
    if (!a) return { source: "envio", agent: null, pairStats: [], batches: [] };
    const num = (x) => (x == null ? null : Number(x));
    return {
      source: "envio",
      agent: { ...a, sumNetPpm: Number(a.sumNetPpm) },
      pairStats: a.pairStats.map((p) => ({ ...p, sumNetPpm: Number(p.sumNetPpm) })),
      pairStatsComplete: true,
      batches: j.data.Batch.map((b) => ({
        ...b,
        batchId: Number(b.batchId),
        receipts: b.receipts.map((x) => ({ ...x, movePpm: num(x.movePpm), netPpm: num(x.netPpm) })),
      })),
    };
  }

  // ── data: the chain itself ──────────────────────────────────────────────────────────
  async function fromChain() {
    const provider = new E.JsonRpcProvider(C.rpc, C.chainId, { staticNetwork: true, batchMaxCount: 20 });
    if ((await provider.getCode(C.contract)) === "0x") return { source: "chain", deployed: false, agent: null, pairStats: [], batches: [] };
    const c = new E.Contract(C.contract, ABI, provider);
    if (Number(await c.agentCount()) < C.agentId) return { source: "chain", deployed: true, agent: null, pairStats: [], batches: [] };
    const [ag, st, count] = await Promise.all([c.agent(C.agentId), c.stats(C.agentId), c.batchCount()]);
    const pairs = ag.feeds.map(symbolOf);
    const agent = {
      name: ag.name, source: ag.source, feeBps: Number(ag.feeBps), pairs,
      batches: Number(st.batches), calls: Number(st.calls), waits: Number(st.waits), graded: Number(st.graded),
      hits: Number(st.hits), expired: Number(st.expired), sumNetPpm: Number(st.sumNetPpm),
    };
    const n = Number(count);
    const ids = [];
    for (let i = n - 1; i >= 0 && ids.length < C.recent; i--) ids.push(i);
    const raw = await Promise.all(ids.map((i) => c.batch(i).then((r) => ({ i, r }))));
    const mine = raw.filter(({ r }) => Number(r.b.agentId) === C.agentId);
    const topicId = (i) => E.zeroPadValue(E.toBeHex(i), 32);
    const tSealed = iface.getEvent("Sealed").topicHash;
    const tClose = [iface.getEvent("Graded").topicHash, iface.getEvent("Expired").topicHash];
    const batches = await Promise.all(
      mine.map(async ({ i, r }) => {
        const sealBlock = Number(r.b.sealBlock);
        const closeBlock = Number(r.b.closeBlock);
        const status = STATUS[Number(r.b.status)];
        const [sealLogs, closeLogs] = await Promise.all([
          provider.getLogs({ address: C.contract, fromBlock: sealBlock, toBlock: sealBlock, topics: [tSealed, topicId(i)] }),
          (status === "GRADED" || status === "EXPIRED") && closeBlock
            ? provider.getLogs({ address: C.contract, fromBlock: closeBlock, toBlock: closeBlock, topics: [tClose, topicId(i)] })
            : Promise.resolve([]),
        ]);
        const s = iface.parseLog(sealLogs[0]);
        const close = closeLogs[0] ? iface.parseLog(closeLogs[0]) : null;
        const receipts = pairs.map((pair, k) => {
          const w = (BigInt(s.args.calls) >> BigInt(16 * k)) & 0xffffn;
          const direction = DIR[Number(w >> 14n)] || "WAIT";
          return {
            feedIndex: k, pair, direction, confBps: Number(w & 0x3fffn), reasonHash: s.args.reasonHashes[k], why: s.args.whys[k],
            status: direction === "WAIT" ? "WAIT" : status === "EXPIRED" ? "EXPIRED" : "PENDING",
            entryPrice: null, exitPrice: null, movePpm: null, netPpm: status === "EXPIRED" && direction !== "WAIT" ? -agent.feeBps * 100 : null,
          };
        });
        if (close && close.name === "Graded") {
          close.args.feedIndex.forEach((fi, k) => {
            const x = receipts[Number(fi)];
            x.entryPrice = close.args.entryPrice[k].toString();
            x.exitPrice = close.args.exitPrice[k].toString();
            x.movePpm = Number(close.args.movePpm[k]);
            x.netPpm = Number(close.args.netPpm[k]);
            x.status = x.netPpm > 0 ? "HIT" : "MISS";
          });
        }
        return {
          batchId: i, sealedAt: Number(r.b.sealedAt), sourceTs: Number(s.args.sourceTs), sealBlock, sealTx: sealLogs[0].transactionHash,
          snapshotHash: s.args.snapshotHash, entryTs: Number(r.entryTs), exitTs: Number(r.exitTs), status, nDir: Number(r.b.nDir),
          hits: close && close.name === "Graded" ? Number(close.args.hits) : 0, closeTx: closeLogs[0]?.transactionHash || null, receipts,
        };
      })
    );
    // per-pair figures from the batches loaded here (the agent totals above are complete)
    const ps = Object.fromEntries(pairs.map((p) => [p, { pair: p, longs: 0, shorts: 0, waits: 0, graded: 0, hits: 0, expired: 0, sumNetPpm: 0 }]));
    for (const b of batches)
      for (const x of b.receipts) {
        const p = ps[x.pair];
        if (x.direction === "LONG") p.longs++; else if (x.direction === "SHORT") p.shorts++; else p.waits++;
        if (x.status === "HIT" || x.status === "MISS") { p.graded++; p.hits += x.status === "HIT"; p.sumNetPpm += x.netPpm; }
        if (x.status === "EXPIRED") { p.expired++; p.sumNetPpm += x.netPpm; }
      }
    return { source: "chain", deployed: true, agent, pairStats: Object.values(ps), pairStatsComplete: n <= C.recent, batches };
  }

  // ── render ────────────────────────────────────────────────────────────────────────────
  function renderSource(state, note) {
    const el = $("#source");
    if (state.source === "envio") {
      el.textContent = "live · via Envio";
      el.className = "pill ok";
      el.title = `Indexed by Envio HyperIndex: ${ENVIO}`;
    } else {
      el.textContent = "live · read from chain";
      el.className = "pill warn";
      el.title = "Read straight from the contract over Monad's public RPC";
    }
    if (note) {
      const b = $("#banner");
      b.hidden = false;
      b.textContent = note;
    }
  }

  function renderTiles(state) {
    const a = state.agent;
    if (!a) {
      $("#tiles").innerHTML = `<div class="empty" style="grid-column:1/-1">${
        state.deployed === false
          ? `The contract is not deployed yet. Its address is already fixed (<code>${C.contract}</code>); the keeper deploys it on its first run.`
          : "No receipts yet: the keeper's first seal is on its way."
      }</div>`;
      return;
    }
    const scored = a.graded + a.expired;
    const pending = a.calls - scored;
    const tiles = [
      { k: "Hit rate, net of fees", v: scored ? pct(a.hits / scored) : "—", s: scored ? `${a.hits} of ${scored} calls beat the ${a.feeBps} bp round trip` : "no call has reached its horizon yet", gold: true },
      { k: "Average per call", v: scored ? bp(a.sumNetPpm / scored) : "—", s: "price move in the call's direction, minus fees" },
      { k: "Calls made", v: a.calls, s: `${a.graded} graded · ${a.expired} expired · ${pending} pending` },
      { k: "WAITs sealed", v: a.waits, s: "sitting out is on the record too" },
      { k: "Snapshots sealed", v: a.batches, s: a.pairs.join(" · ") },
    ];
    $("#tiles").innerHTML = tiles
      .map((t) => `<div class="tile ${t.gold ? "gold" : ""}"><div class="k">${t.k}</div><div class="v">${t.v}</div><div class="s">${esc(t.s)}</div></div>`)
      .join("");
  }

  function renderPairs(state) {
    const rows = state.pairStats.map((p) => {
      const scored = p.graded + p.expired;
      const avg = scored ? p.sumNetPpm / scored : null;
      return `<tr><td>${esc(p.pair)}</td><td>${p.longs}</td><td>${p.shorts}</td><td>${p.waits}</td><td>${p.graded}${p.expired ? ` <span class="muted">+${p.expired} exp</span>` : ""}</td>
        <td>${p.hits}</td><td>${scored ? pct(p.hits / scored) : "—"}</td><td class="${avg == null ? "" : avg > 0 ? "pos" : "neg"}">${bp(avg)}</td></tr>`;
    });
    $("#pairs tbody").innerHTML = rows.join("") || `<tr><td colspan="8" class="muted">No calls yet.</td></tr>`;
    $("#pairsNote").textContent = state.pairStatsComplete === false ? `Per-pair figures cover the latest ${C.recent} snapshots read from the chain; the tiles above cover all of them.` : "";
  }

  function resultText(x) {
    if (x.status === "WAIT") return "sat out";
    if (x.status === "PENDING") return "pending";
    if (x.status === "EXPIRED") return "expired";
    return `${x.status === "HIT" ? "✓" : "✗"} ${bp(x.netPpm)}`;
  }

  function renderSlips(state) {
    if (!state.batches.length) {
      $("#slips").innerHTML = `<div class="empty">Nothing sealed yet.</div>`;
      return;
    }
    $("#slips").innerHTML = state.batches
      .map((b) => {
        const lag = Math.max(0, Math.round((b.sealedAt - b.sourceTs) / 60));
        const lines = b.receipts
          .map(
            (x) => `<button class="line" data-b="${b.batchId}" data-i="${x.feedIndex}" aria-label="${x.pair} ${x.direction} details">
              <span class="pair">${esc(x.pair)}</span><span class="dir ${x.direction}">${x.direction}</span>
              <span class="conf">${(x.confBps / 100).toFixed(0)}%</span><span class="res ${x.status}">${resultText(x)}</span></button>`
          )
          .join("");
        const exit = b.status === "SEALED" ? `grades after ${when(b.exitTs)}` : b.status === "CLOSED" ? "all WAIT · nothing to grade" : `${b.status.toLowerCase()}`;
        return `<article class="slip">
          <h3><span>Receipt #${b.batchId}</span><span>${when(b.sealedAt)}</span></h3>
          <div class="meta">SMT published ${when(b.sourceTs)} · sealed ${lag} min later</div>
          <span class="stamp ${b.status}">${b.status}</span>
          <div class="rule"></div>${lines}<div class="rule"></div>
          <div class="foot"><span>${exit}</span><span>seal ${txLink(b.sealTx)}</span></div>
        </article>`;
      })
      .join("");
    $("#slips").onclick = (ev) => {
      const btn = ev.target.closest(".line");
      if (!btn) return;
      const b = state.batches.find((x) => x.batchId === Number(btn.dataset.b));
      openDetail(b, b.receipts[Number(btn.dataset.i)]);
    };
  }

  function openDetail(b, x) {
    const graded = x.status === "HIT" || x.status === "MISS";
    const rows = [
      ["Call", `${x.direction} · conviction ${(x.confBps / 100).toFixed(0)}%`],
      ["Published by SMT", utc(b.sourceTs)],
      ["Sealed on Monad", `${utc(b.sealedAt)} · ${txLink(b.sealTx)}`],
      ["Entry tick", `${utc(b.entryTs)}${graded ? ` · ${px(x.entryPrice)}` : ""}`],
      ["Exit tick", `${utc(b.exitTs)}${graded ? ` · ${px(x.exitPrice)}` : ""}`],
    ];
    if (graded) {
      rows.push(["Price move", bp(x.movePpm)]);
      rows.push(["Net of fees", `${bp(x.netPpm)} · ${x.status}`]);
      rows.push(["Graded in", txLink(b.closeTx)]);
    } else if (x.status === "EXPIRED") {
      rows.push(["Result", `nobody graded it inside the window: counted as a miss (${bp(x.netPpm)}) · ${txLink(b.closeTx)}`]);
    } else if (x.status === "PENDING") {
      rows.push(["Result", `waiting for the exit tick; anyone can grade it after ${utc(b.exitTs)}`]);
    }
    rows.push(["Reason hash", `<code>${x.reasonHash}</code>`]);
    rows.push(["Snapshot hash", `<code>${b.snapshotHash}</code>`]);
    $("#detailBody").innerHTML = `
      <h2 class="d-title" id="dTitle">${esc(x.pair)} <span class="dir ${x.direction}">${x.direction}</span></h2>
      <div class="d-sub">Receipt #${b.batchId} · line ${x.feedIndex + 1} of ${b.receipts.length}</div>
      ${x.why ? `<p class="why">${esc(x.why)}</p>` : `<p class="why">WAIT: the committee sat this one out. Its full reasoning is in the sealed snapshot; press Verify to read it.</p>`}
      <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
      <div class="verify"><button id="verifyBtn">Verify this receipt in my browser</button>
        <button id="chainBtn" class="alt">Show the on-chain record</button><ul class="checks" id="checks"></ul><pre class="chain" id="chain" hidden></pre></div>`;
    $("#verifyBtn").onclick = () => verify(b, x);
    $("#chainBtn").onclick = () => chainRecord(b);
    $("#detail").showModal();
  }

  // The seal (and grade) transactions read straight from Monad's RPC and decoded here: the
  // explorers put a bot check in front of scripted browsers, the chain itself does not.
  async function chainRecord(b) {
    const el = $("#chain");
    el.hidden = false;
    el.textContent = "reading Monad…";
    const provider = new E.JsonRpcProvider(C.rpc, C.chainId, { staticNetwork: true });
    const pairs = b.receipts.map((r) => r.pair);
    const lines = [];
    for (const [label, hash] of [["seal", b.sealTx], ["grade", b.closeTx && b.closeTx !== b.sealTx ? b.closeTx : null]]) {
      if (!hash) continue;
      const [tx, rc] = await Promise.all([provider.getTransaction(hash), provider.getTransactionReceipt(hash)]);
      const blk = await provider.getBlock(rc.blockNumber);
      lines.push(`── ${label} transaction ──`, `hash    ${hash}`, `block   ${rc.blockNumber.toLocaleString()} · ${utc(blk.timestamp)}`,
        `from    ${tx.from}`, `to      ${tx.to}  (SMTReceipts)`, `gas     ${rc.gasUsed.toLocaleString()} used · status ${rc.status === 1 ? "success" : "REVERTED"}`);
      for (const log of rc.logs) {
        if (log.address.toLowerCase() !== C.contract.toLowerCase()) continue;
        const ev = iface.parseLog(log);
        if (!ev) continue;
        lines.push(`event   ${ev.name}(batchId ${ev.args.batchId})`);
        if (ev.name === "Sealed") {
          const w = BigInt(ev.args.calls);
          lines.push(`  sourceTs  ${utc(ev.args.sourceTs)}`, `  entry     ${utc(ev.args.entryTs)}   exit ${utc(ev.args.exitTs)}`,
            `  calls     ${pairs.map((p, k) => { const v = (w >> BigInt(16 * k)) & 0xffffn; return `${p} ${DIR[Number(v >> 14n)]} ${(Number(v & 0x3fffn) / 100).toFixed(0)}%`; }).join(" · ")}`,
            `  snapshot  ${ev.args.snapshotHash}`, ...ev.args.reasonHashes.map((h, k) => `  reason ${pairs[k].padEnd(4)} ${h}`));
        } else if (ev.name === "Graded") {
          ev.args.feedIndex.forEach((fi, k) => lines.push(`  ${pairs[Number(fi)].padEnd(4)} entry ${px(ev.args.entryPrice[k])} → exit ${px(ev.args.exitPrice[k])} · move ${bp(Number(ev.args.movePpm[k]))} · net ${bp(Number(ev.args.netPpm[k]))}`));
        } else if (ev.name === "Expired") {
          lines.push(`  ${ev.args.missed} call(s) counted as misses`);
        }
      }
    }
    el.textContent = lines.join("\n");
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function verify(b, x) {
    const out = $("#checks");
    const add = (ok, text) => out.insertAdjacentHTML("beforeend", `<li class="${ok === null ? "" : ok ? "ok" : "bad"}">${text}</li>`);
    out.innerHTML = "";
    let rec;
    try {
      const r = await fetch(`${C.archive}${b.batchId}.json`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      rec = await r.json();
    } catch (e) {
      add(false, `Could not load the archived snapshot (${esc(e.message)}). The on-chain hashes above still stand; they just can't be recomputed without it.`);
      return;
    }
    const raw = rec.source.raw;
    const snapHash = E.keccak256(E.toUtf8Bytes(raw));
    add(snapHash === b.snapshotHash, `The archived SMT World snapshot hashes to the snapshot hash sealed on-chain (${short(snapHash)}).`);
    let snap;
    try { snap = JSON.parse(raw); } catch { add(false, "The archived snapshot is not valid JSON."); return; }
    const row = snap[x.pair];
    const canon = canonical({ pair: x.pair, call: row });
    const h = E.keccak256(E.toUtf8Bytes(canon));
    add(h === x.reasonHash, `${esc(x.pair)}'s published row hashes to this line's reason hash (${short(h)}).`);
    const act = String(row?.action || "").toUpperCase();
    const dir = act === "LONG" || act === "SHORT" ? act : "WAIT";
    add(dir === x.direction, `SMT World said <b>${esc(row?.action)}</b> at ${(Number(row?.conf) * 100).toFixed(0)}% conviction; the seal says <b>${x.direction}</b> at ${(x.confBps / 100).toFixed(0)}%.`);
    add(null, `Published ${esc(row?.as_of)}; sealed ${utc(b.sealedAt)}; entry price signed at ${utc(b.entryTs)}, after the seal.`);
    if (row?.why) add(null, `SMT's words: “${esc(row.why)}”`);
    if (row?.votes) {
      const v = Object.entries(row.votes).map(([k, val]) => `${esc(k)} ${esc(val[0])} ${(Number(val[1]) * 100).toFixed(0)}%`).join(" · ");
      add(null, `Committee votes: ${v}`);
    }
  }

  // ── boot ──────────────────────────────────────────────────────────────────────────────
  async function load() {
    let state;
    let note = "";
    if (ENVIO) {
      try {
        state = await fromEnvio();
      } catch (e) {
        note = `Envio did not answer (${e.message}), so this page is reading the contract directly. Same data, fewer per-pair totals.`;
      }
    }
    if (!state) state = await fromChain();
    renderSource(state, note);
    renderTiles(state);
    renderPairs(state);
    renderSlips(state);
  }

  $("#contractLink").href = `${C.explorer}/address/${C.contract}`;
  $("#repoLink").href = C.repo;
  $("#worldLink").href = C.smtWorld;
  load().catch((e) => {
    $("#source").textContent = "offline";
    const b = $("#banner");
    b.hidden = false;
    b.textContent = `Could not read the receipts: ${e.message}`;
  });
  setInterval(() => load().catch(() => {}), 120000);
})();
