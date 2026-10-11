"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { FeedResponse } from "@/app/api/_lib/public-types";
import { TierBadge } from "./TierBadge";
import { HttpError, apiFetch, fmtRelative, fmtTime } from "./api";
import styles from "./FeedTable.module.css";

const REFRESH_MS = 15_000;

export function FeedTable({ limit = 50 }: { limit?: number }) {
  const [data, setData] = useState<FeedResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);

  const load = useCallback(
    () =>
      apiFetch<FeedResponse>(`/api/v1/feed?limit=${limit}`)
        .then((d) => {
          setData(d);
          setError(null);
          setUpdatedAt(Date.now());
        })
        .catch((e: unknown) => {
          setError(e instanceof HttpError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));
        }),
    [limit],
  );

  useEffect(() => {
    void load();
    if (paused) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [load, paused]);

  return (
    <div className="container">
      <div className="pageHead">
        <div>
          <p className="kicker"><span className="live-dot" aria-hidden="true" />records · feed · 15 s</p>
          <h1>Live feed</h1>
          <p className="muted">Anonymised screenings as they happen. Addresses are masked; this is traction proof, not a lookup.</p>
        </div>
        <div className={styles.controls}>
          <span className="muted small" aria-live="polite">
            {updatedAt ? `Updated ${fmtRelative(updatedAt)}` : "Loading…"} · refreshes every 15s
          </span>
          <button type="button" className="btn btnSmall" onClick={() => setPaused((p) => !p)}>
            {paused ? "Resume" : "Pause"}
          </button>
          <button type="button" className="btn btnSmall" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="alert alertError" role="alert">
          Could not load feed: {error}
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Address</th>
                <th>Tier</th>
                <th>Score</th>
                <th>Reasons</th>
                <th>Payer</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {!data && !error && (
                <tr>
                  <td colSpan={7}>
                    <span className="skeleton" />
                  </td>
                </tr>
              )}
              {data && data.items.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    No screenings yet. Run one in the <Link href="/">Explorer</Link>.
                  </td>
                </tr>
              )}
              {data?.items.map((it) => (
                <tr key={it.decisionId}>
                  <td title={fmtTime(it.screenedAt)}>{fmtRelative(it.screenedAt)}</td>
                  <td className="mono">{it.addressMasked}</td>
                  <td>
                    <TierBadge tier={it.tier} size="sm" />
                  </td>
                  <td className="mono">{it.score}</td>
                  <td className={styles.reasons}>
                    {it.reasonCodes.map((c) => (
                      <code key={c}>{c}</code>
                    ))}
                  </td>
                  <td>
                    <span className={`badge ${it.payer === "outside" ? "badgeLOW" : "badgeNeutral"}`}>{it.payer}</span>
                  </td>
                  <td>
                    <Link href={`/log/${encodeURIComponent(it.decisionId)}`} className="mono small">
                      {it.decisionId.length > 14 ? `${it.decisionId.slice(0, 14)}…` : it.decisionId}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="muted small" style={{ marginTop: 8 }}>
        Source: {data?.source ?? "—"}. &quot;own&quot; = our own test wallets (excluded from <Link href="/numbers">Numbers</Link>); &quot;outside&quot; = paid by a wallet we do not control.
      </p>
    </div>
  );
}
