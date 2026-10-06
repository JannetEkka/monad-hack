// Print the CREATE2 address the compiled contract will have on any chain with the canonical
// deterministic-deployment proxy, and write it to deployments/monad-testnet.json.
// Run after `npx hardhat compile`: node scripts/address.js
const fs = require("fs");
const path = require("path");
const rc = require("../lib/receipts");
const rs = require("../lib/redstone");

const code = rc.initCode(rc.artifact());
const address = rc.create2Address(code);
const file = path.join(__dirname, "..", "deployments", "monad-testnet.json");
const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const out = {
  ...prev,
  chainId: 10143,
  address,
  create2Proxy: rc.CREATE2_PROXY,
  salt: rc.SALT,
  initCodeHash: require("ethers").ethers.keccak256(code),
  oracle: { dataService: rs.DATA_SERVICE, signers: rs.PRIMARY_PROD_SIGNERS, threshold: rs.PRIMARY_PROD_THRESHOLD },
};
fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
// every other file that names the contract
for (const rel of ["web/config.js", "indexer/config.yaml", "README.md"]) {
  const f = path.join(__dirname, "..", rel);
  const text = fs.readFileSync(f, "utf8");
  const next = prev.address ? text.split(prev.address).join(address) : text;
  if (next !== text) fs.writeFileSync(f, next);
  if (!next.includes(address)) console.error(`${rel} does not name ${address}: fix it by hand`);
}
console.log(address);
