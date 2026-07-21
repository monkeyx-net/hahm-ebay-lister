"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CategoryAspect,
  CategoryAspectsResponse,
  ItemGroup,
  ListingResult,
  MarketConfig,
  Photo,
} from "@/lib/types";
import { apiPost } from "@/lib/api-client";
import { SIZE_REQUIRED_CATEGORIES } from "@/lib/categories";
import { formatListingForVinted } from "@/lib/export";

const TITLE_LIMIT = 80;

// eBay's pre-owned condition tiers, matching the values the model returns.
const CONDITIONS: { value: string; label: string }[] = [
  { value: "NEW_WITH_TAGS", label: "New with tags" },
  { value: "NEW_NO_TAGS", label: "New without tags" },
  { value: "EXCELLENT", label: "Pre-owned · Excellent" },
  { value: "VERY_GOOD", label: "Pre-owned · Very good" },
  { value: "GOOD", label: "Pre-owned · Good" },
  { value: "FAIR", label: "Pre-owned · Fair" },
];

function formatPrice(value: ListingResult["suggested_price"], symbol: string): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (n === undefined || Number.isNaN(n)) return `${symbol}0.00`;
  return `${symbol}${n.toFixed(2)}`;
}

function priceToInput(value: ListingResult["suggested_price"]): string {
  if (value === undefined) return "";
  // Preserve the raw text the user is typing (e.g. "9.50" or a trailing ".")
  // — normalizing it back through a number would strip trailing zeros mid-edit.
  if (typeof value === "string") return value;
  return Number.isNaN(value) ? "" : String(value);
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="btn-ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {copied ? "✓ Copied" : `📋 Copy ${label}`}
    </button>
  );
}

interface ListingCardProps {
  group: ItemGroup;
  photoById: (id: string) => Photo | undefined;
  ebayConnected: boolean;
  ebayConfigured: boolean;
  market: MarketConfig;
  onEdit: (groupId: string, patch: Partial<ListingResult>) => void;
  onRetry: (groupId: string) => void;
  onPost: (groupId: string) => void;
}

