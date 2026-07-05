// Shared helper for legacy Trading API (XML) calls, authenticated the same
// way as the photo-upload call in publish.ts: the REST OAuth access token is
// sent as an IAF token, no separate Trading credentials needed.

import { XMLParser } from "fast-xml-parser";
import { EBAY_TRADING, EBAY_SITE_ID } from "./config";

const ARRAY_TAGS = new Set([
  "Item", // GetMyeBaySelling's ItemArray
  "Variation", // multi-variation listings
  "PictureURL", // GetItem's PictureDetails
  "NameValueList", // GetItem's ItemSpecifics
  "Value", // NameValueList can hold multiple values per aspect
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Always give callers an array for repeatable elements, so call sites don't
  // have to special-case "one result" vs "many results".
  isArray: (name) => ARRAY_TAGS.has(name),
});

export interface TradingApiResult {
  ok: boolean;
  data: any;
  errors: { code: string; message: string }[];
}

export async function callTradingApi(
  accessToken: string,
  callName: string,
  bodyXml: string
): Promise<TradingApiResult> {
  const resp = await fetch(EBAY_TRADING, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-SITEID": EBAY_SITE_ID,
      "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
      "X-EBAY-API-CALL-NAME": callName,
      "X-EBAY-API-IAF-TOKEN": accessToken,
    },
    body: bodyXml,
  });
  const text = await resp.text();
  let data: any = null;
  try {
    data = parser.parse(text);
  } catch {
    return { ok: false, data: null, errors: [{ code: "", message: "Could not parse eBay's response." }] };
  }

  const root = data?.[`${callName}Response`];
  const ack = String(root?.Ack || "");
  const rawErrors = root?.Errors;
  const errorList = Array.isArray(rawErrors) ? rawErrors : rawErrors ? [rawErrors] : [];
  const errors = errorList.map((e: any) => ({
    code: String(e?.ErrorCode ?? ""),
    message: String(e?.LongMessage || e?.ShortMessage || "").trim(),
  }));

  return { ok: resp.ok && (ack === "Success" || ack === "Warning"), data: root, errors };
}

// Trading API mixes plain values and { "@_currencyID": ..., "#text": ... }
// attributed values depending on whether the element carries attributes.
export function textValue(v: any): string {
  if (v == null) return "";
  if (typeof v === "object") return String(v["#text"] ?? "");
  return String(v);
}

export function numberValue(v: any): number {
  const n = Number(textValue(v));
  return Number.isFinite(n) ? n : 0;
}

// Escape plain-text XML content (element bodies, not already-CDATA-wrapped).
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Wrap text as CDATA, guarding against a literal "]]>" breaking out early.
export function cdata(s: string): string {
  return `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}
