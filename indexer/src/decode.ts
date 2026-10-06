// Pure decoders shared by the handlers and the tests.

/** bytes32("BTC") -> "BTC" */
export function symbolOf(feed: string): string {
  let out = "";
  for (let i = 2; i + 1 < feed.length; i += 2) {
    const code = parseInt(feed.slice(i, i + 2), 16);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}

/** The seal's `calls` word: feed i in bits [16i, 16i+16) = direction << 14 | convictionBps. */
export function unpackCall(calls: bigint, i: number): { direction: number; confBps: number } {
  const word = (calls >> BigInt(16 * i)) & 0xffffn;
  return { direction: Number(word >> 14n), confBps: Number(word & 0x3fffn) };
}

