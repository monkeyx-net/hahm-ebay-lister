import { csvCell, priceNumber } from "@/lib/export";
import type { ItemGroup, ListingResult } from "@/lib/types";

// Vinted has no bulk import or open developer API for individual sellers, so
// there's nothing to auto-publish to. This module just reformats the same
// listing data the app already generates for eBay into Vinted's vocabulary,
// for the seller to copy/paste into Vinted's own listing form by hand.

// The app's condition tiers (see CONDITIONS in app/ListingCard.tsx) don't line
// up 1:1 with Vinted's 5-tier scale, so EXCELLENT/VERY_GOOD both collapse to
// Vinted's "Very good" and FAIR maps to its lowest tier, "Satisfactory".
const VINTED_CONDITION_MAP: Record<string, string> = {
  NEW_WITH_TAGS: "New with tags",
  NEW_NO_TAGS: "New without tags",
  EXCELLENT: "Very good",
  VERY_GOOD: "Very good",
  GOOD: "Good",
  FAIR: "Satisfactory",
};

export function toVintedCondition(condition?: string): string {
  if (!condition) return "";
  return VINTED_CONDITION_MAP[condition] ?? condition.replace(/_/g, " ").toLowerCase();
}

function colorText(color: ListingResult["color"]): string {
  return Array.isArray(color) ? color.join(", ") : color ?? "";
}

// A clipboard-friendly block covering everything Vinted's listing form asks
// for: title, price, brand, size, condition, color, material, category, and
// description. Category is left as the free-text `category_hint` since
// Vinted's catalog tree differs from eBay's and this app doesn't resolve it.
export function formatListingForVinted(listing: ListingResult): string {
  const lines = [
    `Title: ${listing.title}`,
    `Price: ${priceNumber(listing.suggested_price)}`,
    listing.brand && `Brand: ${listing.brand}`,
    listing.size && `Size: ${listing.size}`,
    `Condition: ${toVintedCondition(listing.condition)}`,
    colorText(listing.color) && `Color: ${colorText(listing.color)}`,
    listing.material && `Material: ${listing.material}`,
    listing.category_hint && `Category: ${listing.category_hint}`,
    "",
    "Description:",
    listing.description,
  ];
  return lines.filter(Boolean).join("\n");
}

const VINTED_CSV_COLUMNS: { header: string; get: (l: ListingResult) => string }[] = [
  { header: "Title", get: (l) => l.title ?? "" },
  { header: "Price", get: (l) => priceNumber(l.suggested_price) },
  { header: "Condition", get: (l) => toVintedCondition(l.condition) },
  { header: "Brand", get: (l) => l.brand ?? "" },
  { header: "Size", get: (l) => l.size ?? "" },
  { header: "Color", get: (l) => colorText(l.color) },
  { header: "Material", get: (l) => l.material ?? "" },
  { header: "Category", get: (l) => l.category_hint ?? "" },
  { header: "Description", get: (l) => l.description ?? "" },
];

// A personal-record spreadsheet, not an official Vinted import format — Vinted
// doesn't offer bulk import for individual sellers, so listings still get
// entered one at a time through Vinted's own form.
export function listingsToVintedCsv(groups: ItemGroup[]): string {
  const done = groups.filter((g) => g.listing);
  const headerRow = ["SKU", "Item Name", ...VINTED_CSV_COLUMNS.map((c) => c.header)]
    .map(csvCell)
    .join(",");
  const rows = done.map((g) => {
    const l = g.listing as ListingResult;
    return [
      csvCell(g.sku),
      csvCell(g.name),
      ...VINTED_CSV_COLUMNS.map((c) => csvCell(c.get(l))),
    ].join(",");
  });
  return [headerRow, ...rows].join("\r\n");
}
