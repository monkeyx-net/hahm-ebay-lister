// Provider abstraction: lets server/api.ts and lib/sortPipeline.ts make a
// vision (photo) call without knowing whether it's going to Anthropic or
// OpenRouter, and validates any client-supplied model id against a
// server-trusted allowlist before it's ever used to bill a request.

import type Anthropic from "@anthropic-ai/sdk";
import { getClient as getAnthropicClient, AnthropicAuthError, anthropicAuthError } from "./anthropic";
import {
  createChatCompletion as createOpenRouterCompletion,
  getOpenRouterKey,
  listOpenRouterModels,
  OpenRouterAuthError,
  openRouterAuthError,
  type OpenRouterModel,
} from "./openrouter";
import {
  createChatCompletion as createOmniRouteCompletion,
  listOmniRouteModels,
  OmniRouteAuthError,
  omniRouteAuthError,
} from "./omniroute";
import { toImageBlock, toOpenAIImagePart, type GenericContentPart, type OpenAIChatContentPart } from "./images";
import { isAllowedModel as isAllowedAnthropicModel } from "./models";

export type AiProvider = "anthropic" | "openrouter" | "omniroute";

export interface ModelRef {
  provider: AiProvider;
  model: string;
}

export function isOpenRouterConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

// OmniRoute has no required key — its "is this enabled" signal is whether the
// deployment owner has curated any models (see OMNIROUTE_ALLOWED_MODELS below).
export function isOmniRouteConfigured(): boolean {
  return parseAllowedOmniRouteModels().length > 0;
}

// Throws a clear setup error immediately (matching each client's own message)
// if the chosen provider isn't configured — call this before entering a retry
// loop, so a missing key/config fails fast instead of being retried as if it
// were a transient error.
export function ensureProviderConfigured(provider: AiProvider): void {
  if (provider === "anthropic") {
    getAnthropicClient();
    return;
  }
  if (provider === "openrouter") {
    getOpenRouterKey();
    return;
  }
  if (!isOmniRouteConfigured()) {
    throw new Error(
      "OMNIROUTE_ALLOWED_MODELS is not set. Add a comma-separated list of vision-capable OmniRoute model ids to your environment variables to enable OmniRoute."
    );
  }
}

// Choose a fallback model for when the client sends no valid {provider, model}
// choice. Prefer the caller's Anthropic default when Anthropic is configured;
// otherwise fall back to a configured provider so an OpenRouter/OmniRoute-only
// deployment works without an Anthropic key (instead of throwing "ANTHROPIC_API_KEY
// is not set"). Relies on the OpenRouter catalog already being refreshed by the
// caller (ensureOpenRouterCatalogFresh) before this runs.
export function preferredDefaultRef(anthropicDefault: ModelRef): ModelRef {
  if (process.env.ANTHROPIC_API_KEY) return anthropicDefault;
  if (isOpenRouterConfigured()) {
    const m = filterOpenRouterModels(currentOpenRouterCatalog(), { requireVision: true })[0];
    if (m) return { provider: "openrouter", model: m.id };
  }
  if (isOmniRouteConfigured()) {
    const [id] = parseAllowedOmniRouteModels();
    if (id) return { provider: "omniroute", model: id };
  }
  return anthropicDefault; // nothing configured → keep the clear "not set" error
}

// ── Making the call ───────────────────────────────────────────────────────────

export interface VisionCallUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface VisionCallResult {
  text: string;
  usage: VisionCallUsage;
}

export interface VisionCallOptions {
  ref: ModelRef;
  content: GenericContentPart[];
  system?: string;
  maxTokens: number;
  // Anthropic-only: cache the system prompt (ignored for OpenRouter, which has
  // no equivalent — an accepted tradeoff for free/cheap models).
  cacheSystem?: boolean;
}

function toAnthropicContent(parts: GenericContentPart[]): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const p of parts) {
    if (p.type === "text") {
      blocks.push({ type: "text", text: p.text });
    } else {
      const block = toImageBlock(p.image);
      if (block) blocks.push(block);
    }
  }
  return blocks;
}

