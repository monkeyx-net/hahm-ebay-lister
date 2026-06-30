import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Mirror the tsconfig "@/*" path alias so client code keeps importing "@/lib/...".
  resolve: {
    alias: { "@": root },
  },
  build: {
    outDir: "dist",
    // Don't inline the module-preload polyfill: modern browsers support
    // modulepreload natively, and dropping it keeps every script external so the
    // CSP can stay `script-src 'self'` with no nonce/unsafe-inline.
    modulePreload: { polyfill: false },
  },
  server: {
    port: 5173,
    // Forward API calls to the Hono server (run separately via `npm run dev:server`).
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
