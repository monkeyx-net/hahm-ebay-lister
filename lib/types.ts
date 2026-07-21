// Shape of a generated listing. Mirrors the JSON the model returns in the
// Python script's analyze_photos(), plus the routed profile.

export interface ListingResult {
  title: string;
  category?: string;
  category_hint?: string;
  category_id?: string;
  brand?: string;
  item_type?: string;
  color?: string[] | string;
  size?: string;
  material?: string;
  condition?: string;
  condition_notes?: string;
  measurements?: string;
  description: string;
  suggested_price?: number | string;
  seo_keywords?: string[];
  key_features?: string[];
  item_specifics?: Record<string, string>;
  item_profile?: string;
}

export interface AnalyzeRequestBody {
  // Browser-resized JPEG data URLs or raw base64 strings.
  images: { mediaType: string; data: string }[];
  profile: string;
  // Optional model overrides; server falls back to its defaults when omitted
  // or when the requested provider/model isn't on the server allowlist.
  analysisProvider?: string;
  analysisModel?: string;
  routerProvider?: string;
  routerModel?: string;
}

export interface AnalyzeResponse {
  ok: boolean;
  listing?: ListingResult;
  error?: string;
}

export interface SortResponse {
  ok: boolean;
  groups?: { name: string; photoIndices: number[] }[];
  orphanIndices?: number[];
  error?: string;
}

// ── Client-side working model for the bulk flow ──────────────────────────────

export interface Photo {
  id: string;
  previewUrl: string;
  mediaType: string;
  data: string; // base64, no prefix
}

export type ItemStatus = "idle" | "writing" | "done" | "error";

export type PostStatus = "idle" | "posting" | "posted" | "error";

export interface ItemGroup {
  id: string;
  sku: string; // bin reference, e.g. "K75-A"
  skuIndex: number; // stable suffix index (0→A, 1→B, …); survives deletes so bin letters don't renumber
  skuEdited?: boolean; // set once the user hand-edits the SKU, so a bin-code change won't overwrite it
  name: string;
  photoIds: string[];
  listing?: ListingResult;
  status: ItemStatus;
  error?: string;
  // eBay posting state (Phase 2)
  postStatus?: PostStatus;
  listingId?: string;
  postError?: string;
}

// Shape of the /api/models response. Shared by the server route and the
// ModelSelector UI so both agree on the model-picker payload.
export interface ModelOption {
  provider: "anthropic" | "openrouter" | "omniroute";
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
}

export interface ModelsPayload {
  sortModels: ModelOption[];
  analysisModels: ModelOption[];
}

// A required item-specific (aspect) for the listing's eBay leaf category, served
// by /api/ebay/aspects so the review card can offer editable fields — with the
// exact allowed values for SELECTION_ONLY aspects — before the seller posts.
export interface CategoryAspect {
  name: string;
  required: boolean;
  mode: "FREE_TEXT" | "SELECTION_ONLY";
  values: string[];
}

export interface CategoryAspectsResponse {
  ok: boolean;
  categoryId?: string;
  aspects?: CategoryAspect[];
  error?: string;
}

// Marketplace presentation, served by /api/ebay/status so the UI shows prices
// and listing links for the active eBay site (UK/GBP by default).
export interface MarketConfig {
  currencySymbol: string;
  itemBaseUrl: string;
}

// ── Manage Listings (stagnant-inventory refresh dashboard) ──────────────────

export interface EbayListingSummary {
  itemId: string;
  sku: string;
  title: string;
  price: number;
  currency: string;
  galleryUrl?: string;
  startTime: string; // ISO string from eBay
  ageDays: number;
  quantity: number;
  quantitySold: number;
}

export interface RefreshListingResult {
  success: boolean;
  sku: string;
  offerId?: string;
  oldListingId?: string;
  newListingId?: string;
  error?: string;
}
