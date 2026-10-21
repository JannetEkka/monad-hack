// Where the page reads from. The contract address is the CREATE2 address of the compiled
// contract (a test checks it matches deployments/monad-testnet.json).
window.SMT_RECEIPTS = {
  chainId: 10143,
  rpc: "https://testnet-rpc.monad.xyz",
  contract: "0xDF9f42AE4f81F086F8495c5a5339dDaa90057993",
  agentId: 1,
  // One tab per agent. Both are SMT; the positions agent signs with its own derived key.
  agents: [
    {
      id: 1,
      label: "Committee calls",
      note: "SMT World's hourly committee vote on each coin, with its reason. SMT labels these advisory: its written setups decide its trades.",
      feedNote: "One slip per hourly snapshot: all eight coins, in the order SMT registered them. Tap a line for its reason and its proof.",
    },
    {
      id: 2,
      label: "Held positions",
      held: true,
      note: "The positions SMT actually holds on its exchange account, sealed as LONG or SHORT and graded over the next four hours. Coins it doesn't hold are WAIT.",
      feedNote: "One slip every four hours (and whenever a position opens or closes), so no two receipts grade the same price move. Tap a line for the position and its proof.",
    },
  ],
  explorer: "https://testnet.monadvision.com",
  // Envio Cloud GraphQL endpoint (deployment eb5fcaa). Empty = read the chain directly (the
  // page says so). A ?envio=<url> query parameter overrides it.
  envioGraphql: "https://indexer.dev.hyperindex.xyz/e5478c3/v1/graphql",
  archive: "https://raw.githubusercontent.com/JannetEkka/monad-hack/archive/batches/",
  repo: "https://github.com/JannetEkka/monad-hack",
  smtWorld: "https://smt-weex-trading-bot.jannet-ekka.workers.dev/",
  pairs: ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "LTC", "ADA"],
  recent: 24,
};
