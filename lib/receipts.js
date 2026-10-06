// What a receipt commits to, and the deterministic contract address.
//
// A receipt's reasonHash is keccak256 of the canonical JSON of the agent's published row for
// that pair: {"pair": "...", "call": <the row exactly as published>}, keys sorted at every
// level, no whitespace. Anyone holding the published snapshot can recompute it.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { PRIMARY_PROD_SIGNERS, PRIMARY_PROD_THRESHOLD, feedId } = require("./redstone");

// SMT's eight pairs, in the order the agent registered them. Never reorder: the order is
// part of the agent's on-chain registration.
const SMT_PAIRS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "LTC", "ADA"];
// The public SMT World feed: the per-pair committee call and its plain-language "why".
const SMT_FEED_URL = "https://smt-weex-trading-bot.jannet-ekka.workers.dev/decisions.json";
const SMT_AGENT_NAME = "SMT - Smart Money Trading";
// Round-trip taker cost on the venue SMT trades (0.06% each way). A call has to beat it.
const SMT_FEE_BPS = 12;
const DEFAULT_HORIZON_S = 4 * 3600;

const WAIT = 0;
const LONG = 1;
const SHORT = 2;
const DIR_NAME = ["WAIT", "LONG", "SHORT"];

// CREATE2 through the deterministic-deployment proxy that Monad testnet ships as a canonical
// contract. No owner and no constructor input but the oracle signer set, so the address is
// known before anyone deploys, and whoever deploys it gets the same ownerless contract.
const CREATE2_PROXY = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const SALT = ethers.id("SMT Receipts v1");

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const dirOf = (action) => {
  const a = String(action || "").toUpperCase();
  return a === "LONG" ? LONG : a === "SHORT" ? SHORT : WAIT;
};

const confBps = (conf) => {
  const x = Math.round(Number(conf) * 10_000);
  return Number.isFinite(x) ? Math.max(0, Math.min(10_000, x)) : 0;
};

/**
 * Turn one published snapshot (the raw body text) into the arguments of seal().
 * Throws, rather than guessing, if a pair is missing: a batch has to cover every pair.
 */
function buildSeal(rawBody, { pairs = SMT_PAIRS, horizon = DEFAULT_HORIZON_S } = {}) {
  const snap = JSON.parse(rawBody);
  const missing = pairs.filter((p) => !snap[p] || typeof snap[p] !== "object");
  if (missing.length) throw new Error(`snapshot has no row for ${missing.join(", ")}`);
  let sourceMs = 0;
  const receipts = pairs.map((pair) => {
    const row = snap[pair];
    const t = Date.parse(row.as_of);
    if (!Number.isFinite(t)) throw new Error(`${pair}: as_of "${row.as_of}" is not a timestamp`);
    sourceMs = Math.max(sourceMs, t);
    const canon = canonical({ pair, call: row });
    const dir = dirOf(row.action);
    return {
      pair,
      dir,
      confBps: confBps(row.conf),
      reasonHash: ethers.keccak256(ethers.toUtf8Bytes(canon)),
      why: dir === WAIT ? "" : String(row.why || "").slice(0, 600),
      canonical: canon,
    };
  });
  return {
    sourceTs: Math.floor(sourceMs / 1000),
    snapshotHash: ethers.keccak256(ethers.toUtf8Bytes(rawBody)),
    horizon,
    receipts,
    args: [
      Math.floor(sourceMs / 1000),
      ethers.keccak256(ethers.toUtf8Bytes(rawBody)),
      horizon,
      packCalls(receipts),
      receipts.map((r) => r.reasonHash),
      receipts.map((r) => r.why),
    ],
  };
}

/** seal()'s `calls` word: feed i in bits [16i, 16i+16) = direction << 14 | convictionBps. */
function packCalls(list) {
  return list.reduce((acc, r, i) => acc | ((BigInt(r.dir) << 14n) | BigInt(r.confBps)) << BigInt(16 * i), 0n);
}

function unpackCalls(word, n) {
  const w = BigInt(word);
  return Array.from({ length: n }, (_, i) => {
    const x = (w >> BigInt(16 * i)) & 0xffffn;
    return { dir: Number(x >> 14n), confBps: Number(x & 0x3fffn) };
  });
}

function artifact() {
  const p = path.join(__dirname, "..", "artifacts", "contracts", "SMTReceipts.sol", "SMTReceipts.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function initCode(art = artifact(), signers = PRIMARY_PROD_SIGNERS, threshold = PRIMARY_PROD_THRESHOLD) {
  const args = ethers.AbiCoder.defaultAbiCoder().encode(["address[5]", "uint8"], [signers, threshold]);
  return ethers.concat([art.bytecode, args]);
}

function create2Address(code = initCode()) {
  return ethers.getCreate2Address(CREATE2_PROXY, SALT, ethers.keccak256(code));
}

module.exports = {
  SMT_PAIRS,
  SMT_FEED_URL,
  SMT_AGENT_NAME,
  SMT_FEE_BPS,
  DEFAULT_HORIZON_S,
  WAIT,
  LONG,
  SHORT,
  DIR_NAME,
  CREATE2_PROXY,
  SALT,
  canonical,
  dirOf,
  confBps,
  buildSeal,
  packCalls,
  unpackCalls,
  artifact,
  initCode,
  create2Address,
  smtFeedIds: () => SMT_PAIRS.map(feedId),
};
