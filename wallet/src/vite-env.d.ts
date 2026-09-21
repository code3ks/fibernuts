interface ImportMetaEnv {
  /** Default mint URL, baked in at build time (e.g. set in Vercel project settings). */
  readonly VITE_MINT_URL?: string;
  /** Human-readable network label shown by the wallet shell. */
  readonly VITE_NETWORK_LABEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
