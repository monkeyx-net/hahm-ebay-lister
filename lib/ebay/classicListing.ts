// "End Listing" + "Sell Similar" for eBay listings that have no Inventory-API
// SKU — i.e. most real inventory that was never touched by this app's REST
// publish flow (older listings, or ones posted on eBay's own site). The REST
// Inventory API has no way to touch these (it only knows about SKU-based
// offers), so this goes through the legacy Trading API instead:
//   GetItem (read the live listing) -> EndItem -> AddFixedPriceItem
// AddFixedPriceItem reuses the same already-hosted eBay Picture Services
// photo URLs GetItem returns, so there's no need to re-upload any images.

import { callTradingApi, textValue, numberValue, xmlEscape, cdata } from "./tradingXml";
import type { AccountSetup } from "./publish";
import type { RefreshListingResult } from "../types";

interface ClassicItemDetails {
  title: string;
  description: string;
  categoryId: string;
  conditionId: string;
  country: string;
  currency: string;
  postalCode: string;
  site: string;
  quantity: number;
  price: string;
  listingDuration: string;
  dispatchTimeMax: string;
  pictureUrls: string[];
  itemSpecifics: { name: string; values: string[] }[];
}

const GET_ITEM_SELECTORS = [
  "Item.Title",
  "Item.Description",
  "Item.PrimaryCategory.CategoryID",
  "Item.ConditionID",
  "Item.Country",
  "Item.Currency",
  "Item.PostalCode",
  "Item.Site",
  "Item.Quantity",
  "Item.SellingStatus.CurrentPrice",
  "Item.SellingStatus.QuantitySold",
  "Item.ListingDuration",
  "Item.DispatchTimeMax",
  "Item.PictureDetails.PictureURL",
  "Item.ItemSpecifics",
];

