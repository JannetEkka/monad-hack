require("@nomicfoundation/hardhat-toolbox");

// The compiler settings are part of the deployed address (CREATE2 over the init code), so
// changing any of them moves the contract. scripts/address.js prints the address they produce.
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "cancun",
      // the default "ipfs" metadata hash stays: Sourcify (MonadVision) needs it for a full match.
      // It also means ANY edit to SMTReceipts.sol, comments included, moves the address.
    },
  },
  networks: {
    // Tests replay real RedStone packages captured on 2026-10-06, so the local chain has to
    // start before them.
    // scripts/e2e-local.js runs a node hours behind real time with Monad's chain id, so the
    // keeper can grade against RedStone's real signed history.
    hardhat: {
      initialDate: process.env.HH_INITIAL_DATE || "2026-10-01T00:00:00Z",
      chainId: Number(process.env.HH_CHAIN_ID || 31337),
    },
    monadTestnet: {
      url: process.env.MONAD_RPC_URL || "https://testnet-rpc.monad.xyz",
      chainId: 10143,
      accounts: process.env.KEEPER_PRIVATE_KEY ? [process.env.KEEPER_PRIVATE_KEY] : [],
    },
  },
  sourcify: { enabled: true, apiUrl: "https://sourcify-api-monad.blockvision.org", browserUrl: "https://testnet.monadvision.com" },
  etherscan: { enabled: false },
};
