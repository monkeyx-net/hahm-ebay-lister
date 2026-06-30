// eBay API constants + credential loading for the web app.
//
// Phase 2 uses a SEPARATE eBay keyset from the Python lister (so the two never
// interfere). These come from environment variables:
//   EBAY_CLIENT_ID      — the App ID (Client ID)
//   EBAY_CLIENT_SECRET  — the Cert ID (Client Secret)
//   EBAY_RU_NAME        — the RuName, whose "auth accepted URL" in the eBay
//                         developer portal must point at this app's callback
//                         (e.g. https://your-app.example.com/api/ebay/callback)
//   SESSION_SECRET      — random string used to encrypt the stored eBay token

export const EBAY_OAUTH_URL = "https://auth.ebay.com/oauth2/authorize";
export const EBAY_TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
export const EBAY_INV_BASE = "https://api.ebay.com/sell/inventory/v1";
export const EBAY_ACC_BASE = "https://api.ebay.com/sell/account/v1";
export const EBAY_META_BASE = "https://api.ebay.com/sell/metadata/v1";
export const EBAY_TAX_BASE = "https://api.ebay.com/commerce/taxonomy/v1";
export const EBAY_TRADING = "https://api.ebay.com/ws/api.dll";

// ── Marketplace selection ─────────────────────────────────────────────────────
// Defaults target eBay UK (GBP). Override via env to run against another eBay
// site without code changes. These four describe the SAME eBay site and must
// stay consistent — for example:
//   UK: EBAY_GB / tree 3 / Trading site 3 / GBP / en-GB
//   US: EBAY_US / tree 0 / Trading site 0 / USD / en-US
//   DE: EBAY_DE / tree 77 / Trading site 77 / EUR / de-DE
export const EBAY_MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || "EBAY_GB";
export const EBAY_CATEGORY_TREE_ID = process.env.EBAY_CATEGORY_TREE_ID || "3";
// Trading API site id (used for the XML photo-upload call). UK = 3, US = 0.
export const EBAY_SITE_ID = process.env.EBAY_SITE_ID || "3";
// ISO 4217 currency code the offers are priced in.
export const EBAY_CURRENCY = process.env.EBAY_CURRENCY || "GBP";
// Locale sent as Accept-Language / Content-Language on eBay requests.
export const EBAY_LOCALE = process.env.EBAY_LOCALE || "en-GB";
// Country for the auto-created inventory location (ISO 3166 alpha-2).
export const EBAY_LOCATION_COUNTRY = process.env.EBAY_LOCATION_COUNTRY || "GB";
// Base URL used to link a published listing in the UI.
export const EBAY_ITEM_BASE_URL =
  process.env.EBAY_ITEM_BASE_URL || "https://www.ebay.co.uk/itm/";

// Symbol shown in the UI for the active currency. Falls back to the code itself
// for currencies we don't have a glyph for.
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  GBP: "£",
  EUR: "€",
  CAD: "C$",
  AUD: "A$",
};

export function currencySymbol(code: string = EBAY_CURRENCY): string {
  return CURRENCY_SYMBOLS[code.toUpperCase()] || `${code.toUpperCase()} `;
}

export const EBAY_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
].join(" ");

export interface EbayCreds {
  clientId: string;
  clientSecret: string;
  ruName: string;
}

export function getEbayCreds(): EbayCreds {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const ruName = process.env.EBAY_RU_NAME;
  if (!clientId || !clientSecret || !ruName) {
    throw new Error(
      "eBay is not configured. Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and EBAY_RU_NAME in your environment variables."
    );
  }
  return { clientId, clientSecret, ruName };
}

export function isEbayConfigured(): boolean {
  return Boolean(
    process.env.EBAY_CLIENT_ID &&
      process.env.EBAY_CLIENT_SECRET &&
      process.env.EBAY_RU_NAME
  );
}

export function basicAuthHeader(creds: EbayCreds): string {
  const raw = `${creds.clientId}:${creds.clientSecret}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}