// Shared by every OpenAI-compatible provider (OpenRouter, OmniRoute, ...).
function toOpenAIChatContent(parts: GenericContentPart[]): OpenAIChatContentPart[] {
  const out: OpenAIChatContentPart[] = [];
  for (const p of parts) {
    if (p.type === "text") {
      out.push({ type: "text", text: p.text });
    } else {
      const part = toOpenAIImagePart(p.image);
      if (part) out.push(part);
    }
  }
  return out;
}

export async function callVisionModel(opts: VisionCallOptions): Promise<VisionCallResult> {
  if (opts.ref.provider === "anthropic") {
    const client = getAnthropicClient();
    const resp = await client.messages.create({
      model: opts.ref.model,
      max_tokens: opts.maxTokens,
      ...(opts.system
        ? {
            system: [
              {
                type: "text" as const,
                text: opts.system,
                ...(opts.cacheSystem ? { cache_control: { type: "ephemeral" as const } } : {}),
              },
            ],
          }
        : {}),
      messages: [{ role: "user" as const, content: toAnthropicContent(opts.content) }],
    });
    const block = resp.content.find((b) => b.type === "text");
    const text = block && block.type === "text" ? block.text.trim() : "";
    return {
      text,
      usage: {
        input_tokens: resp.usage.input_tokens,
        output_tokens: resp.usage.output_tokens,
        cache_read_input_tokens: resp.usage.cache_read_input_tokens ?? undefined,
        cache_creation_input_tokens: resp.usage.cache_creation_input_tokens ?? undefined,
      },
    };
  }

  const content = toOpenAIChatContent(opts.content);
  if (opts.ref.provider === "openrouter") {
    return createOpenRouterCompletion({ model: opts.ref.model, system: opts.system, content, maxTokens: opts.maxTokens });
  }
  return createOmniRouteCompletion({ model: opts.ref.model, system: opts.system, content, maxTokens: opts.maxTokens });
}

// ── Account-level failures, provider-agnostic ────────────────────────────────

export function providerAuthError(
  e: unknown,
  provider: AiProvider
): AnthropicAuthError | OpenRouterAuthError | OmniRouteAuthError | null {
  if (provider === "anthropic") return anthropicAuthError(e);
  if (provider === "openrouter") return openRouterAuthError(e);
  return omniRouteAuthError(e);
}

export function isProviderAuthError(
  e: unknown
): e is AnthropicAuthError | OpenRouterAuthError | OmniRouteAuthError {
  return e instanceof AnthropicAuthError || e instanceof OpenRouterAuthError || e instanceof OmniRouteAuthError;
}

// ── OpenRouter catalog + allowlist ────────────────────────────────────────────
// The per-step model selector lets the browser send a {provider, model} pair to
// the AI routes. That's untrusted input: without validation, anyone past the
// access gate could bill an arbitrary or expensive model to the deployment
// owner's OpenRouter key. So we only ever accept an OpenRouter model id that is
// BOTH vision-capable (required for the sort/analyze routes, which always send
// photos) AND priced at or under OPENROUTER_MAX_PRICE_PER_M_TOKENS (default 0 —
// free models only; the deployment owner can raise this to allow cheap-but-not-
// free models too).
const MAX_MODEL_ID_LEN = 128;
const CATALOG_TTL = 60 * 60 * 1000; // 1 hour, matches /api/models' own cache

let openRouterCatalog: OpenRouterModel[] = [];
let openRouterCatalogAt = 0;

