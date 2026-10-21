export interface FaucetConfig {
  enabled: boolean;
  amount: number;
  unit: "rusd";
  network: "testnet";
  mint: string;
  cooldownSeconds: number;
  remainingToday: number;
}

export type FaucetClaimStatus = "paying" | "paid" | "issued" | "failed" | "recoverable";

export interface FaucetClaim {
  status: FaucetClaimStatus;
  amount: number;
  unit: "rusd";
  message: string;
  retryAfterSeconds?: number;
}

export class FaucetError extends Error {
  constructor(readonly code: string, message: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "FaucetError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function integer(value: unknown, minimum = 0): number | null {
  return Number.isSafeInteger(value) && (value as number) >= minimum ? value as number : null;
}

function normalizedUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new FaucetError("invalid_response", "The community faucet returned an invalid response.");
  }
}

export class FaucetClient {
  constructor(private readonly origin: string) {}

  async config(): Promise<FaucetConfig> {
    let response: Response;
    try {
      response = await fetch(`${this.origin}/v1/config`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new FaucetError("unavailable", "The community faucet is not reachable.");
    }
    if (!response.ok) throw new FaucetError("unavailable", "The community faucet is not available.");
    const raw = await json(response);
    if (!record(raw)) throw new FaucetError("invalid_response", "The community faucet returned invalid settings.");
    const amount = integer(raw.amount, 1);
    const cooldownSeconds = integer(raw.cooldownSeconds, 60);
    const remainingToday = integer(raw.remainingToday);
    if (
      typeof raw.enabled !== "boolean" || amount === null || raw.unit !== "rusd" || raw.network !== "testnet" ||
      typeof raw.mint !== "string" || cooldownSeconds === null || remainingToday === null
    ) {
      throw new FaucetError("invalid_response", "The community faucet returned invalid settings.");
    }
    return {
      enabled: raw.enabled,
      amount,
      unit: raw.unit,
      network: raw.network,
      mint: normalizedUrl(raw.mint),
      cooldownSeconds,
      remainingToday,
    };
  }

  async claim(quoteId: string, clientId: string): Promise<FaucetClaim> {
    let response: Response;
    try {
      response = await fetch(`${this.origin}/v1/claims`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ quote_id: quoteId, client_id: clientId }),
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new FaucetError("unavailable", "The claim result is unknown. Resume this same claim before creating another.");
    }
    const raw = await json(response);
    if (!record(raw)) throw new FaucetError("invalid_response", "The community faucet returned an invalid response.");
    const retryAfterSeconds = raw.retry_after_seconds === undefined ? undefined : integer(raw.retry_after_seconds, 1) ?? undefined;
    if (!response.ok) {
      throw new FaucetError(
        typeof raw.error === "string" ? raw.error : "request_failed",
        typeof raw.message === "string" ? raw.message : "The community faucet could not fund this claim.",
        retryAfterSeconds,
      );
    }
    const amount = integer(raw.amount, 1);
    if (
      !["paying", "paid", "issued", "failed", "recoverable"].includes(String(raw.status)) ||
      amount === null || raw.unit !== "rusd" || typeof raw.message !== "string"
    ) {
      throw new FaucetError("invalid_response", "The community faucet returned an invalid claim status.");
    }
    return {
      status: raw.status as FaucetClaimStatus,
      amount,
      unit: raw.unit,
      message: raw.message,
      retryAfterSeconds,
    };
  }
}

function randomClientId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function faucetClientId(origin: string): string {
  const key = `fibernuts:faucet-client:v1:${new URL(origin).host}`;
  const current = localStorage.getItem(key);
  if (current && /^[A-Za-z0-9_-]{43,64}$/.test(current)) return current;
  const created = randomClientId();
  localStorage.setItem(key, created);
  return created;
}
