import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { loadConfig } from "./config.js";
import { FaucetStore } from "./database.js";
import { createFaucetServer } from "./server.js";
import { FaucetService } from "./service.js";
import { HttpFiberClient, HttpMintClient } from "./upstream.js";

const config = loadConfig();
const databasePath = resolve(config.databasePath);
mkdirSync(dirname(databasePath), { recursive: true });
const store = new FaucetStore(databasePath);
const mint = new HttpMintClient(config.mintApiUrl, config.upstreamTimeoutMs);
const fiber = new HttpFiberClient(config.fiberRpcUrl, config.upstreamTimeoutMs, config.maxFeeBaseUnits, config.maxFeeRate);
const service = new FaucetService(config, store, mint, fiber);
const server = createFaucetServer(config, service);

let reconciling = false;
const reconcile = async () => {
  if (reconciling) return;
  reconciling = true;
  try {
    await service.reconcileOpenClaims();
    store.scrub(config.sensitiveRetentionSeconds);
  } finally {
    reconciling = false;
  }
};
const runReconciliation = () => {
  void reconcile().catch(() => {
    process.stderr.write("Faucet reconciliation failed; the next scheduled pass will retry.\n");
  });
};
const timer = setInterval(runReconciliation, config.reconciliationIntervalSeconds * 1000);
timer.unref();
runReconciliation();

server.listen(config.port, config.host, () => {
  process.stdout.write(`FiberNuts testnet faucet listening on ${config.host}:${config.port}\n`);
});

function shutdown(): void {
  clearInterval(timer);
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
