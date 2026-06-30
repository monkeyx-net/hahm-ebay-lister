// All /api routes, ported from the former Next.js App Router route handlers.
// Each handler is plain Hono: it reads a Web Request and returns a Web Response,
// reusing the framework-neutral helpers in lib/.

import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type Anthropic from "@anthropic-ai/sdk";
import type { ModelInfo } from "@anthropic-ai/sdk/resources/models.js";

import { getClient, parseModelJson, AnthropicAuthError, anthropicAuthError } from "../lib/anthropic";
import { guardApiRequest, rateLimitRequest, safeErrorResponse } from "../lib/api-guard";
import {
  PROFILE_ROUTER_PROMPT,
  buildProfiledAnalysisPrompt,
  normalizeItemProfile,
} from "../lib/prompts";
import { toImageBlock, type ImageBlock, type WireImage } from "../lib/images";
import { resolveModel, isAllowedModel } from "../lib/models";
import { sortPhotos, SortUnavailableError } from "../lib/sortPipeline";
import { isEbayConfigured, currencySymbol, EBAY_ITEM_BASE_URL } from "../lib/ebay/config";
import { buildAuthorizeUrl, exchangeCode } from "../lib/ebay/oauth";
import {
  EBAY_COOKIE,
  EBAY_COOKIE_MAX_AGE,
  EBAY_STATE_COOKIE,
  accessTokenFromCookie,
  connectionFromToken,
  openConnection,
  sealConnection,
} from "../lib/ebay/session";
import { fetchAccountSetup, publishListing } from "../lib/ebay/publish";
import type { PublishInput } from "../lib/ebay/publish";
import type { AnalyzeRequestBody, ListingResult, ModelOption, ModelsPayload } from "../lib/types";

export const api = new Hono();

// ── shared cookie options ─────────────────────────────────────────────────────
const COOKIE_BASE = {
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  path: "/",
} as const;

// ── /api/health ───────────────────────────────────────────────────────────────
// Liveness probe for Docker/Coolify. Unauthenticated and side-effect free —
// reports only that the server is up, never any configuration or secrets.
api.get("/health", (c) => c.json({ ok: true, status: "healthy" }));

// ── /api/analyze ────────────────────────────────────────────────────────────
const ANALYSIS_MODEL = "claude-opus-4-8";
const ROUTER_MODEL = "claude-sonnet-4-6";
const MAX_IMAGES = 12;

function firstText(resp: Anthropic.Message): string {
  const block = resp.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text.trim() : "";
}

function toImageBlocks(images: AnalyzeRequestBody["images"]): ImageBlock[] {
  const blocks: ImageBlock[] = [];
  for (const img of images.slice(0, MAX_IMAGES)) {
    const block = toImageBlock(img);
    if (block) blocks.push(block);
  }
  return blocks;
}

// Mirrors route_item_profile(): honor a forced profile, else ask the model.
async function routeProfile(
  client: Anthropic,
  imageBlocks: ImageBlock[],
  requested: string,
  routerModel: string
): Promise<string> {
  const forced = normalizeItemProfile(requested);
  if (forced !== "auto") return forced;

  try {
    const resp = await client.messages.create({
      model: routerModel,
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: [...imageBlocks, { type: "text", text: PROFILE_ROUTER_PROMPT }],
        },
      ],
    });
    const text = firstText(resp);
    const data = parseModelJson<{ profile?: string }>(text);
    const routed = normalizeItemProfile(data?.profile ?? "auto");
    return routed !== "auto" ? routed : "hard_goods";
  } catch (e) {
    // Auth/billing failures must surface, not silently fall back to a profile.
    const fatal = anthropicAuthError(e);
    if (fatal) throw fatal;
    return "hard_goods";
  }
}

