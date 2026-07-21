// eBay publish pipeline, ported from ebay_lister_v2_robust.py.
// Sequence: upload photos → create inventory item → create offer → publish,
// with recovery for missing item specifics, rejected conditions, and non-leaf
// categories.

import {
  EBAY_ACC_BASE,
  EBAY_INV_BASE,
  EBAY_MARKETPLACE_ID,
  EBAY_TRADING,
  EBAY_SITE_ID,
  EBAY_CURRENCY,
  EBAY_LOCALE,
  EBAY_LOCATION_COUNTRY,
} from "./config";
import {
  suggestLeafCategory,
  categoryAspects,
  acceptedConditionIds,
  type AspectMeta,
} from "./taxonomy";
import type { ListingResult } from "../types";
import { mapLimit } from "../concurrency";
import { APPAREL_CATEGORIES, PANTS_CATEGORIES } from "../categories";

// ── Constants (from the Python script) ───────────────────────────────────────

// OFFLINE FALLBACK ONLY. The live path resolves the correct leaf category for
// the active marketplace via suggestLeafCategory() (Taxonomy API); this map is
// used only when that call is unavailable. eBay category IDs are PER-MARKETPLACE
// (UK tree = 3, US tree = 0, …), so these must match your EBAY_CATEGORY_TREE_ID.
// The values below are seeded for the UK tree (3); regenerate them for your
// marketplace with `npm run refresh:categories` (see README → "Category IDs and
// your marketplace") and paste the output here.
const CATEGORY_MAP: Record<string, string> = {
  womens_top: "53159", womens_dress: "63861", womens_skirt: "63864",
  womens_pants: "63863", womens_coat: "63862", womens_sweater: "63866",
  womens_jeans: "11554", womens_clothing: "53159", womens_shoes: "55793",
  mens_top: "57990", mens_pants: "57989", mens_coat: "57988",
  mens_sweater: "11484", mens_jeans: "11483", mens_clothing: "15687",
  mens_shoes: "15709", handbag: "169291", wallet: "45258",
  jewelry: "155101", scarf: "45238", belt: "3003",
  sunglasses: "45246", hat: "52365", accessory: "50677",
  doll: "262346", collectible: "261628", collector_plate: "261612",
  toy: "80546", home_decor: "36025", book: "261186",
  knife: "116005", sporting_goods: "177831", electronics: "259701",
  camera: "31388", audio: "14990", video_game: "139973",
  media: "617", vinyl_record: "176985", cd: "176984",
  dvd_bluray: "617", musical_instrument: "10183", kitchenware: "20649",
  glassware: "20696", pottery_ceramics: "262366", art: "360",
  craft: "146545", tool: "42255", automotive: "9886",
  office: "3295", health_beauty: "1277", small_appliance: "179309",
  lighting: "20706", linens: "37644", holiday: "166725",
  board_game: "180349", puzzle: "19183", plush: "230",
  action_figure: "261068", trading_card: "261328", sports_memorabilia: "2830",
  coin: "122486", stamp: "3478", ephemera: "126",
  other: "88433",
};

// Generic leaves tried on a 25005 "not a leaf" error. Also marketplace-specific
// (UK tree seed) — `npm run refresh:categories` regenerates these too.
const LEAF_FALLBACKS = ["261628", "261068", "36025", "261186", "176984", "230", "19183", "155101"];

const CONDITION_ALIASES: Record<string, string> = {
  NEW: "NEW_WITH_TAGS",
  NWT: "NEW_WITH_TAGS",
  NEW_WITH_TAGS: "NEW_WITH_TAGS",
  NEW_WITH_BOX: "NEW_WITH_TAGS",
  NEW_WITHOUT_TAGS: "NEW_NO_TAGS",
  NEW_WITHOUT_BOX: "NEW_NO_TAGS",
  NEW_NO_TAGS: "NEW_NO_TAGS",
  NEW_OTHER: "NEW_NO_TAGS",
  OPEN_BOX: "NEW_NO_TAGS",
  LIKE_NEW: "EXCELLENT",
  PREOWNED_EXCELLENT: "EXCELLENT",
  PRE_OWNED_EXCELLENT: "EXCELLENT",
  USED_EXCELLENT: "EXCELLENT",
  EXCELLENT: "EXCELLENT",
  VERY_GOOD: "VERY_GOOD",
  PREOWNED_VERY_GOOD: "VERY_GOOD",
  PRE_OWNED_VERY_GOOD: "VERY_GOOD",
  USED_VERY_GOOD: "VERY_GOOD",
  USED: "GOOD",
  PREOWNED: "GOOD",
  PRE_OWNED: "GOOD",
  USED_GOOD: "GOOD",
  PREOWNED_GOOD: "GOOD",
  PRE_OWNED_GOOD: "GOOD",
  GOOD: "GOOD",
  ACCEPTABLE: "FAIR",
  USED_ACCEPTABLE: "FAIR",
  FAIR: "FAIR",
  PREOWNED_FAIR: "FAIR",
  PRE_OWNED_FAIR: "FAIR",
  USED_FAIR: "FAIR",
};

const CONDITION_ID_ENUM: Record<number, string> = {
  1000: "NEW",
  1500: "NEW_OTHER",
  1750: "NEW_WITH_DEFECTS",
  2750: "LIKE_NEW",
  2990: "PRE_OWNED_EXCELLENT",
  3000: "USED_EXCELLENT",
  3010: "PRE_OWNED_FAIR",
  4000: "USED_VERY_GOOD",
  5000: "USED_GOOD",
  6000: "USED_ACCEPTABLE",
  7000: "FOR_PARTS_OR_NOT_WORKING",
};

const GENERAL_CONDITION_ID_PREFERENCES: Record<string, number[]> = {
  NEW_WITH_TAGS: [1000, 1500, 1750],
  NEW_NO_TAGS: [1500, 1000, 1750],
  EXCELLENT: [3000, 2750, 4000, 5000],
  VERY_GOOD: [4000, 3000, 5000, 2750],
  GOOD: [5000, 4000, 3000, 6000],
  FAIR: [6000, 5000, 4000, 3000],
};

