// OpenRouter client — mirrors lib/anthropic.ts, but OpenRouter has no official
// SDK we already depend on, so this talks to its OpenAI-compatible REST API
// directly with fetch (same convention as lib/ebay/*.ts).

const BASE_URL = "https://openrouter.ai/api/v1";

export function getOpenRouterKey(): string {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Add it to your environment variables (Coolify → Environment, or .env.local for local dev)."
    );
  }
  return apiKey;
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    // OpenRouter uses these to attribute/rank apps on openrouter.ai — harmless
    // to omit, but recommended by their docs.
    "HTTP-Referer": process.env.APP_URL || "https://github.com/monkeyx-net/hahm-ebay-lister",
    "X-Title": "Listing Writer",
  };
}

export type OpenRouterContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatCompletionResult {
  text: string;
  usage: { input_tokens: number; output_tokens: number };
}

// ── Account-level OpenRouter failures ────────────────────────────────────────
// Mirrors AnthropicAuthError: a bad/missing key or exhausted credits fails
// every call, so surface it distinctly instead of retrying or degrading.
export class OpenRouterAuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OpenRouterAuthError";
    this.status = status;
  }
}

export function openRouterAuthError(e: unknown): OpenRouterAuthError | null {
  const status =
    e && typeof e === "object" && "status" in e
      ? Number((e as { status?: number }).status)
      : undefined;
  const message = e instanceof Error ? e.message : "";
  if (status === 401)
    return new OpenRouterAuthError(
      "OpenRouter rejected your API key (401). Check that OPENROUTER_API_KEY is set correctly.",
      401
    );
  if (status === 402 || /credit balance|too low|billing|payment|insufficient|quota/i.test(message))
    return new OpenRouterAuthError(
      "Your OpenRouter account can't cover this request — add credits at openrouter.ai, then try again.",
      402
    );
  return null;
}

async function httpError(resp: Response): Promise<Error & { status: number }> {
  const body = await resp.text().catch(() => "");
  const err = new Error(body || `OpenRouter request failed (${resp.status})`) as Error & {
    status: number;
  };
  err.status = resp.status;
  return err;
}

export async function createChatCompletion(opts: {
  model: string;
  system?: string;
  content: OpenRouterContentPart[];
  maxTokens: number;
}): Promise<ChatCompletionResult> {
  const apiKey = getOpenRouterKey();
  const messages: { role: string; content: string | OpenRouterContentPart[] }[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.content });

  const resp = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({ model: opts.model, max_tokens: opts.maxTokens, messages }),
    // A hung/unreachable OpenRouter must not hang the request forever — the
    // retry loops in server/api.ts and lib/sortPipeline.ts expect a call to
    // fail within a bounded time so they can back off and retry.
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

export interface OpenRouterModel {
  id: string;
  name: string;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { input_modalities?: string[] };
}

// Live catalog — used both to populate /api/models and to build the
// server-side allowlist of models this deployment will actually call.
export async function listOpenRouterModels(): Promise<OpenRouterModel[]> {
  const apiKey = getOpenRouterKey();
  // Bounded so an unreachable OpenRouter can't hang /api/models (or the
  // catalog refresh inside /api/analyze and /api/sort) indefinitely.
  const resp = await fetch(`${BASE_URL}/models`, {
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw await httpError(resp);
  const data = (await resp.json()) as { data?: OpenRouterModel[] };
  return data.data ?? [];
}