api.post("/analyze", async (c) => {
  const denied = guardApiRequest(c.req.raw);
  if (denied) return denied;

  let body: AnalyzeRequestBody;
  try {
    body = (await c.req.json()) as AnalyzeRequestBody;
  } catch {
    return c.json({ ok: false, error: "Invalid request body." }, 400);
  }

  // Validate client-supplied models against the server allowlist; fall back to
  // the trusted default on anything unknown (prevents billing an arbitrary or
  // premium model to the owner's key).
  const analysisModel = resolveModel(body.analysisModel, ANALYSIS_MODEL);
  const routerModel = resolveModel(body.routerModel, ROUTER_MODEL);

  if (!Array.isArray(body.images) || body.images.length === 0) {
    return c.json({ ok: false, error: "Please add at least one photo." }, 400);
  }

  const imageBlocks = toImageBlocks(body.images);
  if (imageBlocks.length === 0) {
    return c.json({ ok: false, error: "No readable photos found. Use JPG, PNG, or WebP." }, 400);
  }

  let client: Anthropic;
  try {
    client = getClient();
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }

  try {
    const profile = await routeProfile(client, imageBlocks, body.profile, routerModel);
    const systemPrompt = buildProfiledAnalysisPrompt(profile);

    // Retry up to 3 times, mirroring the Python analyze_photos() loop.
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await client.messages.create({
          model: analysisModel,
          max_tokens: 3000,
          // System prompt is large and identical across requests for the same
          // profile — cache it to cut cost and latency.
          system: [
            { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
          ],
          messages: [
            {
              role: "user",
              content: [
                ...imageBlocks,
                { type: "text", text: "Analyze these photos and return the listing JSON now." },
              ],
            },
          ],
        });
        const listing = parseModelJson<ListingResult>(firstText(resp));
        listing.item_profile = profile;
        return c.json({ ok: true, listing });
      } catch (err) {
        const fatal = anthropicAuthError(err);
        if (fatal) throw fatal; // auth/billing won't fix itself on retry
        lastErr = err;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
    }
    throw lastErr;
  } catch (e) {
    if (e instanceof AnthropicAuthError) {
      console.error("[analyze] auth/billing failure:", e.message);
      return c.json({ ok: false, error: e.message }, e.status as 401 | 402 | 500);
    }
    return safeErrorResponse("analyze", e, "Something went wrong analyzing photos — please try again.");
  }
});

// ── /api/sort ─────────────────────────────────────────────────────────────────
const MAX_PHOTOS = 120;

api.post("/sort", async (c) => {
  const denied = guardApiRequest(c.req.raw);
  if (denied) return denied;

  let body: { images?: WireImage[]; sortModel?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid request body." }, 400);
  }

  const images = Array.isArray(body.images) ? body.images.slice(0, MAX_PHOTOS) : [];
  // Validate the client-supplied model against the server allowlist — an
  // unchecked value would let anyone past the access gate bill an arbitrary or
  // premium model to the owner's key. Unknown → undefined (pipeline default).
  const requestedSort = typeof body.sortModel === "string" ? body.sortModel.trim() : "";
  const sortModel = isAllowedModel(requestedSort) ? requestedSort : undefined;
  if (images.length === 0) {
    return c.json({ ok: false, error: "Please add some photos first." }, 400);
  }

  let client;
  try {
    client = getClient();
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }

  try {
    const result = await sortPhotos(client, images, sortModel);
    if (result.groups.length === 0) {
      return c.json(
        {
          ok: false,
          error:
            "The AI couldn't pick out any separate items in these photos. Make sure each item is clearly shown, then try again.",
        },
        502
      );
    }
    return c.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof AnthropicAuthError) {
      console.error("[sort] auth/billing failure:", e.message);
      return c.json({ ok: false, error: e.message }, e.status as 401 | 402 | 500);
    }
    if (e instanceof SortUnavailableError) {
      console.error("[sort] every grouping batch failed:", e.message);
      return c.json({ ok: false, error: e.message }, 503);
    }
    return safeErrorResponse("sort", e, "Sorting failed — please try again.");
  }
});

// ── /api/models ───────────────────────────────────────────────────────────────
// Haiku is excluded from the listing-generation selector: it materially worsens
// listing quality compared to every other available model.
const ANALYSIS_EXCLUDED = /^claude-haiku/;

const DESCRIPTIONS: Record<string, string> = {
  "claude-fable-5":    "Most capable model — best for rare or complex items. Premium pricing.",
  "claude-opus-4-8":   "Excellent quality. Recommended for detailed listing generation.",
  "claude-opus-4-7":   "High quality with strong reasoning. Good all-around choice.",
  "claude-opus-4-6":   "Solid quality and great value.",
  "claude-sonnet-4-6": "Fast and capable. Great for sorting; works well for most listings.",
  "claude-haiku-4-5":  "Fastest and most affordable. Best for photo sorting only.",
};

const SORT_DEFAULT = "claude-sonnet-4-6";
const ANALYSIS_DEFAULT = "claude-opus-4-8";

