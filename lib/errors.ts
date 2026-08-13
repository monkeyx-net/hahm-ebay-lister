// Reading provider errors, shared by every provider client and the sort pipeline.
//
// Each SDK/fetch wrapper throws a slightly different shape, and the naive
// `"status" in e ? Number(e.status) : undefined` gets one case badly wrong: the
// Anthropic SDK's connection error DOES carry a `status` key whose value is
// `undefined`, so the property test passes and Number() yields NaN — which then
// silently fails every `status === 429`-style comparison and, worse, looks like a
// real status to code that only checks for `undefined`.

/** HTTP status off a provider error, or undefined when there isn't a usable one. */
export function httpStatus(e: unknown): number | undefined {
  const raw = e && typeof e === "object" && "status" in e ? (e as { status?: unknown }).status : undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Best-effort human-readable message for logging. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message?: unknown }).message ?? "");
  return String(e);
}
