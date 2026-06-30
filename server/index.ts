// Production server: serves the Vite-built SPA (dist/) and the /api routes from
// a single Hono app on one port. Replaces the former Next.js server, next.config
// headers, and the per-request CSP nonce middleware.
//
// In development this same app runs (via `tsx watch`) to serve only /api; the
// Vite dev server serves the client and proxies /api here (see vite.config.ts).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { api } from "./api";

const isProd = process.env.NODE_ENV === "production";

// In development, load .env.local the way Next.js used to. In production, env
// vars come from the host (Coolify / Docker env), so there's nothing to load.
if (!isProd) {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* no .env.local — that's fine for sorting/writing without secrets */
  }
}

const port = Number(process.env.PORT) || 3000;

const app = new Hono();

// ── Security headers (replaces next.config.mjs headers + middleware.ts CSP) ───
// With a Vite SPA every script is an external module file, so a static
// `script-src 'self'` works — no per-request nonce needed. Inline styles
// (style={{…}} attributes throughout the UI) keep style-src 'unsafe-inline'.
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // blob:/data: for in-browser photo resizing previews; i.ebayimg.com for eBay images
  "img-src 'self' data: blob: https://i.ebayimg.com",
  "connect-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

app.use("*", async (c, next) => {
  await next();
  // Keep this private deployment out of search results.
  c.header("X-Robots-Tag", "noindex, nofollow");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header("Content-Security-Policy", csp);
});

// ── API ───────────────────────────────────────────────────────────────────────
// Bound request bodies (photos are resized client-side first). Generous enough
// for a full publish payload, low enough to blunt abuse.
app.use("/api/*", bodyLimit({ maxSize: 25 * 1024 * 1024 }));
app.route("/api", api);

// ── Static SPA (production only) ───────────────────────────────────────────────
if (isProd) {
  // Serve built assets (/assets/*, favicon, etc.) and index.html at "/".
  app.use("/*", serveStatic({ root: "./dist" }));
  // SPA fallback: client-routed paths (e.g. /privacy) return index.html.
  const indexHtml = readFileSync(resolve("dist/index.html"), "utf8");
  app.get("*", (c) => c.html(indexHtml));
}

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Listening on http://localhost:${info.port} (${isProd ? "production" : "development"})`);
});
