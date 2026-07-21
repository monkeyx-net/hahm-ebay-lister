// eBay Browse API: a real price signal to sit next to Claude's estimate.
//
// `suggested_price` is Claude's guess from the photos; this pulls the actual
// prices of comparable ACTIVE listings on the seller's marketplace so the UI
// can show a live range/median. It uses the same client-credentials app token
// as taxonomy (read-only, app-level) — no seller connection required.
//
// Note: these are ASKING prices of active listings, not sold prices. Sold-price
// data needs the limited-release Marketplace Insights API; active comps are the
// signal available with a standard keyset.

import { EBAY_MARKETPLACE_ID, EBAY_CURRENCY, EBAY_LOCALE } from "./config";
import { appToken } from "./taxonomy";
import type { CompsResult } from "../types";

export type { CompsResult };

const EBAY_BROWSE_BASE = "https://api.ebay.com/buy/browse/v1";

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Drop the cheapest/most-expensive 10% so a single mispriced or wrong-item
// listing doesn't blow out the range. Only trims when there's enough to spare.
function trimOutliers(nums: number[]): number[] {
  if (nums.length < 5) return nums;
  const s = [...nums].sort((a, b) => a - b);
  const cut = Math.floor(s.length * 0.1);
  return s.slice(cut, s.length - cut);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Median/range of comparable active listings for a free-text query (the item
// title works well). Returns null when there are no usable comps; throws with an
// actionable message when eBay refuses the request (e.g. Buy API not enabled).
export async function fetchActiveComps(query: string): Promise<CompsResult | null> {
  const q = (query || "").trim().slice(0, 200);
  if (!q) return null;

  const token = await appToken();
  const params = new URLSearchParams({
    q,
    limit: "50",
    // Only fixed-price listings, so the numbers compare to a Buy-It-Now price.
    filter: "buyingOptions:{FIXED_PRICE}",
  });
  const resp = await fetch(
    `${EBAY_BROWSE_BASE}/item_summary/search?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Accept-Language": EBAY_LOCALE,
        "X-EBAY-C-MARKETPLACE-ID": EBAY_MARKETPLACE_ID,
      },
    }
  );

  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(
        `eBay denied the Browse API request (${resp.status}). Your keyset may need Buy API access enabled in the eBay developer portal.`
      );
    }
    return null; // treat other failures as "no comps available"
  }

  const data = (await resp.json().catch(() => null)) as {
    itemSummaries?: { price?: { value?: string; currency?: string } }[];
  } | null;

  const prices: number[] = [];
  for (const it of data?.itemSummaries ?? []) {
    const val = Number(it?.price?.value);
    const cur = String(it?.price?.currency || "");
    // Keep only prices in the marketplace's own currency so the range is comparable.
    if (val > 0 && (!cur || cur === EBAY_CURRENCY)) prices.push(val);
  }
  if (prices.length === 0) return null;

  const used = trimOutliers(prices);
  return {
    count: used.length,
    low: round2(Math.min(...used)),
    high: round2(Math.max(...used)),
    median: round2(median(used)),
    currency: EBAY_CURRENCY,
  };
}

// ── Price reconciliation ─────────────────────────────────────────────────────
// The model's suggested_price is a guess from the photos and tends to run high.
// When we have real comps, pull an over-market guess back toward reality — but
// only when it's *wildly* high, and never fully discard the model's signal.

const MIN_COMPS = 3; // ignore thin/noisy comp sets — trust the model instead
const SOLD_DISCOUNT = 0.9; // active asking prices overstate real sold value
const OVERSHOOT = 1.5; // only intervene when the guess exceeds market by this much
const BLEND_W = 0.65; // weight on the market anchor when we do intervene

export interface Reconciled {
  suggested_price: number | string;
  llm_price: number | string;
  price_source: "llm" | "blended";
}

// Pure: no I/O. Decides the default price from the model's guess + comps.
export function reconcilePrice(
  rawLlm: number | string | undefined,
  comps: CompsResult | null
): Reconciled {
  const raw = rawLlm ?? "";
  const llm = typeof raw === "string" ? parseFloat(raw) : raw;

  // No usable guess, or no trustworthy market signal → keep the model's value.
  if (!llm || Number.isNaN(llm) || llm <= 0) {
    return { suggested_price: raw, llm_price: raw, price_source: "llm" };
  }
  if (!comps || comps.count < MIN_COMPS) {
    return { suggested_price: raw, llm_price: raw, price_source: "llm" };
  }

  const anchor = comps.median * SOLD_DISCOUNT;

  // Within a believable band of the market → trust the model's judgement.
  if (llm <= anchor * OVERSHOOT) {
    return { suggested_price: raw, llm_price: raw, price_source: "llm" };
  }

  // Wildly high → blend toward the anchor (keep 1-BLEND_W of the guess) and clamp
  // to the top of the observed active range so we never exceed a real listing.
  const blended = round2(BLEND_W * anchor + (1 - BLEND_W) * llm);
  return {
    suggested_price: Math.min(blended, comps.high),
    llm_price: raw,
    price_source: "blended",
  };
}
