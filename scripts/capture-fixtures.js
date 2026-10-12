// Capture real inputs for the tests: one public SMT World snapshot and RedStone-signed packages
// at two exact ticks one hour apart. Run: node scripts/capture-fixtures.js
const fs = require("fs");
const path = require("path");
const { fetchPackagesAt, TICK_MS } = require("../lib/redstone");
const { SMT_FEED_URL } = require("../lib/receipts");

(async () => {
  const dir = path.join(__dirname, "..", "test", "fixtures");
  const body = await (await fetch(SMT_FEED_URL)).text();
  fs.writeFileSync(path.join(dir, "smt-world-decisions.json"), body);
  const entry = Math.floor((Date.now() - 3 * 3600e3) / TICK_MS) * TICK_MS;
  const exit = entry + 3600e3;
  const out = { entryTsMs: entry, exitTsMs: exit, ticks: {} };
  for (const ts of [entry, exit]) {
    const pk = await fetchPackagesAt(ts, ["BTC", "ETH", "LTC"]);
    out.ticks[ts] = Object.fromEntries(
      Object.entries(pk).map(([s, list]) => [s, list.map((p) => ({ signer: p.signer, index: p.index, value: p.value.toString(), bytes: p.bytes }))])
    );
  }
  fs.writeFileSync(path.join(dir, "redstone-primary-prod.json"), JSON.stringify(out, null, 1));
  console.log("captured", new Date(entry).toISOString(), "->", new Date(exit).toISOString(),
    Object.fromEntries(Object.entries(out.ticks[entry]).map(([s, l]) => [s, l.length])));
})();
