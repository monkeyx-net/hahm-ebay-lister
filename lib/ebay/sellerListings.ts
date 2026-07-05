// Reads the seller's currently-active eBay listings (for the "Manage
// Listings" stagnant-inventory dashboard) via the legacy Trading API's
// GetMyeBaySelling call — the REST Inventory API has no endpoint that
// exposes a listing's start date, which is what "how stagnant is this?"
// needs.

import { callTradingApi } from "./tradingXml";
import type { EbayListingSummary } from "../types";

const PAGE_SIZE = 200;
const MAX_PAGES = 10; // up to 2000 active listings scanned

// eBay's default GetMyeBaySelling response omits several fields we need
// (notably ListingDetails.StartTime — without it every listing's age reads
// as 0, since Date.parse("") is NaN). Once ANY OutputSelector is present it
// REPLACES the default field set entirely (including PaginationResult), so
// every field this module reads — and pagination itself — must be listed
// explicitly here.
const OUTPUT_SELECTORS = [
  "ActiveList.PaginationResult.TotalNumberOfPages",
  "ActiveList.PaginationResult.TotalNumberOfEntries",
  "ActiveList.ItemArray.Item.ItemID",
  "ActiveList.ItemArray.Item.SKU",
  "ActiveList.ItemArray.Item.Title",
  "ActiveList.ItemArray.Item.Quantity",
  "ActiveList.ItemArray.Item.ListingDetails.StartTime",
  "ActiveList.ItemArray.Item.SellingStatus.CurrentPrice",
  "ActiveList.ItemArray.Item.SellingStatus.QuantitySold",
  "ActiveList.ItemArray.Item.PictureDetails.GalleryURL",
  "ActiveList.ItemArray.Item.Variations.Variation.SKU",
];

function requestXml(page: number): string {
  const selectors = OUTPUT_SELECTORS.map((s) => `  <OutputSelector>${s}</OutputSelector>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ActiveList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>${PAGE_SIZE}</EntriesPerPage>
      <PageNumber>${page}</PageNumber>
    </Pagination>
  </ActiveList>
${selectors}
</GetMyeBaySellingRequest>`;
}

// Trading API mixes plain values and { "@_currencyID": ..., "#text": ... }
// attributed values depending on whether the element carries attributes.
function textValue(v: any): string {
  if (v == null) return "";
  if (typeof v === "object") return String(v["#text"] ?? "");
  return String(v);
}

function numberValue(v: any): number {
  const n = Number(textValue(v));
  return Number.isFinite(n) ? n : 0;
}

export async function fetchActiveListings(accessToken: string): Promise<EbayListingSummary[]> {
  const out: EbayListingSummary[] = [];
  const now = Date.now();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await callTradingApi(accessToken, "GetMyeBaySelling", requestXml(page));
    if (!result.ok) {
      if (page === 1) {
        const msg = result.errors[0]?.message || "Could not read your eBay listings.";
        throw new Error(msg);
      }
      break;
    }

    const active = result.data?.ActiveList;
    const items: any[] = active?.ItemArray?.Item ?? [];
    for (const item of items) {
      // Multi-variation listings don't have a single SKU/price to refresh —
      // skip them rather than risk mis-mapping a variation's SKU to the parent.
      if (item?.Variations) continue;
      const sku = textValue(item?.SKU).trim();
      if (!sku) continue; // can't map back to a REST offer without a SKU

      const startTime = textValue(item?.ListingDetails?.StartTime);
      const startMs = Date.parse(startTime);
      const ageDays = Number.isFinite(startMs)
        ? Math.max(0, Math.floor((now - startMs) / 86_400_000))
        : 0;

      out.push({
        itemId: textValue(item?.ItemID),
        sku,
        title: textValue(item?.Title),
        price: numberValue(item?.SellingStatus?.CurrentPrice),
        currency:
          typeof item?.SellingStatus?.CurrentPrice === "object"
            ? String(item.SellingStatus.CurrentPrice["@_currencyID"] ?? "")
            : "",
        galleryUrl: textValue(item?.PictureDetails?.GalleryURL) || undefined,
        startTime,
        ageDays,
        quantity: numberValue(item?.Quantity),
        quantitySold: numberValue(item?.SellingStatus?.QuantitySold),
      });
    }

    const totalPages = numberValue(active?.PaginationResult?.TotalNumberOfPages);
    if (!totalPages || page >= totalPages) break;
  }

  out.sort((a, b) => b.ageDays - a.ageDays);
  return out;
}
