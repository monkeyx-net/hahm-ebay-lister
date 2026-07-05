// Shared helper for legacy Trading API (XML) calls, authenticated the same
// way as the photo-upload call in publish.ts: the REST OAuth access token is
// sent as an IAF token, no separate Trading credentials needed.

import { XMLParser } from "fast-xml-parser";
import { EBAY_TRADING, EBAY_SITE_ID } from "./config";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // GetMyeBaySelling's ItemArray can hold one or many <Item> — always give
  // callers an array so they don't have to special-case the singular case.
  isArray: (name) => name === "Item" || name === "Variation",
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
