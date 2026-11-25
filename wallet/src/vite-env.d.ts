interface ImportMetaEnv {
  /** Default mint URL, baked in at build time (e.g. set in Vercel project settings). */
  readonly VITE_MINT_URL?: string;
  /** Human-readable network label shown by the wallet shell. */
  readonly VITE_NETWORK_LABEL?: string;
  /** Operator-declared Fiber asset type-script code hash for the compiled default mint. */
  readonly VITE_ASSET_CODE_HASH?: string;
  /** Operator-declared Fiber asset type-script hash type for the compiled default mint. */
  readonly VITE_ASSET_HASH_TYPE?: "type" | "data" | "data1" | "data2";
  /** Operator-declared Fiber asset type-script args for the compiled default mint. */
  readonly VITE_ASSET_ARGS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