function toArray(v: any): any[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

// Read the live listing's full content — everything AddFixedPriceItem needs
// to recreate it as a brand-new listing.
export async function fetchClassicItemDetails(
  accessToken: string,
  itemId: string
): Promise<{ details: ClassicItemDetails | null; error?: string }> {
  const selectors = GET_ITEM_SELECTORS.map((s) => `  <OutputSelector>${s}</OutputSelector>`).join("\n");
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${xmlEscape(itemId)}</ItemID>
  <IncludeItemSpecifics>true</IncludeItemSpecifics>
${selectors}
</GetItemRequest>`;
  const result = await callTradingApi(accessToken, "GetItem", xml);
  if (!result.ok) {
    return { details: null, error: result.errors[0]?.message || "Could not read the listing's details." };
  }
  const item = result.data?.Item;
  if (!item) return { details: null, error: "eBay returned no item details." };

  const quantity = numberValue(item.Quantity);
  const sold = numberValue(item.SellingStatus?.QuantitySold);

  const pictureUrls = toArray(item.PictureDetails?.PictureURL)
    .map((u: any) => textValue(u))
    .filter(Boolean);

  const itemSpecifics = toArray(item.ItemSpecifics?.NameValueList)
    .map((nv: any) => ({
      name: textValue(nv?.Name).trim(),
      values: toArray(nv?.Value).map((v: any) => textValue(v)).filter(Boolean),
    }))
    .filter((s) => s.name && s.values.length);

  const details: ClassicItemDetails = {
    title: textValue(item.Title),
    description: textValue(item.Description),
    categoryId: textValue(item.PrimaryCategory?.CategoryID),
    conditionId: textValue(item.ConditionID),
    country: textValue(item.Country),
    currency: textValue(item.Currency),
    postalCode: textValue(item.PostalCode),
    site: textValue(item.Site),
    quantity: Math.max(1, quantity - sold),
    price: textValue(item.SellingStatus?.CurrentPrice) || "0",
    listingDuration: textValue(item.ListingDuration) || "GTC",
    dispatchTimeMax: textValue(item.DispatchTimeMax) || "3",
    pictureUrls,
    itemSpecifics,
  };

  // Refuse to proceed (and never touch EndItem) if we can't confidently
  // recreate the listing — ending it first and failing to relist would
  // leave the seller worse off than doing nothing.
  const missing: string[] = [];
  if (!details.title) missing.push("title");
  if (!details.categoryId) missing.push("category");
  if (!details.country) missing.push("country");
  if (!details.currency) missing.push("currency");
  if (!details.pictureUrls.length) missing.push("photos");
  if (missing.length) {
    return {
      details: null,
      error: `Missing ${missing.join(", ")} from eBay's item details — can't safely relist this one.`,
    };
  }

  return { details };
}

export async function endClassicItem(
  accessToken: string,
  itemId: string
): Promise<{ ok: boolean; error?: string }> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<EndItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${xmlEscape(itemId)}</ItemID>
  <EndingReason>NotAvailable</EndingReason>
</EndItemRequest>`;
  const result = await callTradingApi(accessToken, "EndItem", xml);
  if (!result.ok) {
    return { ok: false, error: result.errors[0]?.message || "Could not end the listing." };
  }
  return { ok: true };
}

export async function relistClassicItem(
  accessToken: string,
  details: ClassicItemDetails,
  setup: AccountSetup
): Promise<{ ok: boolean; newItemId?: string; error?: string }> {
  const pictures = details.pictureUrls
    .map((u) => `      <PictureURL>${xmlEscape(u)}</PictureURL>`)
    .join("\n");
  const specifics = details.itemSpecifics
    .map(
      (s) =>
        `      <NameValueList>\n        <Name>${xmlEscape(s.name)}</Name>\n` +
        s.values.map((v) => `        <Value>${xmlEscape(v)}</Value>`).join("\n") +
        `\n      </NameValueList>`
    )
    .join("\n");

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<AddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <Item>
    <Title>${xmlEscape(details.title.slice(0, 80))}</Title>
    <Description>${cdata(details.description || details.title)}</Description>
    <PrimaryCategory><CategoryID>${xmlEscape(details.categoryId)}</CategoryID></PrimaryCategory>
    ${details.conditionId ? `<ConditionID>${xmlEscape(details.conditionId)}</ConditionID>` : ""}
    <Country>${xmlEscape(details.country)}</Country>
    <Currency>${xmlEscape(details.currency)}</Currency>
    ${details.postalCode ? `<PostalCode>${xmlEscape(details.postalCode)}</PostalCode>` : ""}
    ${details.site ? `<Site>${xmlEscape(details.site)}</Site>` : ""}
    <Quantity>${details.quantity}</Quantity>
    <StartPrice>${xmlEscape(details.price)}</StartPrice>
    <ListingDuration>${xmlEscape(details.listingDuration)}</ListingDuration>
    <DispatchTimeMax>${xmlEscape(details.dispatchTimeMax)}</DispatchTimeMax>
    <ListingType>FixedPriceItem</ListingType>
    <PictureDetails>
${pictures}
    </PictureDetails>
    ${specifics ? `<ItemSpecifics>\n${specifics}\n    </ItemSpecifics>` : ""}
    <SellerProfiles>
      <SellerPaymentProfile><PaymentProfileID>${xmlEscape(setup.paymentPolicyId)}</PaymentProfileID></SellerPaymentProfile>
      <SellerReturnProfile><ReturnProfileID>${xmlEscape(setup.returnPolicyId)}</ReturnProfileID></SellerReturnProfile>
      <SellerShippingProfile><ShippingProfileID>${xmlEscape(setup.fulfillmentPolicyId)}</ShippingProfileID></SellerShippingProfile>
    </SellerProfiles>
  </Item>
</AddFixedPriceItemRequest>`;

  const result = await callTradingApi(accessToken, "AddFixedPriceItem", xml);
  if (!result.ok) {
    return { ok: false, error: result.errors[0]?.message || "eBay rejected the new listing." };
  }
  const newItemId = textValue(result.data?.ItemID);
  return { ok: true, newItemId: newItemId || undefined };
}

export async function refreshClassicListing(
  accessToken: string,
  itemId: string,
  setup: AccountSetup
): Promise<RefreshListingResult> {
  const { details, error } = await fetchClassicItemDetails(accessToken, itemId);
  if (!details) {
    return { success: false, sku: "", oldListingId: itemId, error: error || "Could not read the listing." };
  }

  const ended = await endClassicItem(accessToken, itemId);
  if (!ended.ok) {
    return { success: false, sku: "", oldListingId: itemId, error: `End listing failed: ${ended.error}` };
  }

  const relisted = await relistClassicItem(accessToken, details, setup);
  if (!relisted.ok) {
    return {
      success: false,
      sku: "",
      oldListingId: itemId,
      error:
        `The old listing was ended, but relisting it failed: ${relisted.error} — ` +
        `you'll need to manually create a new listing on eBay for "${details.title}".`,
    };
  }

  return { success: true, sku: "", oldListingId: itemId, newListingId: relisted.newItemId };
}
