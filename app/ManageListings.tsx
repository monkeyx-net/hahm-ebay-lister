"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiPost } from "@/lib/api-client";
import type { EbayListingSummary, MarketConfig, RefreshListingResult } from "@/lib/types";

// Reseller best practice: don't touch unsold inventory before ~30 days (still
// gathering views), and by ~90 days it's overdue for a refresh.
const MIN_STAGNANT_DAYS = 30;
const OVERDUE_DAYS = 90;

type RowState = "idle" | "refreshing" | "refreshed" | "error";

interface Row extends EbayListingSummary {
  state: RowState;
  error?: string;
  newListingId?: string;
}

function ageLabel(days: number): { text: string; tier: "ready" | "overdue" } {
  if (days < OVERDUE_DAYS) return { text: `${days}d — ready to refresh`, tier: "ready" };
  return { text: `${days}d — overdue`, tier: "overdue" };
}

function formatPrice(price: number, currency: string, fallbackSymbol: string): string {
  const symbol = currency ? `${currency} ` : fallbackSymbol;
  return `${symbol}${price.toFixed(2)}`;
}

interface ManageListingsProps {
  market: MarketConfig;
  onClose: () => void;
}

export function ManageListings({ market, onClose }: ManageListingsProps) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiPost("/api/ebay/listings", {});
      const data = (await res.json()) as { ok: boolean; listings?: EbayListingSummary[]; error?: string };
      if (!data.ok || !data.listings) throw new Error(data.error || "Could not load your eBay listings.");
      setRows(data.listings.map((l) => ({ ...l, state: "idle" })));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshOne = useCallback(async (sku: string) => {
    setRows((prev) =>
      prev
        ? prev.map((r) => (r.sku === sku ? { ...r, state: "refreshing", error: undefined } : r))
        : prev
    );
    try {
      const res = await apiPost("/api/ebay/refresh-listing", { sku });
      const data = (await res.json()) as RefreshListingResult;
      if (!data.success) throw new Error(data.error || "eBay rejected the refresh.");
      setRows((prev) =>
        prev
          ? prev.map((r) =>
              r.sku === sku
                ? { ...r, state: "refreshed", ageDays: 0, itemId: data.newListingId || r.itemId, newListingId: data.newListingId }
                : r
            )
          : prev
      );
    } catch (e) {
      setRows((prev) =>
        prev
          ? prev.map((r) => (r.sku === sku ? { ...r, state: "error", error: (e as Error).message } : r))
          : prev
      );
    }
  }, []);

  // Everything rendered below is already 30+ days old (see stagnantRows), so
  // refreshing never needs an "are you sure it's not too soon" confirmation.
  const requestRefresh = (row: Row) => void refreshOne(row.sku);

  const stagnantRows = useMemo(
    () => (rows ?? []).filter((r) => r.ageDays >= MIN_STAGNANT_DAYS),
    [rows]
  );

  const stagnantSkus = useMemo(
    () => stagnantRows.filter((r) => r.state !== "refreshed").map((r) => r.sku),
    [stagnantRows]
  );

  const refreshAllStagnant = async () => {
    setBulkRunning(true);
    try {
      for (const sku of stagnantSkus) {
        await refreshOne(sku);
      }
    } finally {
      setBulkRunning(false);
    }
  };

  return (
    <section className="panel manage-listings">
      <div className="manage-listings-head">
        <div>
          <h2 className="section-label">Manage listings</h2>
          <p className="manage-listings-sub">
            Listings live {MIN_STAGNANT_DAYS}+ days with no sale — reseller best practice is to wait
            that long, then refresh them. Refreshing ends the old listing and creates a brand-new
            listing ID, which resets its position in eBay's search and re-alerts interested buyers,
            instead of quietly relisting under the same thread.
          </p>
        </div>
        <button type="button" className="btn-ghost" onClick={onClose}>
          ← Back
        </button>
      </div>

      <div className="manage-listings-toolbar">
        <button type="button" className="btn-ghost" onClick={() => void load()} disabled={loading}>
          {loading ? (
            <>
              <span className="spinner small" aria-hidden="true" /> Loading…
            </>
          ) : (
            "↻ Refresh list"
          )}
        </button>
        {stagnantSkus.length > 0 && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={refreshAllStagnant}
            disabled={bulkRunning}
          >
            {bulkRunning
              ? "Refreshing…"
              : `Refresh all stagnant (${stagnantSkus.length})`}
          </button>
        )}
      </div>

      {error && (
        <p className="note note-error" role="alert">
          {error}
        </p>
      )}

      {!error && rows && rows.length === 0 && !loading && (
        <p className="manage-listings-empty">No active eBay listings found.</p>
      )}

      {!error && rows && rows.length > 0 && stagnantRows.length === 0 && !loading && (
        <p className="manage-listings-empty">
          Nothing stagnant yet — every active listing is under {MIN_STAGNANT_DAYS} days old.
        </p>
      )}

      {stagnantRows.length > 0 && (
        <ul className="listing-rows">
          {stagnantRows.map((row) => {
            const age = ageLabel(row.ageDays);
            return (
              <li key={row.sku} className={`listing-row tier-${age.tier}`}>
                {row.galleryUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="listing-row-thumb" src={row.galleryUrl} alt="" />
                )}
                <div className="listing-row-main">
                  <div className="listing-row-title">
                    <span className="sku-tag">{row.sku}</span>
                    {row.title}
                  </div>
                  <div className="listing-row-meta">
                    <span className={`badge badge-${age.tier}`}>{age.text}</span>
                    <span>{formatPrice(row.price, row.currency, market.currencySymbol)}</span>
                    {row.quantitySold > 0 && <span>{row.quantitySold} sold</span>}
                    <a
                      href={`${market.itemBaseUrl}${row.itemId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View on eBay ↗
                    </a>
                  </div>
                  {row.state === "error" && row.error && (
                    <p className="post-result err">⚠️ {row.error}</p>
                  )}
                  {row.state === "refreshed" && (
                    <p className="post-result ok">
                      ✅ Refreshed
                      {row.newListingId ? (
                        <>
                          {" "}
                          ·{" "}
                          <a
                            href={`${market.itemBaseUrl}${row.newListingId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            View new listing ↗
                          </a>
                        </>
                      ) : null}
                    </p>
                  )}
                </div>
                <div className="listing-row-action">
                  {row.state === "refreshed" ? null : (
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => requestRefresh(row)}
                      disabled={row.state === "refreshing" || bulkRunning}
                    >
                      {row.state === "refreshing" ? (
                        <>
                          <span className="spinner small" aria-hidden="true" /> Refreshing…
                        </>
                      ) : (
                        "↻ Refresh listing"
                      )}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
