export interface RelayConfig {
  host: string;
  port: number;
  databasePath: string;
  publicOrigin: string;
  allowedOrigins: Set<string>;
  maxTtlSeconds: number;
  retentionSeconds: number;
  maxRequestsPerMinute: number;
  bodyLimitBytes: number;
}

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function parseOrigin(name: string, raw: string | undefined): string {
  if (!raw) throw new Error(`${name} is required.`);
  const parsed = new URL(raw);
  if (!(["https:", "http:"].includes(parsed.protocol)) || parsed.username || parsed.password) {
    throw new Error(`${name} must be an HTTP(S) origin without credentials.`);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${name} must not contain a path, query, or fragment.`);
  }
  return parsed.origin;
}

export function loadConfig(): RelayConfig {
  const publicOrigin = parseOrigin(
    "FIBERNUTS_RELAY_PUBLIC_ORIGIN",
    process.env.FIBERNUTS_RELAY_PUBLIC_ORIGIN ?? "http://127.0.0.1:8090",
  );
  if (process.env.NODE_ENV === "production" && !publicOrigin.startsWith("https://")) {
    throw new Error("FIBERNUTS_RELAY_PUBLIC_ORIGIN must use HTTPS in production.");
  }

  const allowedOrigins = new Set(
    (process.env.FIBERNUTS_RELAY_ALLOWED_ORIGINS ?? "http://127.0.0.1:5175")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => parseOrigin("FIBERNUTS_RELAY_ALLOWED_ORIGINS", value)),
  );
  if (allowedOrigins.size === 0) throw new Error("At least one allowed browser origin is required.");

  return {
    host: process.env.FIBERNUTS_RELAY_HOST ?? "127.0.0.1",
    port: integer("FIBERNUTS_RELAY_PORT", 8090, 1, 65535),
    databasePath: process.env.FIBERNUTS_RELAY_DATABASE ?? "./data/relay.sqlite3",
    publicOrigin,
    allowedOrigins,
    maxTtlSeconds: integer("FIBERNUTS_RELAY_MAX_TTL_SECONDS", 600, 30, 3600),
    retentionSeconds: integer("FIBERNUTS_RELAY_RETENTION_SECONDS", 3600, 60, 86400),
    maxRequestsPerMinute: integer("FIBERNUTS_RELAY_MAX_REQUESTS_PER_MINUTE", 120, 10, 10000),
    bodyLimitBytes: 128 * 1024,
  };
}