export function ListingCard({
  group,
  photoById,
  ebayConnected,
  ebayConfigured,
  market,
  onEdit,
  onRetry,
  onPost,
}: ListingCardProps) {
  const [open, setOpen] = useState(true);
  const listing = group.listing;
  const cover = photoById(group.photoIds[0]);

  // eBay "comps": median/range of comparable ACTIVE listings, fetched on demand.
  const [comps, setComps] = useState<
    { low: number; high: number; median: number; count: number } | null
  >(null);
  const [compsBusy, setCompsBusy] = useState(false);
  const [compsMsg, setCompsMsg] = useState<string | null>(null);

  // The server now fetches comps during analysis and attaches them to the
  // listing, so show them without making the seller click "eBay comps" first.
  useEffect(() => {
    if (listing?.comps) setComps(listing.comps);
  }, [listing?.comps]);

  const checkComps = async () => {
    const query =
      listing?.title?.trim() ||
      [listing?.brand, listing?.item_type].filter(Boolean).join(" ").trim();
    if (!query) return;
    setCompsBusy(true);
    setCompsMsg(null);
    try {
      const r = await apiPost("/api/ebay/comps", { query });
      const data = (await r.json()) as {
        ok: boolean;
        low?: number;
        high?: number;
        median?: number;
        count?: number;
        error?: string;
      };
      if (!data.ok) throw new Error(data.error || "No comps found.");
      setComps({
        low: data.low!,
        high: data.high!,
        median: data.median!,
        count: data.count!,
      });
    } catch (e) {
      setComps(null);
      setCompsMsg((e as Error).message);
    } finally {
      setCompsBusy(false);
    }
  };

  const specifics = useMemo(() => {
    const entries = Object.entries(listing?.item_specifics ?? {});
    // Values come from model output, so they aren't guaranteed to be strings —
    // some providers return numbers/arrays. Coerce before trimming/rendering so a
    // non-string value can't crash the card (el.trim is not a function → blank screen).
    return entries
      .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")] as [string, string])
      // Brand and Model have dedicated editable fields above, so drop them from
      // this read-only list to avoid showing (and diverging from) them twice.
      .filter(([k, v]) => v.trim() !== "" && !k.startsWith("---") && k !== "Brand" && k !== "Model");
  }, [listing?.item_specifics]);

  // Patch a single item-specific (e.g. Model) without dropping the rest. Model
  // isn't a top-level ListingResult field — it lives in item_specifics, which is
  // what buildAspects() reads when creating the eBay inventory item.
  const editSpecific = (key: string, value: string) =>
    onEdit(group.id, {
      item_specifics: { ...(listing?.item_specifics ?? {}), [key]: value },
    });

  // Required item-specifics for this listing's eBay category, fetched once the
  // card is open. Surfacing them (with eBay's exact pick-list values) lets the
  // seller fill real values instead of hitting a 25002 "<aspect> is missing" on
  // post — and the server still auto-fills anything left blank.
  const [reqAspects, setReqAspects] = useState<CategoryAspect[] | null>(null);
  const aspectsRequested = useRef(false);
  useEffect(() => {
    if (!open || group.status !== "done" || !ebayConfigured || !listing) return;
    if (aspectsRequested.current) return;
    aspectsRequested.current = true;
    apiPost("/api/ebay/aspects", { listing })
      .then((r) => r.json())
      .then((data: CategoryAspectsResponse) => {
        if (data.ok && data.aspects) setReqAspects(data.aspects);
      })
      .catch(() => {
        /* non-fatal: the publish path still auto-fills missing required aspects */
      });
    // listing is intentionally omitted from deps: the category is stable and the
    // ref guard already makes this fire once, so edits don't trigger a refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, group.status, ebayConfigured]);

  // Brand, Model/MPN and Size already have dedicated fields above — drop them so
  // we don't offer two editors for the same aspect.
  const isCovered = (name: string) => {
    const n = name.toLowerCase();
    return (
      n === "brand" ||
      n === "model" ||
      n === "mpn" ||
      (n.includes("size") && !n.includes("size type"))
    );
  };
  const requiredAspects = (reqAspects ?? []).filter((a) => !isCovered(a.name));

  // Anything now shown as an editable required field is dropped from the
  // read-only list below, so each aspect appears exactly once.
  const requiredNames = new Set(requiredAspects.map((a) => a.name.toLowerCase()));
  const readOnlySpecifics = specifics.filter(([k]) => !requiredNames.has(k.toLowerCase()));

  const titleLen = listing?.title?.length ?? 0;

  // The server pulls an over-market price guess toward the comps median. Surface
  // what happened so the seller understands it (and can revert to the raw guess).
  const llmPriceNum =
    listing?.llm_price !== undefined ? parseFloat(String(listing.llm_price)) : NaN;
  const overMarket =
    listing?.price_source === "blended" ||
    (!!listing?.comps &&
      !Number.isNaN(llmPriceNum) &&
      llmPriceNum > listing.comps.high);

  // eBay's size standardization blocks apparel/footwear listings that are
  // missing a Size, so flag those for the seller before they post.
  const sizeRequired = SIZE_REQUIRED_CATEGORIES.has(listing?.category ?? "");
  const sizeMissing = sizeRequired && !(listing?.size ?? "").trim();

  return (
    <article className={`listing-card status-${group.status}`}>
      <header className="listing-card-head" onClick={() => setOpen((o) => !o)}>
        {cover && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="listing-cover" src={cover.previewUrl} alt="" />
        )}
        <div className="listing-card-title">
          <strong>
            {group.sku && <span className="sku-tag">{group.sku}</span>}
            {listing?.title || group.name}
          </strong>
          <span className="listing-card-sub">
            {group.status === "writing" && (
              <>
                <span className="spinner small" aria-hidden="true" /> Writing…
              </>
            )}
            {group.status === "done" && (
              <>✅ {formatPrice(listing?.suggested_price, market.currencySymbol)} · ready</>
            )}
            {group.status === "error" && (
              <span style={{ color: "var(--color-danger)" }}>
                ⚠️ {group.error || "Failed"}
              </span>
            )}
            {group.status === "idle" && "Waiting…"}
          </span>
        </div>
        {group.status === "error" ? (
          <button
            type="button"
            className="btn-ghost"
            onClick={(e) => {
              e.stopPropagation();
              onRetry(group.id);
            }}
          >
            ↻ Retry
          </button>
        ) : (
          <span className="chevron" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
        )}
      </header>

      {open && listing && group.status === "done" && (
        <div className="listing-card-body">
          <div className="result-field">
            <label>
              Title
              <span className={`count${titleLen > TITLE_LIMIT ? " over" : ""}`}>
                {titleLen}/{TITLE_LIMIT}
              </span>
            </label>
            <input
              type="text"
              className="title-input"
              value={listing.title}
              onChange={(e) => onEdit(group.id, { title: e.target.value })}
            />
            <div className="copy-row">
              <CopyButton text={listing.title} label="title" />
            </div>
          </div>

          <div className="meta-row">
            <div className="stat editable">
              <label className="k" htmlFor={`price-${group.id}`}>
                Price
              </label>
              <div className="price-input">
                <span aria-hidden="true">{market.currencySymbol}</span>
                <input
                  id={`price-${group.id}`}
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={priceToInput(listing.suggested_price)}
                  onChange={(e) =>
                    // Keep the raw string so in-progress values like "9.50"
                    // survive; consumers (export, publish) parse it as needed.
                    onEdit(group.id, { suggested_price: e.target.value })
                  }
                />
              </div>
              {ebayConfigured && (
                <div
                  className="comps-row"
                  style={{
                    marginTop: 6,
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: 8,
                    fontSize: "0.85em",
                  }}
                >
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={checkComps}
                    disabled={compsBusy}
                    title="Median & range of comparable active eBay listings"
                  >
                    {compsBusy ? "Checking eBay…" : "📊 eBay comps"}
                  </button>
                  {comps && (
                    <span style={{ opacity: 0.9 }}>
                      {formatPrice(comps.low, market.currencySymbol)}–
                      {formatPrice(comps.high, market.currencySymbol)} · median{" "}
                      <strong>
                        {formatPrice(comps.median, market.currencySymbol)}
                      </strong>{" "}
                      <span style={{ opacity: 0.6 }}>({comps.count} active)</span>{" "}
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() =>
                          onEdit(group.id, { suggested_price: comps.median })
                        }
                      >
                        Use median
                      </button>
                      {overMarket && listing.llm_price !== undefined && (
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() =>
                            onEdit(group.id, {
                              suggested_price: listing.llm_price,
                            })
                          }
                          title="Revert to the model's original price guess"
                        >
                          Use first guess
                        </button>
                      )}
                    </span>
                  )}
                  {compsMsg && (
                    <span style={{ color: "var(--color-danger)" }}>{compsMsg}</span>
                  )}
                </div>
              )}
              {ebayConfigured && overMarket && listing.comps && (
                <div
                  style={{
                    marginTop: 4,
                    fontSize: "0.8em",
                    color: "var(--color-warning, #b26a00)",
                  }}
                >
                  ⚠ First guess{" "}
                  {formatPrice(listing.llm_price, market.currencySymbol)} was above
                  market ({formatPrice(listing.comps.low, market.currencySymbol)}–
                  {formatPrice(listing.comps.high, market.currencySymbol)})
                  {listing.price_source === "blended"
                    ? "; adjusted toward the median."
                    : " — consider using the median."}
                </div>
              )}
            </div>
            <div className="stat editable">
              <label className="k" htmlFor={`cond-${group.id}`}>
                Condition
              </label>
              <select
                id={`cond-${group.id}`}
                value={listing.condition ?? "GOOD"}
                onChange={(e) => onEdit(group.id, { condition: e.target.value })}
              >
                {/* Keep an unexpected model value selectable rather than losing it. */}
                {listing.condition &&
                  !CONDITIONS.some((c) => c.value === listing.condition) && (
                    <option value={listing.condition}>
                      {listing.condition.replace(/_/g, " ")}
                    </option>
                  )}
                {CONDITIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="stat editable">
              <label className="k" htmlFor={`brand-${group.id}`}>
                Brand
              </label>
              <input
                id={`brand-${group.id}`}
                type="text"
                className="brand-input"
                value={listing.brand ?? ""}
                placeholder="e.g. Nike, or Unbranded"
                onChange={(e) => onEdit(group.id, { brand: e.target.value })}
              />
            </div>
            <div className="stat editable">
              <label className="k" htmlFor={`model-${group.id}`}>
                Model
              </label>
              <input
                id={`model-${group.id}`}
                type="text"
                className="model-input"
                value={listing.item_specifics?.Model ?? ""}
                placeholder="e.g. Air Max 90, or Does Not Apply"
                onChange={(e) => editSpecific("Model", e.target.value)}
              />
            </div>
            {(sizeRequired || listing.size) && (
              <div className={`stat editable${sizeMissing ? " needs-attention" : ""}`}>
                <label className="k" htmlFor={`size-${group.id}`}>
                  Size
                </label>
                <input
                  id={`size-${group.id}`}
                  type="text"
                  className="size-input"
                  value={listing.size ?? ""}
                  placeholder={sizeRequired ? "e.g. M, 32x34, 10.5" : "—"}
                  onChange={(e) => onEdit(group.id, { size: e.target.value })}
                />
              </div>
            )}
          </div>

          {sizeMissing && (
            <p className="size-warning" role="alert">
              ⚠️ No size found on the tag. eBay now blocks apparel listings
              without a standard size — check the photos or measure the item,
              then fill in Size above before posting.
            </p>
          )}

          <div className="result-field">
            <label>Description</label>
            <textarea
              value={listing.description}
              onChange={(e) => onEdit(group.id, { description: e.target.value })}
              rows={8}
            />
            <div className="copy-row">
              <CopyButton text={listing.description} label="description" />
              <CopyButton
                text={formatListingForVinted(listing)}
                label="for Vinted"
              />
            </div>
          </div>

          {requiredAspects.length > 0 && (
            <div className="req-aspects">
              <div className="req-aspects-head">
                eBay category details{" "}
                <span className="req-aspects-note">
                  required for this category — blanks are auto-filled on post
                </span>
              </div>
              <div className="meta-row">
                {requiredAspects.map((a) => {
                  const val = listing.item_specifics?.[a.name] ?? "";
                  const empty = !val.trim();
                  const id = `asp-${group.id}-${a.name}`;
                  return (
                    <div
                      key={a.name}
                      className={`stat editable${empty ? " needs-attention" : ""}`}
                    >
                      <label className="k" htmlFor={id}>
                        {a.name}
                      </label>
                      {a.mode === "SELECTION_ONLY" && a.values.length > 0 ? (
                        <select
                          id={id}
                          value={val}
                          onChange={(e) => editSpecific(a.name, e.target.value)}
                        >
                          <option value="">— select —</option>
                          {/* Keep a value the model supplied that isn't on eBay's
                              list, rather than silently dropping it. */}
                          {val && !a.values.includes(val) && (
                            <option value={val}>{val}</option>
                          )}
                          {a.values.map((v) => (
                            <option key={v} value={v}>
                              {v}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          id={id}
                          type="text"
                          className="aspect-input"
                          value={val}
                          placeholder="—"
                          onChange={(e) => editSpecific(a.name, e.target.value)}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {readOnlySpecifics.length > 0 && (
            <details className="specifics-details">
              <summary>{readOnlySpecifics.length} item specifics</summary>
              <div className="specifics">
                {readOnlySpecifics.map(([k, v]) => (
                  <div className="row" key={k}>
                    <span className="k">{k}</span>
                    <span>{v}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* eBay posting */}
          {group.postStatus === "posted" ? (
            <p className="post-result ok">
              ✅ Posted to eBay
              {group.listingId ? (
                <>
                  {" "}
                  ·{" "}
                  <a
                    href={`${market.itemBaseUrl}${group.listingId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View listing ↗
                  </a>
                </>
              ) : null}
            </p>
          ) : ebayConnected ? (
            <div className="post-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => onPost(group.id)}
                disabled={group.postStatus === "posting"}
              >
                {group.postStatus === "posting" ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Posting to eBay…
                  </>
                ) : (
                  "🚀 Post this to eBay"
                )}
              </button>
              {group.postStatus === "error" && group.postError && (
                <p className="post-result err">⚠️ {group.postError}</p>
              )}
            </div>
          ) : (
            <p className="post-hint">Connect eBay (top of page) to post this listing.</p>
          )}
        </div>
      )}
    </article>
  );
}
