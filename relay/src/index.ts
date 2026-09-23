import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { loadConfig } from "./config.js";
import { RelayStore } from "./database.js";
import { createRelayServer } from "./server.js";

const config = loadConfig();
const databasePath = resolve(config.databasePath);
mkdirSync(dirname(databasePath), { recursive: true });
const store = new RelayStore(databasePath);
store.cleanup(config.retentionSeconds);
const cleanup = setInterval(() => store.cleanup(config.retentionSeconds), 60_000);
cleanup.unref();

const server = createRelayServer(config, store);
server.listen(config.port, config.host, () => {
  process.stdout.write(`FiberNuts payment relay listening on ${config.host}:${config.port}\n`);
});

function shutdown(): void {
  clearInterval(cleanup);
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
