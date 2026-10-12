// End-to-end rehearsal with no wallet and no testnet funds:
//   a local node running HOURS BEHIND real time with Monad testnet's chain id,
//   the canonical CREATE2 proxy injected at its real address,
//   the real keeper (keeper/keeper.js) sealing a real SMT World snapshot,
//   then grading it with RedStone's REAL signed history, verified by the contract.
// Run: node scripts/e2e-local.js [--serve]   (--serve keeps the node + page up for a browser)
const { spawn, execFile } = require("child_process");
const { promisify } = require("util");
const execFileP = promisify(execFile);
const http = require("http");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const LAG_H = 6; // node clock = real time minus this
const PORT_RPC = 8545;
const PORT_WEB = 8099;
const KEY0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // hardhat account #0
// Runtime code of the deterministic-deployment proxy that Monad testnet has at 0x4e59...56c
const PROXY_CODE = "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const serve = process.argv.includes("--serve");
  const out = path.join(ROOT, "archive-e2e");
  fs.rmSync(out, { recursive: true, force: true });
  const startIso = new Date(Date.now() - LAG_H * 3600e3).toISOString();
  const node = spawn("npx", ["hardhat", "node", "--port", String(PORT_RPC)], {
    cwd: ROOT, env: { ...process.env, HH_INITIAL_DATE: startIso, HH_CHAIN_ID: "10143" }, stdio: "ignore", detached: true,
  });
  const stopNode = () => { try { process.kill(-node.pid); } catch {} };
  process.on("exit", () => { if (!serve) stopNode(); });
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT_RPC}`, 10143, { staticNetwork: true });
  for (let i = 0; i < 60; i++) { try { await provider.getBlockNumber(); break; } catch { await sleep(500); } }
  await provider.send("hardhat_setCode", ["0x4e59b44847b379578588920ca78fbf26c0b4956c", PROXY_CODE]);

  // the public snapshot, re-dated into the node's clock; two calls made directional so there is something to grade
  const nodeNow = (await provider.getBlock("latest")).timestamp;
  const snap = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "fixtures", "smt-world-decisions.json"), "utf8"));
  for (const p of Object.keys(snap)) snap[p].as_of = new Date((nodeNow - 300) * 1000).toISOString();
  snap.BTC.action = "LONG";
  snap.LTC.action = "SHORT";
  const body = JSON.stringify(snap, null, 2);

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/decisions.json") { res.setHeader("content-type", "application/json"); return res.end(body); }
    const file = u.pathname.startsWith("/archive/") ? path.join(out, u.pathname.slice(9)) : path.join(ROOT, "web", u.pathname === "/" ? "index.html" : u.pathname);
    if (!fs.existsSync(file)) { res.statusCode = 404; return res.end("not found"); }
    const ext = path.extname(file);
    res.setHeader("content-type", { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" }[ext] || "application/octet-stream");
    res.setHeader("access-control-allow-origin", "*");
    fs.createReadStream(file).pipe(res);
  }).listen(PORT_WEB);

  // async: the feed and archive server above lives in this process and must keep answering
  const keeper = async (extra = {}) =>
    (await execFileP("node", ["keeper/keeper.js"], {
      cwd: ROOT, encoding: "utf8",
      env: { ...process.env, KEEPER_PRIVATE_KEY: KEY0, MONAD_RPC_URL: `http://127.0.0.1:${PORT_RPC}`, FEED_URL: `http://127.0.0.1:${PORT_WEB}/decisions.json`, HORIZON_SECONDS: "600", ARCHIVE_DIR: out, ...extra },
    })).stdout;
  let ok = false;
  try {
    console.log("── run 1: deploy, register, seal");
    console.log(await keeper());
    await provider.send("evm_increaseTime", [700]);
    await provider.send("evm_mine", []);
    console.log("── run 2: grade with RedStone's real signed history");
    console.log(await keeper());
    const art = require(path.join(ROOT, "artifacts/contracts/SMTReceipts.sol/SMTReceipts.json"));
    const addr = require(path.join(ROOT, "deployments/monad-testnet.json")).address;
    const c = new ethers.Contract(addr, art.abi, provider);
    const st = await c.stats(1);
    const [b] = await c.batch(0);
    ok = Number(st.graded) === 2 && Number(b.status) === 2 && fs.existsSync(path.join(out, "batches", "0.json"));
    console.log(`── result: batch 0 status ${b.status}, graded ${st.graded}, hits ${st.hits}, sumNetPpm ${st.sumNetPpm} → ${ok ? "PASS" : "FAIL"}`);
  } catch (e) {
    console.error(e.stdout || "", e.stderr || "", e.message);
  }
  if (serve) {
    console.log(`page: http://127.0.0.1:${PORT_WEB}/?rpc=http://127.0.0.1:${PORT_RPC}&archive=http://127.0.0.1:${PORT_WEB}/archive/batches/`);
    return;
  }
  server.close();
  stopNode();
  process.exit(ok ? 0 : 1);
})();
