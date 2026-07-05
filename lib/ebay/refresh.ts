// "End Listing" + "Sell Similar" for a stagnant item — but done the cheap
// way. eBay's Inventory API documents that withdrawing an offer and then
// publishing that SAME offer again produces a brand-new listing ID; that's
// exactly the boost resellers get from End + Sell Similar (fresh listing,
// reset recency, no ties to the old view/watch history), without having to
// rebuild the listing content or re-upload photos.

import { EBAY_INV_BASE, EBAY_LOCALE } from "./config";
import {
  ebayRequest,
  withTransientRetry,
  findOfferBySku,
  primaryEbayError,
  logPublishFailure,
} from "./publish";
import type { RefreshListingResult } from "../types";

const CL = { "Content-Language": EBAY_LOCALE };

export async function refreshListing(
  accessToken: string,
  sku: string
): Promise<RefreshListingResult> {
  const offer = await findOfferBySku(accessToken, sku);
  if (!offer) {
    return {
      success: false,
      sku,
      error: `No eBay offer found for SKU ${sku} — it may already be ended, sold, or was never posted through this app.`,
    };
  }
  const { offerId, listingId: oldListingId, status } = offer;

  if (status === "PUBLISHED") {
    const withdraw = await withTransientRetry(
      () =>
        ebayRequest(accessToken, "POST", `${EBAY_INV_BASE}/offer/${offerId}/withdraw`, {
          extraHeaders: CL,
        }),
      "withdraw offer",
      sku
    );
    if (![200, 204].includes(withdraw.status)) {
      logPublishFailure("withdraw offer", sku, withdraw);
      return {
        success: false,
        sku,
        offerId,
        oldListingId,
        error: `End listing failed: ${primaryEbayError(withdraw).message || `HTTP ${withdraw.status}`}`,
      };
    }
  }

  const publish = await withTransientRetry(
    () =>
      ebayRequest(accessToken, "POST", `${EBAY_INV_BASE}/offer/${offerId}/publish`, {
        extraHeaders: CL,
      }),
    "publish offer",
    sku
  );
  if (!publish.ok) {
    logPublishFailure("re-publish offer", sku, publish);
    return {
      success: false,
      sku,
      offerId,
      oldListingId,
      error: `Sell similar failed: ${primaryEbayError(publish).message || `HTTP ${publish.status}`}`,
    };
  }

  return {
    success: true,
    sku,
    offerId,
    oldListingId,
    newListingId: String(publish.json?.listingId || ""),
  };
}
