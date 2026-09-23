/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MINT_URL?: string;
  readonly VITE_RELAY_ORIGIN?: string;
  readonly VITE_NETWORK_LABEL?: string;
  readonly VITE_PREVIEW_DATA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
