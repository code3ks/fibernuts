export interface FaucetConfig {
  host: string;
  port: number;
  databasePath: string;
  publicOrigin: string;
  allowedOrigins: Set<string>;
  mintUrl: string;
  mintApiUrl: string;
  fiberRpcUrl: string;
  enabled: boolean;
  amount: number;
  unit: "rusd";
  network: "testnet";
  unitScale: number;
  invoiceCurrency: "Fibt";
  udtScript: {
    codeHash: string;
    hashType: "type";
    args: string;
  };
  clientCooldownSeconds: number;
  networkDailyClaimLimit: number;
  dailyClaimLimit: number;
  maxRequestsPerMinute: number;
  maxFeeBaseUnits: number;
  maxFeeRate: number;
  recoveryDelaySeconds: number;
  reconciliationIntervalSeconds: number;
  sensitiveRetentionSeconds: number;
  upstreamTimeoutMs: number;
  bodyLimitBytes: number;
  identifierSecret: string;
  trustProxy: boolean;
}

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function flag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function httpUrl(name: string, raw: string | undefined, options: { productionHttps?: boolean } = {}): string {
  if (!raw) throw new Error(`${name} is required.`);
  const parsed = new URL(raw);
  if (!(["https:", "http:"].includes(parsed.protocol)) || parsed.username || parsed.password) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials.`);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${name} must not contain a path, query, or fragment.`);
  }
  if (options.productionHttps && process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS in production.`);
  }
  return parsed.origin;
}

export function loadConfig(): FaucetConfig {
  const publicOrigin = httpUrl(
    "FIBERNUTS_FAUCET_PUBLIC_ORIGIN",
    process.env.FIBERNUTS_FAUCET_PUBLIC_ORIGIN ?? "http://127.0.0.1:8091",
    { productionHttps: true },
  );
  const mintUrl = httpUrl(
    "FIBERNUTS_FAUCET_MINT_URL",
    process.env.FIBERNUTS_FAUCET_MINT_URL ?? "http://127.0.0.1:8085",
    { productionHttps: true },
  );
  const mintApiUrl = httpUrl(
    "FIBERNUTS_FAUCET_MINT_API_URL",
    process.env.FIBERNUTS_FAUCET_MINT_API_URL ?? mintUrl,
  );
  const fiberRpcUrl = httpUrl(
    "FIBERNUTS_FAUCET_FIBER_RPC",
    process.env.FIBERNUTS_FAUCET_FIBER_RPC ?? "http://127.0.0.1:8227",
  );
  const allowedOrigins = new Set(
    (process.env.FIBERNUTS_FAUCET_ALLOWED_ORIGINS ?? "http://127.0.0.1:5175")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => httpUrl("FIBERNUTS_FAUCET_ALLOWED_ORIGINS", value, { productionHttps: true })),
  );
  if (allowedOrigins.size === 0) throw new Error("At least one allowed browser origin is required.");

  const identifierSecret = process.env.FIBERNUTS_FAUCET_IDENTIFIER_SECRET ?? "local-faucet-identifier-secret-change-me";
  if (process.env.NODE_ENV === "production" && !/^[a-f0-9]{64}$/i.test(identifierSecret)) {
    throw new Error("FIBERNUTS_FAUCET_IDENTIFIER_SECRET must be a random 64-character hex value in production.");
  }
  const clientCooldownSeconds = integer("FIBERNUTS_FAUCET_CLIENT_COOLDOWN_SECONDS", 86_400, 60, 2_592_000);
  const sensitiveRetentionSeconds = integer("FIBERNUTS_FAUCET_SENSITIVE_RETENTION_SECONDS", 604_800, 3600, 2_592_000);
  if (sensitiveRetentionSeconds < clientCooldownSeconds) {
    throw new Error("FIBERNUTS_FAUCET_SENSITIVE_RETENTION_SECONDS must not be shorter than the client cooldown.");
  }

  return {
    host: process.env.FIBERNUTS_FAUCET_HOST ?? "127.0.0.1",
    port: integer("FIBERNUTS_FAUCET_PORT", 8091, 1, 65535),
    databasePath: process.env.FIBERNUTS_FAUCET_DATABASE ?? "./data/faucet.sqlite3",
    publicOrigin,
    allowedOrigins,
    mintUrl,
    mintApiUrl,
    fiberRpcUrl,
    enabled: flag("FIBERNUTS_FAUCET_ENABLED", false),
    amount: integer("FIBERNUTS_FAUCET_AMOUNT", 1000, 1, 100_000),
    unit: "rusd",
    network: "testnet",
    unitScale: integer("FIBERNUTS_FAUCET_UNIT_SCALE", 1_000_000, 1, 1_000_000_000),
    invoiceCurrency: "Fibt",
    udtScript: {
      codeHash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
      hashType: "type",
      args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
    },
    clientCooldownSeconds,
    networkDailyClaimLimit: integer("FIBERNUTS_FAUCET_NETWORK_DAILY_CLAIM_LIMIT", 3, 1, 1000),
    dailyClaimLimit: integer("FIBERNUTS_FAUCET_DAILY_CLAIM_LIMIT", 25, 1, 100_000),
    maxRequestsPerMinute: integer("FIBERNUTS_FAUCET_MAX_REQUESTS_PER_MINUTE", 120, 10, 10_000),
    maxFeeBaseUnits: integer("FIBERNUTS_FAUCET_MAX_FEE_BASE_UNITS", 5_000_000, 0, 1_000_000_000),
    maxFeeRate: integer("FIBERNUTS_FAUCET_MAX_FEE_RATE", 5, 0, 1000),
    recoveryDelaySeconds: integer("FIBERNUTS_FAUCET_RECOVERY_DELAY_SECONDS", 10, 5, 300),
    reconciliationIntervalSeconds: integer("FIBERNUTS_FAUCET_RECONCILIATION_SECONDS", 10, 5, 300),
    sensitiveRetentionSeconds,
    upstreamTimeoutMs: integer("FIBERNUTS_FAUCET_UPSTREAM_TIMEOUT_MS", 10_000, 1000, 60_000),
    bodyLimitBytes: 4096,
    identifierSecret,
    trustProxy: flag("FIBERNUTS_FAUCET_TRUST_PROXY", false),
  };
}
