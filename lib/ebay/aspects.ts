// Small helpers for eBay item-specifics (aspects), shared between the publish
// pipeline and the model-assisted aspect filler.

import type { AspectMeta } from "./taxonomy";

// eBay rejects any item-specific (aspect) value longer than this (error 25002).
export const MAX_ASPECT_VALUE_LEN = 65;

// Clip an aspect value to eBay's limit, breaking at a word boundary when the
// truncation point lands far enough in to leave a readable phrase.
export function clipAspectValue(s: string): string {
  const t = (s || "").trim();
  if (t.length <= MAX_ASPECT_VALUE_LEN) return t;
  const cut = t.slice(0, MAX_ASPECT_VALUE_LEN);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > MAX_ASPECT_VALUE_LEN * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

// Match a value against eBay's allowed list, case-insensitively and tolerating
// singular/plural (so "Unisex Adult" resolves to the valid "Unisex Adults").
// Returns the canonical allowed value, or null if there's no match.
export function matchAllowed(value: string, allowed: string[]): string | null {
  const ls = (value || "").trim().toLowerCase();
  if (!ls) return null;
  for (const v of allowed) {
    const lv = v.toLowerCase();
    if (lv === ls || lv === `${ls}s` || `${lv}s` === ls) return v;
  }
  return null;
}

// Rename model-provided aspect keys to eBay's exact (canonical) aspect names,
// matching case-insensitively. The analysis model says "Country/region of
// manufacture" or "SLEEVE LENGTH"; eBay only counts the specific if the key
// matches its localized aspect name exactly — otherwise it stays "suggested"
// on the live listing.
export function canonicalizeAspectKeys(
  aspects: Record<string, string[]>,
  meta: AspectMeta[]
): void {
  const canonical = new Map<string, string>();
  for (const a of meta) {
    if (a.name) canonical.set(a.name.toLowerCase(), a.name);
  }
  for (const key of Object.keys(aspects)) {
    const proper = canonical.get(key.toLowerCase());
    if (proper && proper !== key) {
      if (!aspects[proper]) aspects[proper] = aspects[key];
      delete aspects[key];
    }
  }
  // Snap SELECTION_ONLY values to eBay's canonical spelling where we can.
  for (const a of meta) {
    if (a.mode !== "SELECTION_ONLY" || !aspects[a.name]?.length) continue;
    const snapped = matchAllowed(aspects[a.name][0], a.values);
    if (snapped) aspects[a.name] = [snapped];
  }
}
