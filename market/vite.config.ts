import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const MINT = process.env.FIBERNUTS_MINT ?? "http://127.0.0.1:8085";

export default defineConfig({
  plugins: [react()],
  publicDir: resolve(import.meta.dirname, "../wallet/public"),
  resolve: {
    alias: {
      "@wallet-lib": resolve(import.meta.dirname, "../wallet/src/lib"),
      "@wallet-domain": resolve(import.meta.dirname, "../wallet/src/domain"),
      "@cashu/cashu-ts": resolve(import.meta.dirname, "node_modules/@cashu/cashu-ts"),
    },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "cashu-crypto",
              test: /node_modules[\\/](@cashu|@noble|@scure)[\\/]/,
            },
            {
              name: "react-runtime",
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 5175,
    fs: { allow: [resolve(import.meta.dirname, "..")] },
    proxy: { "/v1": { target: MINT, changeOrigin: true } },
  },
});
