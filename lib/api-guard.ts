import crypto from "crypto";

/**
 * Access guard for the AI-powered API routes.
 *
 * These routes spend real money (Anthropic API calls) on every request, so a
 * public deployment must not leave them open. Set APP_SECRET in your
 * environment and the app will ask for the access code once per device
 * (it's remembered in the browser afterwards).
 *
 * If APP_SECRET is unset the guard allows everything in local development,
 * but FAILS CLOSED in production (NODE_ENV=production): every guarded route
 * returns 503 until the variable is configured. A forgotten secret must never
 * silently expose money-spending endpoints.
 *
 * Framework-neutral: takes a Web `Request` and returns a Web `Response`
 * (or null to proceed), so it works under any Web-standard server (Hono).
 */

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 10;

// Per-process limiter. Not a global guarantee behind multiple replicas, but it
// blunts burst abuse at zero infra cost.
const hits = new Map<string, number[]>();

function timingSafeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const recent = (hits.get(ip) ?? []).filter((t) => t > windowStart);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear(); // bound memory under address-spray
  return recent.length > RATE_LIMIT_MAX_REQUESTS;
}

/**
 * Rate limiting only — for routes that must stay reachable without the access
 * code (the eBay OAuth callback, the status probe) but shouldn't be hammered.
 */
export function rateLimitRequest(req: Request): Response | null {
  if (rateLimited(clientIp(req))) {
    return jsonResponse(
      { ok: false, error: "Too many requests — wait a minute and try again." },
      429
    );
  }
  return null;
}

/**
 * Returns an error response when the request isn't allowed, or null to proceed.
 */
export function guardApiRequest(req: Request): Response | null {
  const limited = rateLimitRequest(req);
  if (limited) return limited;

  const secret = process.env.APP_SECRET;
  if (!secret) {
    // Fail closed in production — never run a deployed app without an access code.
    if (process.env.NODE_ENV === "production") {
      return jsonResponse(
        {
          ok: false,
          error:
            "This deployment has no APP_SECRET configured. Set it in your environment variables (or Coolify → Environment), then redeploy.",
        },
        503
      );
    }
    return null; // local development only
  }

  const provided = req.headers.get("x-app-secret") ?? "";
  if (!provided || !timingSafeEqual(provided, secret)) {
    return jsonResponse(
      { ok: false, code: "ACCESS_CODE_REQUIRED", error: "Access code required." },
      401
    );
  }

  return null;
}

/** Log the real error server-side; return only a safe message to the client. */
export function safeErrorResponse(
  context: string,
  e: unknown,
  fallback: string
): Response {
  console.error(`[${context}]`, e);
  return jsonResponse({ ok: false, error: fallback }, 500);
}