const APPAREL_CONDITION_ID_PREFERENCES: Record<string, number[]> = {
  NEW_WITH_TAGS: [1000, 1500, 1750],
  NEW_NO_TAGS: [1500, 1000, 1750],
  EXCELLENT: [2990, 3000, 3010],
  // eBay has no apparel "Very Good" tier. Use Good before overgrading as Excellent.
  VERY_GOOD: [3000, 2990, 3010],
  GOOD: [3000, 3010, 2990],
  FAIR: [3010, 3000, 2990],
};

const GENERAL_SAFE_CONDITION_IDS = [3000, 4000, 5000, 6000, 2750, 1500, 1000, 1750, 7000];
const APPAREL_SAFE_CONDITION_IDS = [3000, 2990, 3010, 1500, 1000, 1750];

const ASPECT_DEFAULTS: Record<string, string> = {
  "Skirt Length": "Knee-Length", "Dress Length": "Knee-Length", Rise: "Mid Rise",
  "Leg Style": "Straight", Closure: "Pull-On", "Shoe Width": "Medium",
  "Heel Height": "Flat", "Toe Shape": "Round", Adjustable: "Yes",
  "Exterior Pockets": "Yes", Lining: "Lined", Hood: "No Hood", "Bag Closure": "Zip",
  "Strap Type": "Adjustable", "Hat Style": "Baseball Cap", "Brim Style": "Curved Bill",
  "Size Type": "Regular", Style: "Casual", Department: "Unisex Adult",
  Type: "Item", Brand: "Unbranded", Color: "Multicolor", Material: "Mixed Materials",
};

// eBay's size standardization (enforced July 2026) blocks or holds listings
// whose Size is a placeholder or non-standard value, so size aspects are only
// ever filled from real listing data — never from defaults or guesses.
// "Size Type" (Regular/Plus/Petite/…) is exempt: it's a fit class, not a size.
function isSizeAspect(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("size") && !n.includes("size type");
}

const PLACEHOLDER_SIZE_RE =
  /^(see\s|refer\s|check\s|unknown\b|n\/?a\b|none\b|not\s|no\s(size|tag)|[-?]+$|tbd\b)/i;

function cleanSize(raw: unknown): string {
  const s = String(raw || "").trim();
  return PLACEHOLDER_SIZE_RE.test(s) ? "" : s;
}

// ── eBay REST client (token-authed) ──────────────────────────────────────────

export interface EbayResp {
  ok: boolean;
  status: number;
  json: any;
  text: string;
}

