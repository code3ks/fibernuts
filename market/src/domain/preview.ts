import type { Proof } from "@cashu/cashu-ts";

import type { EventManifest } from "../event/manifest";
import { emptyMarketSnapshot } from "./storage";
import type { MarketRole, MarketSnapshot } from "./types";

function syntheticProof(amount: number, role: MarketRole): Proof {
  return {
    amount,
    id: "preview_keyset",
    secret: `synthetic-preview-${role}-proof`,
    C: `02${"11".repeat(32)}`,
  } as unknown as Proof;
}

export function previewSnapshot(manifest: EventManifest, role: MarketRole): MarketSnapshot {
  const snapshot = emptyMarketSnapshot(manifest, role);
  return {
    ...snapshot,
    proofs: [syntheticProof(role === "attendee" ? 1_000 : 450, role)],
    orders: role === "vendor" ? [{
      id: "preview-settled-order",
      kind: "vendor_order",
      state: "settled",
      eventId: manifest.id,
      vendorId: manifest.vendors[0].id,
      items: [{ itemId: "event-sticker", label: "Event sticker", quantity: 1, unitPrice: 100 }],
      amount: 100,
      unit: "rusd",
      mintUrl: manifest.mintUrl,
      description: "Event sticker",
      expiresAt: 0,
      relayRegistered: true,
      relayAcknowledged: true,
      createdAt: Date.now() - 420_000,
      updatedAt: Date.now() - 410_000,
    }] : [],
  };
}