// Hardcoded fallback when the Anthropic models API call fails.
const FALLBACK: ModelsPayload = {
  sortModels: [
    { id: "claude-opus-4-8",   displayName: "Claude Opus 4.8",   description: DESCRIPTIONS["claude-opus-4-8"],   isDefault: false },
    { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", description: DESCRIPTIONS["claude-sonnet-4-6"], isDefault: true  },
    { id: "claude-haiku-4-5",  displayName: "Claude Haiku 4.5",  description: DESCRIPTIONS["claude-haiku-4-5"],  isDefault: false },
  ],
  analysisModels: [
    { id: "claude-opus-4-8",   displayName: "Claude Opus 4.8",   description: DESCRIPTIONS["claude-opus-4-8"],   isDefault: true  },
    { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", description: DESCRIPTIONS["claude-sonnet-4-6"], isDefault: false },
  ],
};

let modelsCache: ModelsPayload | null = null;
let modelsCacheAt = 0;
const MODELS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

function toOption(m: ModelInfo): ModelOption {
  return {
    id: m.id,
    displayName: m.display_name,
    description: DESCRIPTIONS[m.id] ?? "Model available from Anthropic.",
    isDefault: false, // set below
  };
}

function buildModelsPayload(raw: ModelInfo[]): ModelsPayload {
  // Only offer models the call routes will actually accept (lib/models.ts) — this
  // keeps the premium "fable" tier out of the selector so the UI never shows a
  // model the server would reject.
  const vision = raw.filter((m) => isAllowedModel(m.id));
  if (vision.length === 0) return FALLBACK;

  const sortModels = vision.map((m) => ({ ...toOption(m), isDefault: m.id === SORT_DEFAULT }));
  const analysisModels = vision
    .filter((m) => !ANALYSIS_EXCLUDED.test(m.id))
    .map((m) => ({ ...toOption(m), isDefault: m.id === ANALYSIS_DEFAULT }));

  // If the default wasn't in the list, mark the first entry as default.
  if (sortModels.length && !sortModels.some((m) => m.isDefault)) sortModels[0].isDefault = true;
  if (analysisModels.length && !analysisModels.some((m) => m.isDefault)) analysisModels[0].isDefault = true;

  return { sortModels, analysisModels };
}

api.get("/models", async (c) => {
  const now = Date.now();
  if (modelsCache && now - modelsCacheAt < MODELS_CACHE_TTL) {
    return c.json(modelsCache);
  }
  try {
    const client = getClient();
    const page = await client.models.list();
    modelsCache = buildModelsPayload(page.data);
    modelsCacheAt = now;
    return c.json(modelsCache);
  } catch {
    return c.json(FALLBACK);
  }
});

// ── /api/ebay/* ───────────────────────────────────────────────────────────────

// Kick off the eBay connection after the app access code has been verified.
// This cannot be a plain link/GET, because GET redirects cannot carry the
// x-app-secret header stored by the browser.
api.post("/ebay/auth", (c) => {
  const denied = guardApiRequest(c.req.raw);
  if (denied) return denied;
  try {
    const state = crypto.randomUUID();
    const url = buildAuthorizeUrl(state);
    // Short-lived CSRF guard, verified in the callback.
    setCookie(c, EBAY_STATE_COOKIE, state, { ...COOKIE_BASE, maxAge: 600 });
    return c.json({ ok: true, url });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

api.get("/ebay/auth", (c) =>
  c.json(
    { ok: false, code: "ACCESS_CODE_REQUIRED", error: "Use the app to start eBay authorization." },
    401
  )
);

// Manual connect: the user pastes the URL (or code) from eBay's success page.
// Mirrors the Python script's copy-the-redirect-URL flow, which is immune to
// eBay's redirect-URL configuration quirks.
function extractCode(input: string): string | null {
  const raw = (input || "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const cval = u.searchParams.get("code");
    if (cval) return cval;
  } catch {
    /* not a full URL */
  }
  const m = raw.match(/[?&]code=([^&\s]+)/);
  if (m) return decodeURIComponent(m[1]);
  if (raw.startsWith("v^")) return raw;
  return null;
}

api.post("/ebay/connect", async (c) => {
  const denied = guardApiRequest(c.req.raw);
  if (denied) return denied;

  let body: { url?: string; code?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid request." }, 400);
  }

  const code = body.code?.trim() || extractCode(body.url || "");
  if (!code) {
    return c.json(
      { ok: false, error: "Couldn't find an authorization code in what you pasted." },
      400
    );
  }

  try {
    const token = await exchangeCode(code);
    if (!token.refresh_token) {
      throw new Error("eBay didn't return a refresh token (the code may have expired — try again).");
    }
    const sealed = await sealConnection(
      connectionFromToken(token.refresh_token, token.refresh_token_expires_in)
    );
    setCookie(c, EBAY_COOKIE, sealed, { ...COOKIE_BASE, maxAge: EBAY_COOKIE_MAX_AGE });
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 502);
  }
});

function appUrl(c: { req: { url: string } }, path: string): string {
  // Prefer an explicit APP_URL; otherwise derive from the request.
  const base = process.env.APP_URL || new URL(c.req.url).origin;
  return new URL(path, base).toString();
}

// eBay redirects the user back here with ?code=... after they consent.
// Must stay reachable without the access code (it's a browser redirect from
// eBay), so it is protected by the state cookie below plus the rate limiter.
api.get("/ebay/callback", async (c) => {
  const limited = rateLimitRequest(c.req.raw);
  if (limited) return limited;

  const code = c.req.query("code");
  const state = c.req.query("state");
  const expectedState = getCookie(c, EBAY_STATE_COOKIE);

  if (!code) {
    return c.redirect(appUrl(c, "/?ebay=error&msg=No+authorization+code"));
  }
  if (!state || !expectedState || state !== expectedState) {
    return c.redirect(appUrl(c, "/?ebay=error&msg=State+mismatch"));
  }

  try {
    const token = await exchangeCode(code);
    if (!token.refresh_token) {
      throw new Error("eBay did not return a refresh token.");
    }
    const sealed = await sealConnection(
      connectionFromToken(token.refresh_token, token.refresh_token_expires_in)
    );
    setCookie(c, EBAY_COOKIE, sealed, { ...COOKIE_BASE, maxAge: EBAY_COOKIE_MAX_AGE });
    deleteCookie(c, EBAY_STATE_COOKIE, { path: "/" });
    return c.redirect(appUrl(c, "/?ebay=connected"));
  } catch (e) {
    const msg = encodeURIComponent((e as Error).message);
    return c.redirect(appUrl(c, `/?ebay=error&msg=${msg}`));
  }
});

// Lightweight check the UI calls on load: is eBay set up + connected?
// Returns booleans only, so it stays outside the access code — but not
// outside the rate limiter.
api.get("/ebay/status", async (c) => {
  const limited = rateLimitRequest(c.req.raw);
  if (limited) return limited;

  const configured = isEbayConfigured();
  const conn = await openConnection(getCookie(c, EBAY_COOKIE));
  // Currency symbol + item base URL let the UI render prices and listing links
  // for the active marketplace without baking it in at build time.
  return c.json({
    configured,
    connected: Boolean(conn),
    currencySymbol: currencySymbol(),
    itemBaseUrl: EBAY_ITEM_BASE_URL,
  });
});

// Forget the stored eBay connection.
api.post("/ebay/disconnect", (c) => {
  const denied = guardApiRequest(c.req.raw);
  if (denied) return denied;
  deleteCookie(c, EBAY_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

api.post("/ebay/publish", async (c) => {
  // Check access + rate limit BEFORE parsing the (potentially large) body.
  const denied = guardApiRequest(c.req.raw);
  if (denied) return denied;

  let body: PublishInput;
  try {
    body = (await c.req.json()) as PublishInput;
  } catch {
    return c.json({ success: false, error: "Invalid request." }, 400);
  }

  if (!body.sku || !body.listing || !Array.isArray(body.images) || body.images.length === 0) {
    return c.json({ success: false, error: "Missing SKU, listing, or photos." }, 400);
  }

  // Mint a fresh access token from the encrypted connection cookie.
  let accessToken: string | null;
  try {
    accessToken = await accessTokenFromCookie(getCookie(c, EBAY_COOKIE));
  } catch (e) {
    return c.json({ success: false, error: (e as Error).message }, 500);
  }
  if (!accessToken) {
    return c.json(
      { success: false, error: "eBay isn't connected. Connect your account and try again." },
      401
    );
  }

  try {
    const setup = await fetchAccountSetup(accessToken);
    const result = await publishListing(accessToken, setup, body);
    return c.json(result, result.success ? 200 : 502);
  } catch (e) {
    return c.json({ success: false, sku: body.sku, error: (e as Error).message }, 500);
  }
});