export async function ebayRequest(
  accessToken: string,
  method: string,
  url: string,
  opts: { body?: unknown; extraHeaders?: Record<string, string> } = {}
): Promise<EbayResp> {
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      // Node's fetch defaults Accept-Language to "*", which eBay rejects
      // (error 25709). Pin it to the marketplace's locale.
      "Accept-Language": EBAY_LOCALE,
      ...(opts.extraHeaders || {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await resp.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON (e.g. empty 204) */
  }
  return { ok: resp.ok, status: resp.status, json, text };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Use the seller's entered price verbatim. eBay rejects a zero/invalid price,
// so fall back to a sane default only when nothing usable was provided — never
// silently mark up the price the seller set.
function computeOfferPrice(raw: number | string | undefined): number {
  const base = typeof raw === "string" ? parseFloat(raw) : raw ?? 0;
  if (!base || Number.isNaN(base) || base <= 0) return 29.99;
  return Math.round(base * 100) / 100;
}

// eBay's CALCULATED-shipping business policies REQUIRE package weight (and
// dimensions) on the inventory item, or publish fails with error 25020 ("package
// weight is not valid or is missing"). Flat-rate policies don't need it. We always
// send a sensible default so calculated policies publish out of the box; the
// seller can refine weight/size on the listing afterward, or tune the defaults
// via EBAY_DEFAULT_PACKAGE_* env vars. Weight is in ounces (16 oz = 1 lb).
function defaultPackageWeightAndSize(): Record<string, unknown> {
  const num = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    weight: {
      value: num(process.env.EBAY_DEFAULT_PACKAGE_WEIGHT_OZ, 16),
      unit: "OUNCE",
    },
    dimensions: {
      length: num(process.env.EBAY_DEFAULT_PACKAGE_LENGTH_IN, 12),
      width: num(process.env.EBAY_DEFAULT_PACKAGE_WIDTH_IN, 9),
      height: num(process.env.EBAY_DEFAULT_PACKAGE_HEIGHT_IN, 3),
      unit: "INCH",
    },
    packageType: "PACKAGE_THICK_ENVELOPE",
  };
}

function normalizeConditionInput(value: string | undefined): string {
  const cleaned = (value || "GOOD")
    .trim()
    .toUpperCase()
    .replace(/['’]/g, "")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return CONDITION_ALIASES[cleaned] || "GOOD";
}

function isApparelConditionPolicy(acceptedIds: Set<number>): boolean {
  return acceptedIds.has(2990) || acceptedIds.has(3010);
}

function conditionIdsForGrade(grade: string, acceptedIds: Set<number>): number[] {
  const apparel = isApparelConditionPolicy(acceptedIds);
  const preferences = apparel ? APPAREL_CONDITION_ID_PREFERENCES : GENERAL_CONDITION_ID_PREFERENCES;
  const safeIds = apparel ? APPAREL_SAFE_CONDITION_IDS : GENERAL_SAFE_CONDITION_IDS;
  const preferred = preferences[grade] || preferences.GOOD;

  if (!acceptedIds.size) return preferred;

  const out: number[] = [];
  const add = (id: number) => {
    if (acceptedIds.has(id) && CONDITION_ID_ENUM[id] && !out.includes(id)) out.push(id);
  };
  for (const id of preferred) add(id);
  for (const id of safeIds) add(id);
  for (const id of acceptedIds) add(id);
  return out.length ? out : preferred;
}

// Ordered eBay Inventory condition enums to try for an internal grade. The grade
// comes from photo analysis; the allowed IDs come from the chosen leaf category's
// Metadata policy, so apparel/books/electronics/etc. can each resolve differently.
function conditionCandidates(grade: string | undefined, acceptedIds: Set<number>): string[] {
  const desired = normalizeConditionInput(grade);
  const out: string[] = [];
  for (const id of conditionIdsForGrade(desired, acceptedIds)) {
    const en = CONDITION_ID_ENUM[id];
    if (en && !out.includes(en)) out.push(en);
  }
  return out.length ? out : ["USED_GOOD"];
}

function resolveCategory(listing: ListingResult): {
  categoryId: string;
  fallbacks: string[];
} {
  const explicit = (listing.category_id || "").toString().trim();
  const catKey = (listing.category || "other").toString();
  const mapped = CATEGORY_MAP[catKey] || CATEGORY_MAP.other;
  const categoryId = explicit || mapped;
  const fallbacks = LEAF_FALLBACKS.filter((c) => c && c !== categoryId);
  return { categoryId, fallbacks };
}

// The eBay leaf category this listing will publish to. Mirrors the resolution in
// publishListing() (Taxonomy suggestion first, static map as fallback) so the
// review UI can ask /api/ebay/aspects for the SAME category's required specifics
// the publish path will enforce.
export async function resolveLeafCategoryId(listing: ListingResult): Promise<string> {
  const { categoryId: staticCat } = resolveCategory(listing);
  const leaf = await suggestLeafCategory(`${listing.category_hint || ""} ${listing.title || ""}`);
  return leaf || staticCat;
}

// eBay rejects any item-specific (aspect) value longer than this (error 25002).
const MAX_ASPECT_VALUE_LEN = 65;

// Clip an aspect value to eBay's limit, breaking at a word boundary when the
// truncation point lands far enough in to leave a readable phrase.
function clipAspectValue(s: string): string {
  const t = (s || "").trim();
  if (t.length <= MAX_ASPECT_VALUE_LEN) return t;
  const cut = t.slice(0, MAX_ASPECT_VALUE_LEN);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > MAX_ASPECT_VALUE_LEN * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

function singleValue(v: unknown): string {
  if (Array.isArray(v)) {
    for (const x of v) {
      const s = singleValue(x);
      if (s) return s;
    }
    return "";
  }
  let s = String(v ?? "").trim();
  if (!s) return "";
  for (const sep of ["/", ",", "|", "&", " and "]) {
    if (s.includes(sep)) {
      s = s.split(sep)[0].trim();
      break;
    }
  }
  return s.replace(/\s+/g, " ");
}

function departmentForCategory(catKey: string): string {
  if (catKey.startsWith("womens_")) return "Women";
  if (catKey.startsWith("mens_")) return "Men";
  return "Unisex Adult";
}

// eBay's canonical "no brand" value is "Unbranded". The model (and sellers typing
// into the Brand field) write it many ways — "No Brand", "None", "N/A", "Generic",
// "Unknown" — several of which eBay rejects as an invalid Brand value on submit.
// Fold all of them to "Unbranded"; leave a real brand untouched, and "" as "".
const NO_BRAND_RE =
  /^(unbranded|no[\s-]*brand(\s*name)?|no\s+visible\s+brand|brand\s*(unknown|less)|none|n\/?a|not\s+applicable|does\s+not\s+apply|generic|unknown|unmarked|no\s+label)$/i;

export function normalizeBrand(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  return NO_BRAND_RE.test(s) ? "Unbranded" : s;
}

// Build the item-specifics (aspects) map from the listing.
function buildAspects(listing: ListingResult, catKey: string): Record<string, string[]> {
  const aspects: Record<string, string[]> = {};
  const put = (k: string, v: string) => {
    const val = clipAspectValue(v);
    if (val) aspects[k] = [val];
  };

  put("Brand", normalizeBrand(listing.brand));
  put("Size", cleanSize(listing.size));
  put("Color", singleValue(listing.color));
  put("Material", singleValue(listing.material));
  put("Type", String(listing.item_type || "").trim());

  const feats = Array.isArray(listing.key_features) ? listing.key_features : [];
  const cleanFeats = feats.map((f) => clipAspectValue(String(f))).filter(Boolean).slice(0, 5);
  if (cleanFeats.length) aspects.Features = cleanFeats;

  if (APPAREL_CATEGORIES.has(catKey) || catKey === "accessory") {
    aspects.Department = [departmentForCategory(catKey)];
  }

  if (PANTS_CATEGORIES.has(catKey)) {
    const m = String(listing.measurements || "").trim();
    if (m && m.toLowerCase() !== "see listing photos for measurements") {
      aspects.Inseam = [m.slice(0, 30)];
    }
  }

  // Merge in the model-provided item specifics (skip blanks + section labels).
  for (const [k, v] of Object.entries(listing.item_specifics || {})) {
    if (!k || k.startsWith("---")) continue;
    const val = clipAspectValue(singleValue(v));
    if (val && !aspects[k]) aspects[k] = [val];
  }
  return aspects;
}

// ── Required-aspect reconciliation (driven by eBay's Taxonomy data) ──────────
//
// The static defaults above can't know what each leaf category requires, nor
// which values its SELECTION_ONLY aspects accept. We ask eBay for both and make
// every required aspect valid before publishing — eliminating the 25002 errors.

// Match a value against eBay's allowed list, case-insensitively and tolerating
// singular/plural (so "Unisex Adult" resolves to the valid "Unisex Adults").
// Returns the canonical allowed value, or null if there's no match.
function matchAllowed(value: string, allowed: string[]): string | null {
  const ls = (value || "").trim().toLowerCase();
  if (!ls) return null;
  for (const v of allowed) {
    const lv = v.toLowerCase();
    if (lv === ls || lv === `${ls}s` || `${lv}s` === ls) return v;
  }
  return null;
}

// Choose a valid Department from the category's own allowed values, biased by
// the item's gender cues. Kids categories only allow Boys/Girls/Unisex Kids, so
// a blind "Unisex Adults" default would still fail — we match against the list.
function pickDepartment(allowed: string[], listing: ListingResult, catKey: string): string {
  const text = `${catKey} ${listing.title || ""} ${listing.item_type || ""} ${
    listing.item_specifics?.Department || ""
  }`.toLowerCase();
  const women = catKey.startsWith("womens_") || /\b(women|woman|ladies|female|girl)\b/.test(text);
  const men = catKey.startsWith("mens_") || /\b(men|man|male|boy)\b/.test(text);
  const pref = women
    ? ["Women", "Women's", "Girls", "Unisex Adults", "Unisex Kids", "Unisex"]
    : men
      ? ["Men", "Men's", "Boys", "Unisex Adults", "Unisex Kids", "Unisex"]
      : ["Unisex Adults", "Unisex Kids", "Unisex", "Women", "Men"];
  for (const p of pref) {
    const m = matchAllowed(p, allowed);
    if (m) return m;
  }
  return allowed[0] || "";
}

// eBay's canonical "this attribute doesn't apply" sentinel. It's the right
// default for Model/MPN on generic second-hand goods: "Unbranded" is only a valid
// Brand value — Model/MPN reject it and 25002-fail ("Model is missing, enter a
// valid value"), whereas "Does Not Apply" is accepted.
const DOES_NOT_APPLY = "Does Not Apply";

// Model-type aspects (Model, MPN, Manufacturer Part Number) that should fall back
// to "Does Not Apply" rather than a brand-style default when the listing has none.
function isModelAspect(name: string): boolean {
  const n = (name || "").toLowerCase();
  return n.includes("model") || n === "mpn" || n.includes("manufacturer part");
}

// Best free-text fill for a required aspect we don't already have, drawn from
// the listing itself. eBay accepts any string for FREE_TEXT aspects.
function freeTextDefault(name: string, listing: ListingResult): string {
  const n = name.toLowerCase();
  if (n.includes("brand")) return normalizeBrand(listing.brand) || "Unbranded";
  if (isModelAspect(name)) return DOES_NOT_APPLY;
  if (n.includes("color")) return singleValue(listing.color) || "Multicolor";
  if (n.includes("shoe size") || n === "size") return cleanSize(listing.size);
  if (n.includes("material")) return singleValue(listing.material) || "Man Made";
  if (n.includes("style")) return String(listing.item_specifics?.Style || listing.item_type || "").trim();
  if (n.includes("type")) return String(listing.item_type || "").trim();
  return "";
}

// Make every REQUIRED aspect present and valid. Mutates `aspects` in place.
function reconcileAspects(
  aspects: Record<string, string[]>,
  meta: AspectMeta[],
  listing: ListingResult,
  catKey: string
): void {
  for (const a of meta) {
    if (!a.required || !a.name) continue;
    const current = aspects[a.name]?.[0];

    if (a.mode === "SELECTION_ONLY") {
      // Must be one of eBay's allowed values, or the publish 25002-fails.
      // Size aspects never fall back to a guessed value — a wrong size
      // mislabels the item and trips eBay's standardization enforcement.
      const canonical =
        matchAllowed(current || "", a.values) ||
        (isSizeAspect(a.name)
          ? ""
          : matchAllowed(ASPECT_DEFAULTS[a.name] || "", a.values) ||
            (a.name === "Department" ? pickDepartment(a.values, listing, catKey) : "") ||
            a.values[0] ||
            "");
      if (canonical) aspects[a.name] = [canonical];
      else if (isSizeAspect(a.name)) delete aspects[a.name];
    } else if (!current) {
      // FREE_TEXT and unset — fill from the listing or a sensible default.
      const fromListing = freeTextDefault(a.name, listing);
      const v =
        fromListing ||
        (isSizeAspect(a.name) ? "" : ASPECT_DEFAULTS[a.name] || a.values[0] || "");
      const clipped = clipAspectValue(v);
      if (clipped) aspects[a.name] = [clipped];
    }
  }
}

// ── eBay error parsing (from the script) ─────────────────────────────────────

export function errorIds(r: EbayResp): number[] {
  try {
    return (r.json?.errors || []).map((e: any) => Number(e.errorId || 0));
  } catch {
    return [];
  }
}

// eBay's Inventory API intermittently fails with 25001 ("A system error has
// occurred. Core Inventory Service internal error") or a bare 5xx. These are
// eBay-side blips that normally succeed on retry (issue #16), so every write
// call gets a short backoff-and-retry before we surface the failure.
const TRANSIENT_RETRIES = 2;
const TRANSIENT_BASE_DELAY_MS = 1500;

function isTransientEbayError(r: EbayResp): boolean {
  return r.status >= 500 || errorIds(r).includes(25001);
}

export async function withTransientRetry(
  call: () => Promise<EbayResp>,
  label: string,
  sku: string
): Promise<EbayResp> {
  let r = await call();
  for (let attempt = 1; attempt <= TRANSIENT_RETRIES && isTransientEbayError(r); attempt++) {
    console.warn(
      `[ebay/publish] sku=${sku} ${label} hit transient eBay error ` +
        `(status=${r.status} ids=${errorIds(r).join(",") || "none"}) — retry ${attempt}/${TRANSIENT_RETRIES}`
    );
    await new Promise((res) => setTimeout(res, TRANSIENT_BASE_DELAY_MS * 2 ** (attempt - 1)));
    r = await call();
  }
  return r;
}

// Extra guidance for eBay errors that a seller can act on directly. Keyed by
// errorId; appended to the raw eBay message when surfaced in the UI.
const EBAY_ERROR_HINTS: Record<number, string> = {
  25001:
    "This is a temporary glitch on eBay's side (we already retried automatically). Wait a minute and hit Post again — the listing data itself is fine.",
  25019:
    "eBay rejected the listing's content — usually a restricted or trademarked word in the title/description, or the item is already listed. Edit the title/description and try again.",
};

// Pull eBay's primary error (id + human message) from a failed response, so we
// can log it and show it cleanly instead of dumping raw JSON at the user.
export function primaryEbayError(r: EbayResp): { errorId: number; message: string } {
  const err = r.json?.errors?.[0];
  if (err) {
    return {
      errorId: Number(err.errorId || 0),
      message: String(err.longMessage || err.message || "").trim(),
    };
  }
  return { errorId: 0, message: (r.text || "").slice(0, 300) };
}

// One structured log line per publish failure, so the server logs actually show
// what eBay rejected. Without this the whole path logged nothing, which is why
// failed requests showed "No logs found for this request".
export function logPublishFailure(stage: string, sku: string, r: EbayResp): void {
  const { errorId, message } = primaryEbayError(r);
  console.error(
    `[ebay/publish] ${stage} failed sku=${sku} http=${r.status} errorId=${errorId || "?"} ${message}`
  );
}

// User-facing one-liner: eBay's own reason, tagged with its errorId, plus an
// actionable hint when we have one.
function publishErrorMessage(stage: string, r: EbayResp): string {
  const { errorId, message } = primaryEbayError(r);
  const detail = message || `HTTP ${r.status}`;
  const head = errorId ? `${stage} (eBay error ${errorId}): ${detail}` : `${stage} (${r.status}): ${detail}`;
  const hint = errorId ? EBAY_ERROR_HINTS[errorId] : undefined;
  return hint ? `${head} ${hint}` : head;
}

function extractExistingOfferId(r: EbayResp): string | null {
  for (const err of r.json?.errors || []) {
    if (err.errorId === 25002) {
      for (const p of err.parameters || []) {
        if (p.name === "offerId") return String(p.value);
      }
    }
  }
  return null;
}

function extractMissingAspects(r: EbayResp): string[] {
  const missing: string[] = [];
  for (const err of r.json?.errors || []) {
    const pieces = [err.message, err.longMessage].concat(
      (err.parameters || []).map((p: any) => String(p.value || ""))
    );
    const hay = pieces.join(" | ");
    const re = /item specific ([^|.,;]+?) is missing/gi;
    let m;
    while ((m = re.exec(hay))) {
      const name = m[1].trim();
      if (name) missing.push(name);
    }
  }
  return missing;
}

// Pick a value eBay will actually accept for a required aspect we can't fill from
// the listing. For SELECTION_ONLY aspects this MUST come from eBay's own allowed
// list — a free-text sentinel like "Does Not Apply"/"Unbranded" 25002-fails as an
// invalid value (this is why "Connectivity is missing" kept recurring). We prefer
// a "does not apply"/"none"/"other"-style option when the category offers one.
function defaultForMissingAspect(
  field: string,
  listing: ListingResult,
  meta: AspectMeta[]
): string {
  const m = meta.find((a) => a.name.toLowerCase() === field.toLowerCase());
  if (m && m.mode === "SELECTION_ONLY" && m.values.length) {
    const pref = m.values.find((v) =>
      /does not apply|not applicable|\bn\/?a\b|\bnone\b|\bother\b|unbranded/i.test(v)
    );
    return pref || m.values[0];
  }
  // FREE_TEXT (or unknown category metadata): eBay accepts any string, so use a
  // listing-derived value if we have one, else a sensible sentinel — "Unbranded"
  // reads right only for Brand; everything else gets "Does Not Apply".
  const fromListing = freeTextDefault(field, listing);
  if (fromListing) return fromListing;
  if (ASPECT_DEFAULTS[field]) return ASPECT_DEFAULTS[field];
  return field.toLowerCase().includes("brand") ? "Unbranded" : DOES_NOT_APPLY;
}

function addMissingAspects(
  aspects: Record<string, string[]>,
  missing: string[],
  listing: ListingResult,
  meta: AspectMeta[]
): string[] {
  const added: string[] = [];
  for (const field of missing) {
    // Never stamp a default into a size aspect — let eBay's "missing item
    // specific" error surface so the seller supplies the real size.
    if (isSizeAspect(field)) continue;
    // If we already stamped this one and eBay still reports it missing, our value
    // was rejected as invalid — don't re-stamp the same thing and loop forever.
    if (aspects[field]?.length) continue;
    const def = defaultForMissingAspect(field, listing, meta);
    if (!def) continue;
    aspects[field] = [def];
    added.push(`${field}=${def}`);
  }
  return added;
}

// Resolve a cascade of missing/invalid required aspects. eBay often reports them
// one at a time, so we loop (bounded): stamp valid values, rewrite the inventory
// item via `reattempt`, and repeat until the call succeeds or we stop making
// progress. `reattempt` re-runs whatever failed (the PUT, or a PUT + offer/publish).
async function recoverMissingAspects(
  r: EbayResp,
  ctx: {
    aspects: Record<string, string[]>;
    listing: ListingResult;
    meta: AspectMeta[];
    inventoryItem: any;
    reattempt: () => Promise<EbayResp>;
    ok: (resp: EbayResp) => boolean;
  }
): Promise<EbayResp> {
  for (let round = 0; round < 6 && !ctx.ok(r); round++) {
    const missing = extractMissingAspects(r);
    if (!missing.length) break;
    if (!addMissingAspects(ctx.aspects, missing, ctx.listing, ctx.meta).length) break;
    ctx.inventoryItem.product.aspects = ctx.aspects;
    r = await ctx.reattempt();
  }
  return r;
}

function updateOfferBody(offer: Record<string, unknown>): Record<string, unknown> {
  const skip = new Set(["sku", "marketplaceId", "format"]);
  return Object.fromEntries(Object.entries(offer).filter(([k]) => !skip.has(k)));
}

// ── Photo upload to eBay Picture Services (Trading API, XML) ──────────────────

async function uploadPhoto(
  accessToken: string,
  base64: string,
  mediaType: string,
  name: string
): Promise<string | null> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <PictureName>${name.slice(0, 50)}</PictureName>
  <PictureUploadPolicy>ClearAndNew</PictureUploadPolicy>
</UploadSiteHostedPicturesRequest>`;

  const data = base64.includes(",") ? base64.split(",")[1] : base64;
  const bytes = Buffer.from(data, "base64");
  const form = new FormData();
  form.append("XML Payload", new Blob([xml], { type: "text/xml;charset=utf-8" }), "payload.xml");
  form.append("image", new Blob([new Uint8Array(bytes)], { type: mediaType }), name);

  const resp = await fetch(EBAY_TRADING, {
    method: "POST",
    headers: {
      "X-EBAY-API-SITEID": EBAY_SITE_ID,
      "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
      "X-EBAY-API-CALL-NAME": "UploadSiteHostedPictures",
      "X-EBAY-API-IAF-TOKEN": accessToken,
    },
    body: form,
  });
  const text = await resp.text();
  const m = text.match(/<FullURL>([^<]+)<\/FullURL>/);
  return m ? m[1] : null;
}

// ── Policies & location ──────────────────────────────────────────────────────

export interface AccountSetup {
  fulfillmentPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
  locationKey: string;
}

function pickFirstPolicy(r: EbayResp, listKey: string, idField: string): string {
  if (!r.ok) return "";
  const list = r.json?.[listKey] || [];
  return list.length ? String(list[0][idField] || "") : "";
}

// Business policies + inventory location are account-stable — they don't change
// between listings — yet every publish used to re-fetch them (~4-5 eBay API
// calls). Cache the fully-resolved setup per connection for a short window so a
// batch of posts hits these endpoints once, not once per item. Keyed by a
// caller-supplied connection id (see the /ebay/publish route) so IDs can never
// leak across sellers; cleared on disconnect via clearAccountSetupCache().
const ACCOUNT_SETUP_TTL_MS = 10 * 60 * 1000;
const accountSetupCache = new Map<string, { value: AccountSetup; expiresAt: number }>();

export function clearAccountSetupCache(): void {
  accountSetupCache.clear();
}

export async function fetchAccountSetup(
  accessToken: string,
  connKey: string
): Promise<AccountSetup> {
  const now = Date.now();
  const cached = accountSetupCache.get(connKey);
  if (cached && cached.expiresAt > now) return cached.value;

  const mp = `marketplace_id=${EBAY_MARKETPLACE_ID}`;
  const [ful, pay, ret] = await Promise.all([
    ebayRequest(accessToken, "GET", `${EBAY_ACC_BASE}/fulfillment_policy?${mp}`),
    ebayRequest(accessToken, "GET", `${EBAY_ACC_BASE}/payment_policy?${mp}`),
    ebayRequest(accessToken, "GET", `${EBAY_ACC_BASE}/return_policy?${mp}`),
  ]);
  const setup: AccountSetup = {
    fulfillmentPolicyId: pickFirstPolicy(ful, "fulfillmentPolicies", "fulfillmentPolicyId"),
    paymentPolicyId: pickFirstPolicy(pay, "paymentPolicies", "paymentPolicyId"),
    returnPolicyId: pickFirstPolicy(ret, "returnPolicies", "returnPolicyId"),
    locationKey: await fetchOrCreateLocation(accessToken),
  };

  // Only cache a fully-resolved setup. A missing policy becomes a friendly
  // "set up your business policies" error in publishListing — don't cache that,
  // so the next publish after the seller fixes their account picks it up at once.
  if (
    setup.fulfillmentPolicyId &&
    setup.paymentPolicyId &&
    setup.returnPolicyId &&
    setup.locationKey
  ) {
    accountSetupCache.set(connKey, { value: setup, expiresAt: now + ACCOUNT_SETUP_TTL_MS });
  }
  return setup;
}

async function fetchOrCreateLocation(accessToken: string): Promise<string> {
  const list = await ebayRequest(accessToken, "GET", `${EBAY_INV_BASE}/location`);
  if (list.ok) {
    for (const loc of list.json?.locations || []) {
      if (loc.merchantLocationStatus === "ENABLED" && loc.merchantLocationKey) {
        return loc.merchantLocationKey;
      }
    }
  }
  const key = "HOME_OFFICE";
  const payload = {
    name: "Home Office",
    merchantLocationStatus: "ENABLED",
    locationTypes: ["WAREHOUSE"],
    location: {
      address: {
        // Set EBAY_LOCATION_POSTAL_CODE to your own postcode. Only used the
        // first time, to create an inventory location if you don't already have
        // one. EBAY_LOCATION_COUNTRY defaults to GB (the UK marketplace).
        postalCode: process.env.EBAY_LOCATION_POSTAL_CODE || "EC1A 1BB",
        country: EBAY_LOCATION_COUNTRY,
      },
    },
  };
  await ebayRequest(accessToken, "POST", `${EBAY_INV_BASE}/location/${key}`, {
    body: payload,
    extraHeaders: { "Content-Language": EBAY_LOCALE },
  });
  return key;
}

// Find the offer for a SKU regardless of status — used by the "refresh
// stagnant listing" flow, which needs to find and re-publish an offer that's
// currently UNPUBLISHED (just withdrawn, or left over from an interrupted
// earlier refresh attempt), not only a live PUBLISHED one.
export async function findOfferBySku(
  accessToken: string,
  sku: string
): Promise<{ offerId: string; listingId: string; status: string } | null> {
  const r = await ebayRequest(
    accessToken,
    "GET",
    `${EBAY_INV_BASE}/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${EBAY_MARKETPLACE_ID}`
  );
  if (!r.ok) return null; // 404 = no offers for this SKU
  const offers = r.json?.offers ?? [];
  if (!offers.length) return null;
  // Prefer a PUBLISHED offer if one exists; otherwise take the first (a SKU
  // only ever has one offer per marketplace in this app's publish flow).
  const o = offers.find((x: any) => String(x?.status || "").toUpperCase() === "PUBLISHED") ?? offers[0];
  return {
    offerId: String(o.offerId || ""),
    listingId: String(o?.listing?.listingId || ""),
    status: String(o?.status || "").toUpperCase(),
  };
}

// ── The full publish flow for one item ───────────────────────────────────────

export interface PublishInput {
  sku: string;
  listing: ListingResult;
  images: { mediaType: string; data: string }[];
}

export interface PublishResult {
  success: boolean;
  sku: string;
  listingId?: string;
  offerId?: string;
  error?: string;
}

const CL = { "Content-Language": EBAY_LOCALE };

export async function publishListing(
  accessToken: string,
  setup: AccountSetup,
  input: PublishInput
): Promise<PublishResult> {
  const { sku, listing } = input;
  const catKey = String(listing.category || "other");
  const { categoryId: staticCat, fallbacks } = resolveCategory(listing);
  // Ask eBay for the real LEAF category from the title + hint; fall back to the
  // static map only if Taxonomy is unavailable. (Fixes 25005 non-leaf errors.)
  const leaf = await suggestLeafCategory(`${listing.category_hint || ""} ${listing.title || ""}`);
  let catId = leaf || staticCat;

  if (!setup.fulfillmentPolicyId || !setup.paymentPolicyId || !setup.returnPolicyId) {
    return {
      success: false,
      sku,
      error:
        "Your eBay account is missing a business policy (payment, shipping, or returns). Set these up in eBay → Account → Business policies, then try again.",
    };
  }

  // 1. Upload photos → EPS URLs. Run a few in parallel (order-preserving, so the
  // first photo stays the gallery thumbnail). eBay caps a listing at 12 images.
  const uploaded = await mapLimit(input.images.slice(0, 12), 4, (img) =>
    uploadPhoto(accessToken, img.data, img.mediaType, `${sku}.jpg`)
  );
  const photoUrls = uploaded.filter((u): u is string => Boolean(u));
  if (photoUrls.length === 0) {
    return { success: false, sku, error: "Could not upload any photos to eBay." };
  }

  // 2. Inventory item.
  const aspects = buildAspects(listing, catKey);
  // Ask eBay (in parallel) for the leaf category's REQUIRED specifics and its
  // accepted condition ids, then make both valid before creating the item.
  // Settle independently: a failure fetching condition ids must NOT skip aspect
  // reconciliation (that's how required aspects like Connectivity slipped through
  // and 25002-failed at publish). Non-fatal — the recovery loops below back it up.
  let aspectMeta: AspectMeta[] = [];
  let acceptedConds = new Set<number>();
  const [metaRes, condsRes] = await Promise.allSettled([
    categoryAspects(catId), // required aspects + valid values  → fixes 25002
    acceptedConditionIds(catId), // accepted condition ids       → fixes 25021
  ]);
  if (metaRes.status === "fulfilled") aspectMeta = metaRes.value;
  if (condsRes.status === "fulfilled") acceptedConds = condsRes.value;
  if (aspectMeta.length) reconcileAspects(aspects, aspectMeta, listing, catKey);
  const condCandidates = conditionCandidates(listing.condition, acceptedConds);
  const condition = condCandidates[0] || "USED_EXCELLENT";
  const inventoryItem: any = {
    product: {
      title: String(listing.title || "Untitled").slice(0, 80),
      description: listing.description || "",
      aspects,
      imageUrls: photoUrls.slice(0, 12),
    },
    condition,
    conditionDescription: listing.condition_notes || "",
    availability: { shipToLocationAvailability: { quantity: 1 } },
    // Default weight/size so CALCULATED-shipping policies publish (eBay 25020).
    packageWeightAndSize: defaultPackageWeightAndSize(),
  };

  const putInventory = () =>
    withTransientRetry(
      () =>
        ebayRequest(accessToken, "PUT", `${EBAY_INV_BASE}/inventory_item/${sku}`, {
          body: inventoryItem,
          extraHeaders: CL,
        }),
      "inventory item",
      sku
    );

  let r = await putInventory();
  if (![200, 201, 204].includes(r.status)) {
    r = await recoverMissingAspects(r, {
      aspects,
      listing,
      meta: aspectMeta,
      inventoryItem,
      reattempt: putInventory,
      ok: (x) => [200, 201, 204].includes(x.status),
    });
    // Recovery: condition invalid for this category (25021/25059) → step down
    // to a grade the category accepts.
    if (
      ![200, 201, 204].includes(r.status) &&
      (errorIds(r).includes(25021) || errorIds(r).includes(25059))
    ) {
      for (const alt of condCandidates) {
        if (alt === inventoryItem.condition) continue;
        // Loud on purpose: a silent step-down is how "Excellent" items ended
        // up displaying as "Pre-owned – Good" with no trace in the logs.
        console.warn(
          `[ebay/publish] sku=${sku} condition ${inventoryItem.condition} rejected by category ${catId} — trying ${alt}`
        );
        inventoryItem.condition = alt;
        r = await putInventory();
        if ([200, 201, 204].includes(r.status)) break;
        if (!errorIds(r).includes(25021) && !errorIds(r).includes(25059)) break;
      }
    }
    if (![200, 201, 204].includes(r.status)) {
      logPublishFailure("inventory item", sku, r);
      return { success: false, sku, error: publishErrorMessage("Inventory item failed", r) };
    }
  }

  // 3. Offer.
  const price = computeOfferPrice(listing.suggested_price);
  const offerBody: any = {
    sku,
    marketplaceId: EBAY_MARKETPLACE_ID,
    format: "FIXED_PRICE",
    listingDescription: listing.description || "",
    pricingSummary: { price: { value: String(price), currency: EBAY_CURRENCY } },
    quantityLimitPerBuyer: 1,
    categoryId: catId,
    merchantLocationKey: setup.locationKey,
    listingPolicies: {
      fulfillmentPolicyId: setup.fulfillmentPolicyId,
      paymentPolicyId: setup.paymentPolicyId,
      returnPolicyId: setup.returnPolicyId,
    },
    includeCatalogProductDetails: false,
  };

  const postOffer = () =>
    withTransientRetry(
      () =>
        ebayRequest(accessToken, "POST", `${EBAY_INV_BASE}/offer`, {
          body: offerBody,
          extraHeaders: CL,
        }),
      "offer creation",
      sku
    );

  r = await postOffer();

  // Recovery: missing aspects during offer create.
  if (![200, 201].includes(r.status) && extractMissingAspects(r).length) {
    r = await recoverMissingAspects(r, {
      aspects,
      listing,
      meta: aspectMeta,
      inventoryItem,
      reattempt: async () => {
        await putInventory();
        return postOffer();
      },
      ok: (x) => [200, 201].includes(x.status),
    });
  }
  // Recovery: non-leaf category (25005).
  if (![200, 201].includes(r.status) && errorIds(r).includes(25005)) {
    for (const fb of fallbacks) {
      offerBody.categoryId = fb;
      const fbResp = await postOffer();
      if ([200, 201].includes(fbResp.status) || extractExistingOfferId(fbResp)) {
        r = fbResp;
        catId = fb;
        break;
      }
    }
  }

  let offerId: string;
  if (r.status === 400) {
    const existing = extractExistingOfferId(r);
    if (!existing) {
      logPublishFailure("offer creation", sku, r);
      return { success: false, sku, error: publishErrorMessage("Offer creation failed", r) };
    }
    // Update the pre-existing offer instead.
    const putOfferUpdate = () =>
      withTransientRetry(
        () =>
          ebayRequest(accessToken, "PUT", `${EBAY_INV_BASE}/offer/${existing}`, {
            body: updateOfferBody(offerBody),
            extraHeaders: CL,
          }),
        "offer update",
        sku
      );
    let upd = await putOfferUpdate();
    // eBay validates the inventory item's aspects on offer update too, so a
    // required specific (e.g. Item Height) can surface here — run the same
    // missing-aspect recovery the create/publish paths use.
    if (![200, 201, 204].includes(upd.status) && extractMissingAspects(upd).length) {
      upd = await recoverMissingAspects(upd, {
        aspects,
        listing,
        meta: aspectMeta,
        inventoryItem,
        reattempt: async () => {
          await putInventory();
          return putOfferUpdate();
        },
        ok: (x) => [200, 201, 204].includes(x.status),
      });
    }
    if (![200, 201, 204].includes(upd.status)) {
      logPublishFailure("offer update", sku, upd);
      return { success: false, sku, error: publishErrorMessage("Offer update failed", upd) };
    }
    offerId = existing;
  } else if (![200, 201].includes(r.status)) {
    logPublishFailure("offer creation", sku, r);
    return { success: false, sku, error: publishErrorMessage("Offer creation failed", r) };
  } else {
    offerId = r.json?.offerId || "";
  }

  // 4. Publish, with recovery.
  return publishOfferWithRecovery(accessToken, {
    sku,
    offerId,
    catId,
    catKey,
    listing,
    aspects,
    aspectMeta,
    inventoryItem,
    offerBody,
    fallbacks,
    condCandidates,
  });
}

async function publishOfferWithRecovery(
  accessToken: string,
  ctx: {
    sku: string;
    offerId: string;
    catId: string;
    catKey: string;
    listing: ListingResult;
    aspects: Record<string, string[]>;
    aspectMeta: AspectMeta[];
    inventoryItem: any;
    offerBody: any;
    fallbacks: string[];
    condCandidates: string[];
  }
): Promise<PublishResult> {
  const { sku, offerId } = ctx;
  const doPublish = () =>
    withTransientRetry(
      () =>
        ebayRequest(accessToken, "POST", `${EBAY_INV_BASE}/offer/${offerId}/publish`, {
          extraHeaders: CL,
        }),
      "publish",
      sku
    );
  const putInventory = () =>
    withTransientRetry(
      () =>
        ebayRequest(accessToken, "PUT", `${EBAY_INV_BASE}/inventory_item/${sku}`, {
          body: ctx.inventoryItem,
          extraHeaders: CL,
        }),
      "inventory item",
      sku
    );

  let r = await doPublish();
  if (r.ok) return { success: true, sku, offerId, listingId: r.json?.listingId || "" };

  let eids = errorIds(r);

  // Recovery: missing item specifics.
  if (extractMissingAspects(r).length) {
    r = await recoverMissingAspects(r, {
      aspects: ctx.aspects,
      listing: ctx.listing,
      meta: ctx.aspectMeta,
      inventoryItem: ctx.inventoryItem,
      reattempt: async () => {
        await putInventory();
        return doPublish();
      },
      ok: (x) => x.ok,
    });
    if (r.ok) return { success: true, sku, offerId, listingId: r.json?.listingId || "" };
    eids = errorIds(r);
  }

  // Recovery: invalid condition (25059/25021) → step through the remaining
  // candidate grades until one publishes.
  if (eids.includes(25059) || eids.includes(25021)) {
    for (const alt of ctx.condCandidates) {
      if (alt === ctx.inventoryItem.condition) continue;
      console.warn(
        `[ebay/publish] sku=${sku} condition ${ctx.inventoryItem.condition} rejected at publish (category ${ctx.catId}) — trying ${alt}`
      );
      ctx.inventoryItem.condition = alt;
      await putInventory();
      r = await doPublish();
      if (r.ok) return { success: true, sku, offerId, listingId: r.json?.listingId || "" };
      eids = errorIds(r);
      if (!eids.includes(25021) && !eids.includes(25059)) break;
    }
  }

  // Recovery: non-leaf category (25005) → try fallbacks via offer update.
  if (eids.includes(25005)) {
    for (const fb of ctx.fallbacks) {
      const upd = await ebayRequest(accessToken, "PUT", `${EBAY_INV_BASE}/offer/${offerId}`, {
        body: { ...updateOfferBody(ctx.offerBody), categoryId: fb },
        extraHeaders: CL,
      });
      if ([200, 201, 204].includes(upd.status)) {
        r = await doPublish();
        if (r.ok) return { success: true, sku, offerId, listingId: r.json?.listingId || "" };
      }
    }
  }

  logPublishFailure("publish", sku, r);
  return {
    success: false,
    sku,
    offerId,
    error: publishErrorMessage("Publish failed", r),
  };
}
