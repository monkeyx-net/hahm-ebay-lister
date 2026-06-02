// eBay publish pipeline, ported from ebay_lister_v2_robust.py.
// Sequence: upload photos → create inventory item → create offer → publish,
// with recovery for missing item specifics, rejected conditions, and non-leaf
// categories.

import {
  EBAY_ACC_BASE,
  EBAY_INV_BASE,
  EBAY_MARKETPLACE_ID,
  EBAY_TRADING,
} from "./config";
import type { ListingResult } from "@/lib/types";

// ── Constants (from the Python script) ───────────────────────────────────────

const CATEGORY_MAP: Record<string, string> = {
  womens_top: "15724", womens_dress: "63861", womens_skirt: "11554",
  womens_pants: "57988", womens_coat: "57990", womens_sweater: "63864",
  womens_jeans: "11554", womens_clothing: "15724", womens_shoes: "3034",
  mens_top: "57991", mens_pants: "57989", mens_coat: "57988",
  mens_sweater: "11484", mens_jeans: "11483", mens_clothing: "1059",
  mens_shoes: "93427", handbag: "169291", wallet: "2996", jewelry: "281",
  scarf: "45238", belt: "2996", sunglasses: "79720", hat: "52382",
  accessory: "4250", doll: "22733", collectible: "1463", collector_plate: "1467",
  toy: "2550", home_decor: "10033", book: "267", knife: "7313",
  sporting_goods: "159044", electronics: "293", camera: "625", audio: "293",
  video_game: "139973", media: "11232", vinyl_record: "176985", cd: "176984",
  dvd_bluray: "617", musical_instrument: "619", kitchenware: "20625",
  glassware: "50693", pottery_ceramics: "24", art: "550", craft: "14339",
  tool: "631", automotive: "6028", office: "25298", health_beauty: "26395",
  small_appliance: "20667", lighting: "20697", linens: "20444", holiday: "16086",
  board_game: "233", puzzle: "2613", plush: "2624", action_figure: "246",
  trading_card: "183050", sports_memorabilia: "64482", coin: "11116",
  stamp: "260", ephemera: "165800", other: "99",
};

const LEAF_FALLBACKS = ["1463", "22733", "2550", "48108", "316", "171485", "2624", "2613"];

const GENERAL_CONDITION_MAP: Record<string, string> = {
  NEW_WITH_TAGS: "NEW", NEW_NO_TAGS: "NEW_OTHER", EXCELLENT: "USED_EXCELLENT",
  VERY_GOOD: "USED_VERY_GOOD", GOOD: "USED_GOOD", ACCEPTABLE: "USED_ACCEPTABLE",
};

const APPAREL_CONDITION_MAP: Record<string, string> = {
  NEW_WITH_TAGS: "NEW", NEW_NO_TAGS: "NEW_OTHER", LIKE_NEW: "PRE_OWNED_EXCELLENT",
  EXCELLENT: "PRE_OWNED_EXCELLENT", VERY_GOOD: "USED_EXCELLENT",
  GOOD: "USED_EXCELLENT", ACCEPTABLE: "PRE_OWNED_FAIR",
};

const APPAREL_CATEGORIES = new Set([
  "womens_top", "womens_dress", "womens_skirt", "womens_pants", "womens_coat",
  "womens_sweater", "womens_jeans", "womens_clothing", "womens_shoes", "mens_top",
  "mens_pants", "mens_coat", "mens_sweater", "mens_jeans", "mens_clothing",
  "mens_shoes", "scarf", "belt", "hat",
]);
const HANDBAG_CATEGORIES = new Set(["handbag", "wallet"]);
const PANTS_CATEGORIES = new Set([
  "womens_pants", "womens_jeans", "womens_skirt", "mens_pants", "mens_jeans",
]);

const ASPECT_DEFAULTS: Record<string, string> = {
  "Skirt Length": "Knee-Length", "Dress Length": "Knee-Length", Rise: "Mid Rise",
  "Leg Style": "Straight", Closure: "Pull-On", "Shoe Width": "Medium",
  "Heel Height": "Flat", "Toe Shape": "Round", Adjustable: "Yes",
  "Exterior Pockets": "Yes", Lining: "Lined", Hood: "No Hood", "Bag Closure": "Zip",
  "Strap Type": "Adjustable", "Hat Style": "Baseball Cap", "Brim Style": "Curved Bill",
  "Size Type": "Regular", Size: "Regular", Style: "Casual", Department: "Unisex Adult",
  Type: "Item", Brand: "Unbranded", Color: "Multicolor", Material: "Mixed Materials",
};

// ── eBay REST client (token-authed) ──────────────────────────────────────────

interface EbayResp {
  ok: boolean;
  status: number;
  json: any;
  text: string;
}

