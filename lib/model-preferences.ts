"use client";

// Kept as a plain local type (not imported from lib/providers, which pulls in
// server-only clients) since this module runs in the browser.
export interface ModelChoice {
  provider: "anthropic" | "openrouter";
  model: string;
}

const SORT_KEY = "listing-writer:sort-model";
const ANALYSIS_KEY = "listing-writer:analysis-model";

// OpenRouter model ids use single colons (e.g. "google/gemini-2.0-flash-exp:free"),
// so "::" is a safe, unambiguous provider/model separator.
function parse(raw: string | null): ModelChoice | null {
  if (!raw) return null;
  if (!raw.includes("::")) {
    // Backward-compat: earlier versions stored a bare Claude model id.
    return { provider: "anthropic", model: raw };
  }
  const sep = raw.indexOf("::");
  const provider = raw.slice(0, sep);
  const model = raw.slice(sep + 2);
  if ((provider !== "anthropic" && provider !== "openrouter") || !model) return null;
  return { provider, model };
}

function serialize(choice: ModelChoice): string {
  return `${choice.provider}::${choice.model}`;
}

export function getSortModel(): ModelChoice | null {
  try {
    return parse(window.localStorage.getItem(SORT_KEY));
  } catch {
    return null;
  }
}

export function saveSortModel(choice: ModelChoice): void {
  try {
    window.localStorage.setItem(SORT_KEY, serialize(choice));
  } catch {
    /* private browsing — pref won't persist */
  }
}

export function getAnalysisModel(): ModelChoice | null {
  try {
    return parse(window.localStorage.getItem(ANALYSIS_KEY));
  } catch {
    return null;
  }
}

export function saveAnalysisModel(choice: ModelChoice): void {
  try {
    window.localStorage.setItem(ANALYSIS_KEY, serialize(choice));
  } catch {
    /* private browsing — pref won't persist */
  }
}
