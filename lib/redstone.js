// RedStone signed price packages: fetch them from the public gateway, check each signature
// locally, and serialise them into the payload SMTReceipts.sol verifies on-chain.
//
// Used by the keeper (real packages), the tests (packages signed with local keys) and the
// web page (which only reads). No API key: the gateway is public.
const { ethers } = require("ethers");

// The "redstone-primary-prod" data service: its five authorised signers, in RedStone's own
// index order (PrimaryProdDataServiceConsumerBase), and its threshold of three.
const PRIMARY_PROD_SIGNERS = [
  "0x8BB8F32Df04c8b654987DAaeD53D6B6091e3B774",
  "0xdEB22f54738d54976C4c0fe5ce6d408E40d88499",
  "0x51Ce04Be4b3E32572C4Ec9135221d0691Ba7d202",
  "0xDD682daEC5A90dD295d14DA4b0bec9281017b5bE",
  "0x9c5AE89C4Af6aA32cE58588DBaF90d18a855B6de",
];
const PRIMARY_PROD_THRESHOLD = 3;
const DATA_SERVICE = "redstone-primary-prod";
// gateway-2 serves /v2 historical packages (about 24 h of history, 10-second-aligned
// timestamps only); gateway-1 answers the same paths with a placeholder, so it is a
// second try, not a peer.
const GATEWAYS = [
  "https://oracle-gateway-2.a.redstone.finance",
  "https://oracle-gateway-1.a.redstone.finance",
];
const MARKER = "0x000002ed57011e0000";
const TICK_MS = 10_000;
const DECIMALS = 8;

const feedId = (symbol) => ethers.encodeBytes32String(symbol);

/** Bytes the signer signs: [feedId:32][value:32][timestampMs:6][valueByteSize:4][pointsCount:3]. */
function signableBytes(symbol, value, tsMs) {
  return ethers.concat([
    feedId(symbol),
    ethers.toBeHex(value, 32),
    ethers.toBeHex(tsMs, 6),
    ethers.toBeHex(32, 4),
    ethers.toBeHex(1, 3),
  ]);
}

/** A decimal price as the gateway prints it -> the 8-decimal integer RedStone signed. */
function scaleValue(v) {
  const s = typeof v === "string" ? v : Number(v).toFixed(DECIMALS).replace(/\.?0+$/, "");
  return ethers.parseUnits(s, DECIMALS);
}

/** One signed package, ready to concatenate into a payload. */
function packageBytes(symbol, value, tsMs, signature65) {
  return ethers.concat([signableBytes(symbol, value, tsMs), signature65]);
}

/** [package]... [count:2] [unsignedMetadata:0] [0:3] [marker:9] */
function buildPayload(packages) {
  return ethers.concat([...packages, ethers.toBeHex(packages.length, 2), ethers.toBeHex(0, 3), MARKER]);
}

/** Sign a package with a local key (tests only). */
function signPackage(wallet, symbol, value, tsMs) {
  const digest = ethers.keccak256(signableBytes(symbol, value, tsMs));
  return packageBytes(symbol, value, tsMs, wallet.signingKey.sign(digest).serialized);
}

async function fetchJson(url, { timeoutMs = 30_000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    const text = await r.text();
    try {
      return { status: r.status, json: JSON.parse(text) };
    } catch {
      return { status: r.status, json: null, text };
    }
  } finally {
    clearTimeout(t);
  }
}

/**
 * Signed packages for `symbols` at exactly `tsMs` (a 10-second boundary), each signature
 * checked locally against the authorised set. Returns {symbol: [{signer, index, value, bytes}]}
 * sorted by signer index. Throws if the gateway has nothing for that tick.
 */
async function fetchPackagesAt(tsMs, symbols, { gateways = GATEWAYS, signers = PRIMARY_PROD_SIGNERS } = {}) {
  if (tsMs % TICK_MS !== 0) throw new Error(`timestamp ${tsMs} is not on a 10-second boundary`);
  const errors = [];
  for (const g of gateways) {
    const url = `${g}/v2/data-packages/historical/${DATA_SERVICE}/${tsMs}`;
    let res;
    try {
      res = await fetchJson(url);
    } catch (e) {
      errors.push(`${g}: ${e.message}`);
      continue;
    }
    if (!res.json || typeof res.json !== "object" || !res.json[symbols[0]]) {
      errors.push(`${g}: HTTP ${res.status} ${(res.text || JSON.stringify(res.json) || "").slice(0, 120)}`);
      continue;
    }
    const out = {};
    for (const sym of symbols) {
      const list = [];
      for (const p of res.json[sym] || []) {
        const dp = (p.dataPoints || [])[0];
        if (!dp || dp.dataFeedId !== sym || Number(p.timestampMilliseconds) !== tsMs) continue;
        const index = signers.findIndex((s) => s.toLowerCase() === String(p.signerAddress).toLowerCase());
        if (index < 0) continue;
        const value = scaleValue(dp.value);
        const sig = ethers.hexlify(ethers.decodeBase64(p.signature));
        const digest = ethers.keccak256(signableBytes(sym, value, tsMs));
        let recovered;
        try {
          recovered = ethers.recoverAddress(digest, sig);
        } catch {
          continue;
        }
        if (recovered.toLowerCase() !== signers[index].toLowerCase()) continue; // never send what won't verify
        list.push({ signer: signers[index], index, value, bytes: packageBytes(sym, value, tsMs, sig) });
      }
      list.sort((a, b) => a.index - b.index);
      out[sym] = list;
    }
    return out;
  }
  throw new Error(`no RedStone packages for ${tsMs}: ${errors.join(" | ")}`);
}

/**
 * The payload a grade transaction carries for one tick. Our keeper always takes the
 * `threshold` lowest-index signers that have a valid package, so it never picks among prices.
 */
async function payloadAt(tsMs, symbols, { threshold = PRIMARY_PROD_THRESHOLD, ...opts } = {}) {
  if (symbols.length === 0) return { payload: "0x", prices: {} };
  const pk = await fetchPackagesAt(tsMs, symbols, opts);
  const packages = [];
  const prices = {};
  for (const sym of symbols) {
    const chosen = (pk[sym] || []).slice(0, threshold);
    if (chosen.length < threshold) {
      throw new Error(`${sym} @ ${tsMs}: only ${chosen.length} valid signer(s), need ${threshold}`);
    }
    for (const c of chosen) packages.push(c.bytes);
    prices[sym] = median(chosen.map((c) => c.value));
  }
  return { payload: buildPayload(packages), prices };
}

function median(values) {
  const v = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = v.length;
  return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2n;
}

module.exports = {
  PRIMARY_PROD_SIGNERS,
  PRIMARY_PROD_THRESHOLD,
  DATA_SERVICE,
  GATEWAYS,
  TICK_MS,
  DECIMALS,
  feedId,
  signableBytes,
  scaleValue,
  packageBytes,
  buildPayload,
  signPackage,
  fetchPackagesAt,
  payloadAt,
  median,
};
