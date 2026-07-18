// OmniRoute client — a self-hosted, OpenAI-compatible AI gateway
// (https://github.com/diegosouzapw/OmniRoute) that proxies 250+ providers.
// Unlike the Anthropic/OpenRouter clients, both the base URL and the API key
// are optional/configurable here: OmniRoute typically runs as its own local
// process or sidecar container, and by default has no auth requirement at all
// (REQUIRE_API_KEY defaults to false upstream).

import type { OpenAIChatContentPart, OpenAIChatResult } from "./images";

const DEFAULT_BASE_URL = "http://localhost:20128/v1";

export function getOmniRouteBaseUrl(): string {
  const raw = process.env.OMNIROUTE_BASE_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : DEFAULT_BASE_URL;
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = process.env.OMNIROUTE_API_KEY?.trim();
  // Only sent if configured — most OmniRoute setups run open on localhost/a
  // private network and don't require it (REQUIRE_API_KEY=false by default).
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

// ── Account-level OmniRoute failures ─────────────────────────────────────────
// Mirrors AnthropicAuthError/OpenRouterAuthError. Only relevant when the
// deployment owner has turned on REQUIRE_API_KEY upstream.
export class OmniRouteAuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OmniRouteAuthError";
    this.status = status;
  }
}

export function omniRouteAuthError(e: unknown): OmniRouteAuthError | null {
  const status =
    e && typeof e === "object" && "status" in e
      ? Number((e as { status?: number }).status)
      : undefined;
  if (status === 401)
    return new OmniRouteAuthError(
      "OmniRoute rejected the request (401). If REQUIRE_API_KEY is enabled on your OmniRoute instance, set OMNIROUTE_API_KEY to a valid key from its Dashboard → Endpoints panel.",
      401
    );
  return null;
}

async function httpError(resp: Response): Promise<Error & { status: number }> {
  const body = await resp.text().catch(() => "");
  const err = new Error(body || `OmniRoute request failed (${resp.status})`) as Error & {
    status: number;
  };
  err.status = resp.status;
  return err;
}

export async function createChatCompletion(opts: {
  model: string;
  system?: string;
  content: OpenAIChatContentPart[];
  maxTokens: number;
}): Promise<OpenAIChatResult> {
  const messages: { role: string; content: string | OpenAIChatContentPart[] }[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.content });

  const resp = await fetch(`${getOmniRouteBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: opts.model, max_tokens: opts.maxTokens, messages }),
    // A hung/unreachable local gateway must not hang the request forever —
    // the retry loops in server/api.ts and lib/sortPipeline.ts expect a call
    // to fail within a bounded time so they can back off and retry.
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw await httpError(resp);

  const data = (await resp.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content?.trim() ?? "";
  return {
    text,
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

export interface OmniRouteModel {
  id: string;
  name?: string;
}

// Best-effort only: OmniRoute's /v1/models response doesn't reliably expose
// vision/pricing metadata across its 250+ heterogeneous upstream providers, so
// (unlike OpenRouter) this is NOT used to auto-filter or validate models —
// lib/providers.ts trusts the deployment owner's explicit OMNIROUTE_ALLOWED_
// MODELS list for that. This is only used to drop a configured model from
// /api/models display if it's no longer live; a failure here is non-fatal.
export async function listOmniRouteModels(): Promise<OmniRouteModel[]> {
  const resp = await fetch(`${getOmniRouteBaseUrl()}/models`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) throw await httpError(resp);
  const data = (await resp.json()) as { data?: OmniRouteModel[] };
  return data.data ?? [];
}