function maxPricePerMillionTokens(): number {
  const raw = process.env.OPENROUTER_MAX_PRICE_PER_M_TOKENS;
  const n = raw !== undefined && raw !== "" ? Number(raw) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function isVisionCapable(m: OpenRouterModel): boolean {
  return Boolean(m.architecture?.input_modalities?.includes("image"));
}

function isPriceAllowed(m: OpenRouterModel): boolean {
  const prompt = Number(m.pricing?.prompt);
  const completion = Number(m.pricing?.completion);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return false;
  const ceilingPerToken = maxPricePerMillionTokens() / 1_000_000;
  return prompt <= ceilingPerToken && completion <= ceilingPerToken;
}

// Refreshes (if stale) and returns the full raw catalog, for display in
// /api/models. Validation (below) always applies its own price/vision filter
// on top, regardless of what this returns.
export async function refreshOpenRouterCatalog(): Promise<OpenRouterModel[]> {
  const now = Date.now();
  if (openRouterCatalog.length && now - openRouterCatalogAt < CATALOG_TTL) {
    return openRouterCatalog;
  }
  const models = await listOpenRouterModels();
  openRouterCatalog = models;
  openRouterCatalogAt = now;
  return models;
}

export function currentOpenRouterCatalog(): OpenRouterModel[] {
  return openRouterCatalog;
}

// Shared by the allowlist check below and by /api/models (which shows the
// user exactly the set of models a request would actually be allowed to use).
export function filterOpenRouterModels(
  catalog: OpenRouterModel[],
  opts: { requireVision: boolean }
): OpenRouterModel[] {
  return catalog.filter((m) => isPriceAllowed(m) && (!opts.requireVision || isVisionCapable(m)));
}

function allowedOpenRouterModelIds(requireVision: boolean): Set<string> {
  return new Set(filterOpenRouterModels(openRouterCatalog, { requireVision }).map((m) => m.id));
}

// ── OmniRoute allowlist ───────────────────────────────────────────────────────
// OmniRoute aggregates 250+ heterogeneous providers behind one OpenAI-compatible
// API, and its /v1/models response doesn't reliably expose vision-capability or
// pricing metadata the way OpenRouter's does — so we can't safely auto-filter
// like we do for OpenRouter above. Instead, the deployment owner explicitly
// lists the OmniRoute model ids they've verified support vision, via
// OMNIROUTE_ALLOWED_MODELS (comma-separated). Nothing is offered until they do.
export function parseAllowedOmniRouteModels(): string[] {
  const raw = process.env.OMNIROUTE_ALLOWED_MODELS ?? "";
  return Array.from(new Set(raw.split(",").map((s) => s.trim()).filter(Boolean)));
}

function allowedOmniRouteModelIds(): Set<string> {
  return new Set(parseAllowedOmniRouteModels());
}

// Fails closed: a model id that isn't in the relevant provider's trusted
// allowlist is rejected — including before an OpenRouter catalog fetch ever
// completes (empty catalog) or when OMNIROUTE_ALLOWED_MODELS is unset.
export function isAllowedModelRef(ref: unknown, opts: { requireVision: boolean }): ref is ModelRef {
  if (!ref || typeof ref !== "object") return false;
  const provider = (ref as { provider?: unknown }).provider;
  const model = (ref as { model?: unknown }).model;
  if (typeof model !== "string" || model.length === 0 || model.length > MAX_MODEL_ID_LEN) return false;
  if (provider === "anthropic") return isAllowedAnthropicModel(model);
  if (provider === "openrouter") return allowedOpenRouterModelIds(opts.requireVision).has(model);
  if (provider === "omniroute") return allowedOmniRouteModelIds().has(model);
  return false;
}

export function resolveModelRef(
  requested: unknown,
  fallback: ModelRef,
  opts: { requireVision: boolean }
): ModelRef {
  if (isAllowedModelRef(requested, opts)) {
    return { provider: requested.provider, model: requested.model };
  }
  return fallback;
}

// Best-effort display names for the curated OmniRoute allowlist. Never throws
// — /api/models falls back to showing the raw model id if OmniRoute is
// unreachable, since the allowlist itself (not this) is what makes a model
// usable.
export async function omniRouteDisplayNames(): Promise<Map<string, string>> {
  try {
    const models = await listOmniRouteModels();
    return new Map(models.map((m) => [m.id, m.name || m.id]));
  } catch {
    return new Map();
  }
}
