// eBay Taxonomy API: resolve the correct LEAF category and its REQUIRED item
// specifics (aspects) with valid values — instead of guessing from a static map.
//
// This fixes the two publish failure modes:
//   • 25005 "not a leaf category" — the static map held parent categories
//     (e.g. womens_shoes → 3034 "Women's Shoes"); eBay only accepts leaves.
//   • 25002 "<aspect> is missing" — required specifics vary per leaf category
//     and SELECTION_ONLY aspects only accept values from eBay's own list
//     (e.g. Department must be "Unisex Adults", never "Unisex Adult").
//
// These endpoints are read-only, app-level data. We authenticate with a
// client-credentials app token (minted + cached here), independent of the
// seller's user token — so this never needs a re-auth or a new user scope.

import {
  EBAY_TAX_BASE,
  EBAY_META_BASE,
  EBAY_MARKETPLACE_ID,
  EBAY_CATEGORY_TREE_ID,
  EBAY_TOKEN_URL,
  basicAuthHeader,
  getEbayCreds,
} from "./config";

export type AspectMode = "FREE_TEXT" | "SELECTION_ONLY";

export interface AspectMeta {
  name: string;
  required: boolean;
  mode: AspectMode;
  values: string[]; // eBay's allowed/suggested values (full list for SELECTION_ONLY)
}

// ── App token (client-credentials), cached in the warm lambda ────────────────

let cachedToken: { token: string; expiresAt: number } | null = null;

async function appToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) return cachedToken.token;
  const creds = getEbayCreds();
  const resp = await fetch(EBAY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(creds),
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope",
    }).toString(),
  });
  if (!resp.ok) throw new Error(`eBay app token failed (${resp.status})`);
  const data = (await resp.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, expiresAt: now + data.expires_in * 1000 };
  return data.access_token;
}

async function taxGet(path: string): Promise<any | null> {
  const token = await appToken();
  const resp = await fetch(
    `${EBAY_TAX_BASE}/category_tree/${EBAY_CATEGORY_TREE_ID}/${path}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Accept-Language": "en-US",
      },
    }
  );
  if (!resp.ok) return null;
  return resp.json().catch(() => null);
}

// ── Public API ───────────────────────────────────────────────────────────────

// Resolve the best LEAF category id for a free-text query (title + hint).
// eBay only suggests leaf categories, so the top hit is always publish-safe.
export async function suggestLeafCategory(query: string): Promise<string | null> {
  const q = (query || "").trim().slice(0, 350);
  if (!q) return null;
  try {
    const data = await taxGet(`get_category_suggestions?q=${encodeURIComponent(q)}`);
    const id = data?.categorySuggestions?.[0]?.category?.categoryId;
    return id ? String(id) : null;
  } catch {
    return null;
  }
}

const aspectCache = new Map<string, AspectMeta[]>();

// Required + optional aspects for a leaf category, with eBay's allowed values.
export async function categoryAspects(categoryId: string): Promise<AspectMeta[]> {
  if (!categoryId) return [];
  const cached = aspectCache.get(categoryId);
  if (cached) return cached;
  try {
    const data = await taxGet(
      `get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`
    );
    const out: AspectMeta[] = [];
    for (const a of data?.aspects ?? []) {
      const con = a?.aspectConstraint ?? {};
      const name = String(a?.localizedAspectName ?? "").trim();
      if (!name) continue;
      out.push({
        name,
        required: Boolean(con?.aspectRequired),
        mode: con?.aspectMode === "SELECTION_ONLY" ? "SELECTION_ONLY" : "FREE_TEXT",
        values: (a?.aspectValues ?? [])
          .map((v: any) => String(v?.localizedValue ?? "").trim())
          .filter(Boolean),
      });
    }
    aspectCache.set(categoryId, out);
    return out;
  } catch {
    return [];
  }
}

const condCache = new Map<string, Set<number>>();

// Numeric condition IDs eBay accepts for a leaf category (Sell Metadata API).
// Lets us pick a condition the category actually allows — fashion leaves reject
// the classic USED_VERY_GOOD/GOOD/ACCEPTABLE ids (4000/5000/6000), accepting
// only New variants plus 2990/3000/3010, which is the source of error 25021.
//
// Prefer the seller's user token when the caller has one: the client-credentials
// app token can be rejected by the Metadata API (scope), and a silent failure
// here is what made every apparel item publish as generic id 3000 — which eBay
// displays as "Pre-owned – Good" in clothing categories regardless of the item's
// real grade.
export async function acceptedConditionIds(
  categoryId: string,
  userToken?: string
): Promise<Set<number>> {
  if (!categoryId) return new Set();
  const cached = condCache.get(categoryId);
  if (cached) return cached;
  try {
    const token = userToken || (await appToken());
    const url =
      `${EBAY_META_BASE}/marketplace/${EBAY_MARKETPLACE_ID}` +
      `/get_item_condition_policies?filter=categoryIds:%7B${encodeURIComponent(categoryId)}%7D`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Accept-Language": "en-US",
      },
    });
    if (!resp.ok) {
      // Don't fail silently — this is exactly the path that mis-grades items.
      console.warn(
        `[ebay/taxonomy] condition policies unavailable for category ${categoryId} (HTTP ${resp.status})`
      );
      return new Set();
    }
    const data = await resp.json().catch(() => null);
    const ids = new Set<number>();
    for (const p of data?.itemConditionPolicies ?? [])
      for (const c of p?.itemConditions ?? []) {
        const n = Number(c?.conditionId);
        if (n) ids.add(n);
      }
    condCache.set(categoryId, ids);
    return ids;
  } catch (e) {
    console.warn(
      `[ebay/taxonomy] condition policies failed for category ${categoryId}: ${(e as Error).message}`
    );
    return new Set();
  }
}
