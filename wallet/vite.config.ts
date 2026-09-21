import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** The mint a `npm run dev` session talks to. Overridden by FIBERNUTS_MINT. */
const MINT = process.env.FIBERNUTS_MINT ?? "http://127.0.0.1:8085";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    // Proxying keeps the dev wallet same-origin, so a mint without permissive CORS still works.
    proxy: { "/v1": { target: MINT, changeOrigin: true } },
  },
});