async function ebayRequest(
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

function computeBufferedPrice(raw: number | string | undefined): number {
  let base = typeof raw === "string" ? parseFloat(raw) : raw ?? 0;
  if (!base || Number.isNaN(base) || base <= 0) base = 29.99;
  const buffered = Math.max(base * 1.18, base + 5);
  return Math.round(buffered * 100) / 100;
}

function normalizeConditionInput(value: string | undefined): string {
  const cleaned = (value || "GOOD").trim().toUpperCase().replace(/[ -]/g, "_");
  if (cleaned === "LIKE_NEW") return "EXCELLENT";
  return cleaned in GENERAL_CONDITION_MAP ? cleaned : "GOOD";
}

function pickCondition(catKey: string, condRaw: string | undefined): string {
  const desired = normalizeConditionInput(condRaw);
  if (APPAREL_CATEGORIES.has(catKey) || HANDBAG_CATEGORIES.has(catKey)) {
    return APPAREL_CONDITION_MAP[desired] || "USED_EXCELLENT";
  }
  return GENERAL_CONDITION_MAP[desired] || "USED_GOOD";
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

// Build the item-specifics (aspects) map from the listing.
function buildAspects(listing: ListingResult, catKey: string): Record<string, string[]> {
  const aspects: Record<string, string[]> = {};
  const put = (k: string, v: string) => {
    const val = (v || "").trim();
    if (val) aspects[k] = [val.slice(0, 65)];
  };

  put("Brand", String(listing.brand || "").trim());
  put("Size", String(listing.size || "").trim());
  put("Color", singleValue(listing.color));
  put("Material", singleValue(listing.material));
  put("Type", String(listing.item_type || "").trim());

  const feats = Array.isArray(listing.key_features) ? listing.key_features : [];
  const cleanFeats = feats.map((f) => String(f).trim()).filter(Boolean).slice(0, 5);
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
    const val = singleValue(v);
    if (val && !aspects[k]) aspects[k] = [val.slice(0, 65)];
  }
  return aspects;
}

// ── eBay error parsing (from the script) ─────────────────────────────────────

function errorIds(r: EbayResp): number[] {
  try {
    return (r.json?.errors || []).map((e: any) => Number(e.errorId || 0));
  } catch {
    return [];
  }
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

function addMissingAspects(
  aspects: Record<string, string[]>,
  missing: string[]
): string[] {
  const added: string[] = [];
  for (const field of missing) {
    const def = ASPECT_DEFAULTS[field] || "Unbranded";
    aspects[field] = [def];
    added.push(`${field}=${def}`);
  }
  return added;
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
      "X-EBAY-API-SITEID": "0",
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

export async function fetchAccountSetup(accessToken: string): Promise<AccountSetup> {
  const mp = `marketplace_id=${EBAY_MARKETPLACE_ID}`;
  const [ful, pay, ret] = await Promise.all([
    ebayRequest(accessToken, "GET", `${EBAY_ACC_BASE}/fulfillment_policy?${mp}`),
    ebayRequest(accessToken, "GET", `${EBAY_ACC_BASE}/payment_policy?${mp}`),
    ebayRequest(accessToken, "GET", `${EBAY_ACC_BASE}/return_policy?${mp}`),
  ]);
  return {
    fulfillmentPolicyId: pickFirstPolicy(ful, "fulfillmentPolicies", "fulfillmentPolicyId"),
    paymentPolicyId: pickFirstPolicy(pay, "paymentPolicies", "paymentPolicyId"),
    returnPolicyId: pickFirstPolicy(ret, "returnPolicies", "returnPolicyId"),
    locationKey: await fetchOrCreateLocation(accessToken),
  };
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
    name: "Home HQ",
    merchantLocationStatus: "ENABLED",
    locationTypes: ["WAREHOUSE"],
    location: { address: { postalCode: "84095", country: "US" } },
  };
  await ebayRequest(accessToken, "POST", `${EBAY_INV_BASE}/location/${key}`, {
    body: payload,
    extraHeaders: { "Content-Language": "en-US" },
  });
  return key;
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

const CL = { "Content-Language": "en-US" };

export async function publishListing(
  accessToken: string,
  setup: AccountSetup,
  input: PublishInput
): Promise<PublishResult> {
  const { sku, listing } = input;
  const catKey = String(listing.category || "other");
  const { categoryId, fallbacks } = resolveCategory(listing);
  let catId = categoryId;

  if (!setup.fulfillmentPolicyId || !setup.paymentPolicyId || !setup.returnPolicyId) {
    return {
      success: false,
      sku,
      error:
        "Your eBay account is missing a business policy (payment, shipping, or returns). Set these up in eBay → Account → Business policies, then try again.",
    };
  }

  // 1. Upload photos → EPS URLs.
  const photoUrls: string[] = [];
  for (const img of input.images.slice(0, 12)) {
    const url = await uploadPhoto(accessToken, img.data, img.mediaType, `${sku}.jpg`);
    if (url) photoUrls.push(url);
  }
  if (photoUrls.length === 0) {
    return { success: false, sku, error: "Could not upload any photos to eBay." };
  }

  // 2. Inventory item.
  const aspects = buildAspects(listing, catKey);
  let condition = pickCondition(catKey, listing.condition);
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
  };

  const putInventory = () =>
    ebayRequest(accessToken, "PUT", `${EBAY_INV_BASE}/inventory_item/${sku}`, {
      body: inventoryItem,
      extraHeaders: CL,
    });

  let r = await putInventory();
  if (![200, 201, 204].includes(r.status)) {
    const missing = extractMissingAspects(r);
    if (missing.length && addMissingAspects(aspects, missing).length) {
      inventoryItem.product.aspects = aspects;
      r = await putInventory();
    }
    if (![200, 201, 204].includes(r.status)) {
      return { success: false, sku, error: `Inventory item failed (${r.status}): ${r.text.slice(0, 300)}` };
    }
  }

  // 3. Offer.
  const price = computeBufferedPrice(listing.suggested_price);
  const offerBody: any = {
    sku,
    marketplaceId: EBAY_MARKETPLACE_ID,
    format: "FIXED_PRICE",
    listingDescription: listing.description || "",
    pricingSummary: { price: { value: String(price), currency: "USD" } },
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
    ebayRequest(accessToken, "POST", `${EBAY_INV_BASE}/offer`, { body: offerBody, extraHeaders: CL });

  r = await postOffer();

  // Recovery: missing aspects during offer create.
  if (![200, 201].includes(r.status) && extractMissingAspects(r).length) {
    if (addMissingAspects(aspects, extractMissingAspects(r)).length) {
      inventoryItem.product.aspects = aspects;
      await putInventory();
      r = await postOffer();
    }
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
      return { success: false, sku, error: `Offer creation failed (${r.status}): ${r.text.slice(0, 300)}` };
    }
    // Update the pre-existing offer instead.
    const upd = await ebayRequest(accessToken, "PUT", `${EBAY_INV_BASE}/offer/${existing}`, {
      body: updateOfferBody(offerBody),
      extraHeaders: CL,
    });
    if (![200, 201, 204].includes(upd.status)) {
      return { success: false, sku, error: `Offer update failed (${upd.status}): ${upd.text.slice(0, 300)}` };
    }
    offerId = existing;
  } else if (![200, 201].includes(r.status)) {
    return { success: false, sku, error: `Offer creation failed (${r.status}): ${r.text.slice(0, 300)}` };
  } else {
    offerId = r.json?.offerId || "";
  }

  // 4. Publish, with recovery.
  return publishOfferWithRecovery(accessToken, {
    sku,
    offerId,
    catId,
    catKey,
    aspects,
    inventoryItem,
    offerBody,
    fallbacks,
  });
}

async function publishOfferWithRecovery(
  accessToken: string,
  ctx: {
    sku: string;
    offerId: string;
    catId: string;
    catKey: string;
    aspects: Record<string, string[]>;
    inventoryItem: any;
    offerBody: any;
    fallbacks: string[];
  }
): Promise<PublishResult> {
  const { sku, offerId } = ctx;
  const doPublish = () =>
    ebayRequest(accessToken, "POST", `${EBAY_INV_BASE}/offer/${offerId}/publish`, {
      extraHeaders: CL,
    });
  const putInventory = () =>
    ebayRequest(accessToken, "PUT", `${EBAY_INV_BASE}/inventory_item/${sku}`, {
      body: ctx.inventoryItem,
      extraHeaders: CL,
    });

  let r = await doPublish();
  if (r.ok) return { success: true, sku, offerId, listingId: r.json?.listingId || "" };

  let eids = errorIds(r);

  // Recovery: missing item specifics.
  const missing = extractMissingAspects(r);
  if (missing.length && addMissingAspects(ctx.aspects, missing).length) {
    ctx.inventoryItem.product.aspects = ctx.aspects;
    await putInventory();
    r = await doPublish();
    if (r.ok) return { success: true, sku, offerId, listingId: r.json?.listingId || "" };
    eids = errorIds(r);
  }

  // Recovery: invalid condition (25059/25021) → fall back to a safe used grade.
  if (eids.includes(25059) || eids.includes(25021)) {
    ctx.inventoryItem.condition = APPAREL_CATEGORIES.has(ctx.catKey)
      ? "PRE_OWNED_EXCELLENT"
      : "USED_GOOD";
    await putInventory();
    r = await doPublish();
    if (r.ok) return { success: true, sku, offerId, listingId: r.json?.listingId || "" };
    eids = errorIds(r);
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

  return {
    success: false,
    sku,
    offerId,
    error: `Publish failed (${r.status}): ${r.text.slice(0, 300)}`,
  };
}
