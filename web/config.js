// Where the page reads from. The contract address is the CREATE2 address of the compiled
// contract (a test checks it matches deployments/monad-testnet.json).
window.SMT_RECEIPTS = {
  chainId: 10143,
  rpc: "https://testnet-rpc.monad.xyz",
  contract: "0xDF9f42AE4f81F086F8495c5a5339dDaa90057993",
  agentId: 1,
  explorer: "https://testnet.monadvision.com",
  // Envio Cloud GraphQL endpoint. Empty = read the chain directly (the page says so).
  // A ?envio=<url> query parameter overrides it.
  envioGraphql: "",
  archive: "https://raw.githubusercontent.com/JannetEkka/monad-hack/archive/batches/",
  repo: "https://github.com/JannetEkka/monad-hack",
  smtWorld: "https://smt-weex-trading-bot.jannet-ekka.workers.dev/",
  pairs: ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "LTC", "ADA"],
  recent: 24,
};
