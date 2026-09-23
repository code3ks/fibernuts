export interface CatalogItem {
  id: string;
  label: string;
  description: string;
  price: number | "custom";
}

export interface VendorManifest {
  id: string;
  name: string;
  description: string;
  location: string;
  catalog: CatalogItem[];
}

export interface EventManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  venue: string;
  network: "testnet";
  networkLabel: string;
  unit: "rusd";
  mintUrl: string;
  assetTypeScript: {
    codeHash: string;
    hashType: "type";
    args: string;
  };
  paymentTransport: {
    mode: "post_p2pk";
    relayOrigin: string;
  };
  vendors: VendorManifest[];
}

const HEX_32 = /^0x[a-f0-9]{64}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function record(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const expected = new Set(keys);
  if (keys.some((key) => !(key in value)) || Object.keys(value).some((key) => !expected.has(key))) {
    throw new Error(`${label} contains missing or unsupported fields.`);
  }
}

function normalizedUrl(value: string, label: string): string {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be an HTTP(S) URL without credentials, query, or fragment.`);
  }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error(`${label} must use HTTPS outside local development.`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function validateEventManifest(input: unknown): EventManifest {
  record(input, "Event manifest");
  exactKeys(input, [
    "schemaVersion", "id", "name", "description", "venue", "network", "networkLabel", "unit",
    "mintUrl", "assetTypeScript", "paymentTransport", "vendors",
  ], "Event manifest");
  const manifest = input as unknown as EventManifest;
  if (![manifest.id, manifest.name, manifest.description, manifest.venue, manifest.networkLabel, manifest.mintUrl]
    .every((value) => typeof value === "string" && value.trim())) {
    throw new Error("Event identity fields must be non-empty strings.");
  }
  if (manifest.schemaVersion !== 1) throw new Error("Unsupported event manifest version.");
  if (!SLUG.test(manifest.id)) throw new Error("Event ID must be a stable lowercase slug.");
  if (manifest.network !== "testnet" || manifest.unit !== "rusd") {
    throw new Error("The first market release supports only CKB testnet RUSD.");
  }
  record(manifest.assetTypeScript, "Asset type script");
  exactKeys(manifest.assetTypeScript, ["codeHash", "hashType", "args"], "Asset type script");
  if (
    manifest.assetTypeScript.hashType !== "type" ||
    !HEX_32.test(manifest.assetTypeScript.codeHash) ||
    !HEX_32.test(manifest.assetTypeScript.args)
  ) {
    throw new Error("The configured RUSD type script is malformed.");
  }
  record(manifest.paymentTransport, "Payment transport");
  exactKeys(manifest.paymentTransport, ["mode", "relayOrigin"], "Payment transport");
  if (manifest.paymentTransport.mode !== "post_p2pk") throw new Error("Unsupported payment transport mode.");
  const mintUrl = normalizedUrl(manifest.mintUrl, "Mint URL");
  const relayOrigin = normalizedUrl(manifest.paymentTransport.relayOrigin, "Relay origin");
  if (new URL(relayOrigin).pathname !== "/") throw new Error("Relay origin must not contain a path.");
  if (!Array.isArray(manifest.vendors) || manifest.vendors.length === 0) {
    throw new Error("The event must configure at least one vendor.");
  }

  const vendorIds = new Set<string>();
  for (const vendor of manifest.vendors) {
    record(vendor, "Vendor");
    exactKeys(vendor, ["id", "name", "description", "location", "catalog"], "Vendor");
    if (!SLUG.test(vendor.id) || vendorIds.has(vendor.id)) throw new Error("Vendor IDs must be unique lowercase slugs.");
    vendorIds.add(vendor.id);
    if (
      ![vendor.name, vendor.description, vendor.location].every((value) => typeof value === "string" && value.trim()) ||
      !Array.isArray(vendor.catalog) || vendor.catalog.length === 0
    ) throw new Error("Every vendor needs a name, description, location, and catalog.");
    const itemIds = new Set<string>();
    for (const item of vendor.catalog) {
      record(item, "Catalog item");
      exactKeys(item, ["id", "label", "description", "price"], "Catalog item");
      if (!SLUG.test(item.id) || itemIds.has(item.id)) throw new Error("Catalog item IDs must be unique lowercase slugs.");
      itemIds.add(item.id);
      if (
        typeof item.label !== "string" || !item.label.trim() ||
        typeof item.description !== "string" || !item.description.trim() ||
        (item.price !== "custom" && (!Number.isSafeInteger(item.price) || item.price <= 0))
      ) {
        throw new Error("Catalog items require a label and positive integer price.");
      }
    }
  }

  return {
    ...manifest,
    mintUrl,
    paymentTransport: { ...manifest.paymentTransport, relayOrigin },
  };
}

const local = typeof window !== "undefined" && window.location.port === "5175";

export const EVENT = validateEventManifest({
  schemaVersion: 1,
  id: "ckb-community-market",
  name: "CKB Community Market",
  description: "Small purchases, tips, and community moments paid with RUSD ecash.",
  venue: "CKB Community Pop-up",
  network: "testnet",
  networkLabel: import.meta.env.VITE_NETWORK_LABEL ?? "CKB Testnet",
  unit: "rusd",
  mintUrl: import.meta.env.VITE_MINT_URL ?? (local ? window.location.origin : "https://mint.fibernuts.xyz"),
  assetTypeScript: {
    codeHash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
    hashType: "type",
    args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
  },
  paymentTransport: {
    mode: "post_p2pk",
    relayOrigin: import.meta.env.VITE_RELAY_ORIGIN ?? (local ? "http://127.0.0.1:8090" : "https://pay.fibernuts.xyz"),
  },
  vendors: [{
    id: "block-cafe",
    name: "Block Cafe",
    description: "Coffee, snacks, and a small keepsake for the CKB community.",
    location: "Market counter A",
    catalog: [
      { id: "coffee", label: "Coffee", description: "Freshly brewed cup", price: 250 },
      { id: "snack", label: "Snack", description: "A quick event bite", price: 150 },
      { id: "event-sticker", label: "Event sticker", description: "CKB Community Market edition", price: 100 },
      { id: "contributor-tip", label: "Contributor tip", description: "Choose an amount", price: "custom" },
    ],
  }],
});

export const PREVIEW_MODE = import.meta.env.VITE_PREVIEW_DATA === "true";
