export type MetadataSource = "mint_response" | "operator_configuration" | "stored_operation";

export interface SourcedText {
  value: string;
  source: MetadataSource;
}

export interface FiberAssetIdentity {
  codeHash: string;
  hashType: "type" | "data" | "data1" | "data2";
  args: string;
}

export interface SourcedAssetIdentity {
  value: FiberAssetIdentity;
  source: MetadataSource;
}

export interface SettlementContext {
  mintName: SourcedText;
  unit: SourcedText;
  paymentMethod: SourcedText;
  network?: SourcedText;
  assetTypeScript?: SourcedAssetIdentity;
}

export interface OperatorSettlementDeclaration {
  mintUrl: string;
  network?: string;
  assetTypeScript?: FiberAssetIdentity;
}

const SOURCES = new Set<MetadataSource>([
  "mint_response",
  "operator_configuration",
  "stored_operation",
]);

function normalizedUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/\/+$/, "");
  }
}

function host(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function normalizeHex(value: string, exactBytes?: number): string | null {
  const normalized = value.trim().toLowerCase();
  const pattern = exactBytes
    ? new RegExp(`^0x[0-9a-f]{${exactBytes * 2}}$`)
    : /^0x(?:[0-9a-f]{2})*$/;
  return pattern.test(normalized) ? normalized : null;
}

export function parseFiberAssetIdentity(input: {
  codeHash?: string;
  hashType?: string;
  args?: string;
}): FiberAssetIdentity | undefined {
  if (!input.codeHash && !input.hashType && !input.args) return undefined;
  const codeHash = input.codeHash ? normalizeHex(input.codeHash, 32) : null;
  const args = input.args ? normalizeHex(input.args) : null;
  const hashType = input.hashType?.trim().toLowerCase();
  if (
    !codeHash ||
    !args ||
    !hashType ||
    !["type", "data", "data1", "data2"].includes(hashType)
  ) {
    return undefined;
  }
  return { codeHash, hashType: hashType as FiberAssetIdentity["hashType"], args };
}

export function createOperatorSettlementDeclaration(input: {
  mintUrl: string;
  network?: string;
  assetCodeHash?: string;
  assetHashType?: string;
  assetArgs?: string;
}): OperatorSettlementDeclaration {
  const network = input.network?.trim();
  return {
    mintUrl: normalizedUrl(input.mintUrl),
    network: network || undefined,
    assetTypeScript: parseFiberAssetIdentity({
      codeHash: input.assetCodeHash,
      hashType: input.assetHashType,
      args: input.assetArgs,
    }),
  };
}

export function createSettlementContext(input: {
  mintUrl: string;
  mintName?: string;
  unit: string;
  operatorDeclaration: OperatorSettlementDeclaration;
  metadataSource?: "mint_response" | "stored_operation";
}): SettlementContext {
  const mintName = input.mintName?.trim();
  const metadataSource = input.metadataSource ?? "mint_response";
  const isDeclaredMint = normalizedUrl(input.mintUrl) === input.operatorDeclaration.mintUrl;
  return {
    mintName: {
      value: mintName || host(input.mintUrl),
      source: mintName ? metadataSource : "stored_operation",
    },
    unit: { value: input.unit.trim().toUpperCase(), source: metadataSource },
    paymentMethod: { value: "Fiber", source: metadataSource },
    network: isDeclaredMint && input.operatorDeclaration.network
      ? { value: input.operatorDeclaration.network, source: "operator_configuration" }
      : undefined,
    assetTypeScript: isDeclaredMint && input.operatorDeclaration.assetTypeScript
      ? { value: input.operatorDeclaration.assetTypeScript, source: "operator_configuration" }
      : undefined,
  };
}

export function legacySettlementContext(mintUrl: string, unit: string): SettlementContext {
  return {
    mintName: { value: host(mintUrl), source: "stored_operation" },
    unit: { value: unit.trim().toUpperCase(), source: "stored_operation" },
    paymentMethod: { value: "Fiber", source: "stored_operation" },
  };
}

function normalizeSource(value: unknown): MetadataSource | null {
  return typeof value === "string" && SOURCES.has(value as MetadataSource)
    ? value as MetadataSource
    : null;
}

function normalizeSourcedText(value: unknown): SourcedText | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<SourcedText>;
  const source = normalizeSource(raw.source);
  const text = typeof raw.value === "string" ? raw.value.trim() : "";
  return source && text ? { value: text, source } : undefined;
}

export function normalizeSettlementContext(value: unknown): SettlementContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<SettlementContext>;
  const mintName = normalizeSourcedText(raw.mintName);
  const unit = normalizeSourcedText(raw.unit);
  const paymentMethod = normalizeSourcedText(raw.paymentMethod);
  if (!mintName || !unit || !paymentMethod) return undefined;

  const network = normalizeSourcedText(raw.network);
  let assetTypeScript: SourcedAssetIdentity | undefined;
  if (raw.assetTypeScript && typeof raw.assetTypeScript === "object") {
    const asset = raw.assetTypeScript as Partial<SourcedAssetIdentity>;
    const source = normalizeSource(asset.source);
    const identity = asset.value && parseFiberAssetIdentity(asset.value);
    if (source && identity) assetTypeScript = { value: identity, source };
  }

  return { mintName, unit, paymentMethod, network, assetTypeScript };
}

export function metadataSourceLabel(source: MetadataSource): string {
  if (source === "mint_response") return "Mint response";
  if (source === "operator_configuration") return "Operator configuration";
  return "Stored operation";
}

export function serializeAssetIdentity(identity: FiberAssetIdentity): string {
  return JSON.stringify({
    code_hash: identity.codeHash,
    hash_type: identity.hashType,
    args: identity.args,
  });
}
