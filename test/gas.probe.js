// Not part of the suite (run: npx hardhat test test/gas.probe.js). Prints EVM gas for each call.
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const fs = require("fs"); const path = require("path");
const rs = require("../lib/redstone"); const rc = require("../lib/receipts");
const keys = Array.from({ length: 5 }, (_, i) => new ethers.Wallet(ethers.id(`oracle-${i}`)));
it("gas", async () => {
  const F = await ethers.getContractFactory("SMTReceipts");
  const c = await F.deploy(keys.map(k => k.address), 3);
  const d = await c.deploymentTransaction().wait(); console.log("deploy", d.gasUsed);
  const r = await (await c.registerAgent(rc.SMT_AGENT_NAME, rc.SMT_FEED_URL, 12, rc.smtFeedIds())).wait(); console.log("register", r.gasUsed);
  const raw = fs.readFileSync(path.join(__dirname, "fixtures", "smt-world-decisions.json"), "utf8");
  let t = (await time.latest()) + 100;
  const results = {};
  for (const nDir of [0, 1, 2, 3]) {
    t += 4000;
    const s2 = JSON.parse(raw);
    rc.SMT_PAIRS.forEach((p, i) => { s2[p].action = i < nDir ? (i % 2 ? "SHORT" : "LONG") : "WAIT"; s2[p].as_of = new Date((t - 30) * 1000).toISOString(); });
    const sl = rc.buildSeal(JSON.stringify(s2), { horizon: 600 });
    await time.setNextBlockTimestamp(t);
    const sr = await (await c.seal(...sl.args)).wait();
    const ev = sr.logs.map(l => c.interface.parseLog(l)).find(e => e && e.name === "Sealed");
    results[`seal nDir=${nDir}`] = sr.gasUsed;
    if (nDir === 0) continue;
    await time.increaseTo(Number(ev.args.exitTs) + 5);
    const syms = rc.SMT_PAIRS.slice(0, nDir);
    const mk = (ts) => rs.buildPayload(syms.flatMap(s => [0,1,2].map(i => rs.signPackage(keys[i], s, 100n*10n**8n, ts))));
    const gr = await (await c.grade(ev.args.batchId, mk(Number(ev.args.entryTs)*1000), mk(Number(ev.args.exitTs)*1000))).wait();
    results[`grade nDir=${nDir}`] = gr.gasUsed;
    t = Number(ev.args.exitTs) + 10;
  }
  console.log(results);
});
