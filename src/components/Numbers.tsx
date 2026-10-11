"use client";

import { useEffect, useState } from "react";
import type { PublicStats } from "@/app/api/_lib/public-types";
import { HttpError, apiFetch, fmtTime, fmtUsdc } from "./api";
import styles from "./Numbers.module.css";

function Stat({ label, value, hint }: { label: string; value: string | number | null; hint?: string }) {
  return (
    <div className={`card ${styles.stat}`}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{value === null ? <span className="skeleton" style={{ width: 80, height: "1.4em" }} /> : value}</span>
      {hint && <span className="muted small">{hint}</span>}
    </div>
  );
}

export function Numbers() {
  const [stats, setStats] = useState<PublicStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    apiFetch<PublicStats>("/api/v1/numbers")
      .then((s) => alive && setStats(s))
      .catch((e) => alive && setError(e instanceof HttpError ? `${e.code}: ${e.message}` : String(e)));
    return () => {
      alive = false;
    };
  }, []);

  const n = (k: keyof PublicStats) => (stats ? (stats[k] as number).toLocaleString() : null);

  return (
    <div className="container">
      <div className="pageHead">
        <div>
          <p className="kicker">records · numbers · GET /api/v1/numbers</p>
          <h1>Numbers</h1>
          <p className="muted">Public and honest. Calls from our own test wallets are excluded from every counter below.</p>
        </div>
      </div>

      {error && (
        <div className="alert alertError" role="alert">
          Could not load numbers: {error}
        </div>
      )}

      <div className={styles.grid}>
        <Stat label="Screenings" value={n("screenings")} hint="POST /v1/screen calls, own wallets excluded" />
        <Stat label="Distinct clients" value={n("distinctClients")} hint="unique payer / API client ids" />
        <Stat label="Outside payers" value={n("outsidePayers")} hint="wallets we do not control that paid via x402" />
        <Stat label="USDC paid" value={stats ? fmtUsdc(stats.totalPaidUsdc) : null} hint="gross x402 revenue, before refunds" />
        <Stat label="Refunds" value={n("refunds")} hint="paid calls we refunded (errors, pauses)" />
        <Stat label="Active watches" value={n("watchesActive")} hint="addresses under adaptive re-screening" />
      </div>

      <div className={`alert alertInfo ${styles.note}`}>
        <strong>Own wallets excluded.</strong> {stats?.ownWalletsExcluded === true ? "Confirmed by the API (ownWalletsExcluded: true)." : "The API flags this explicitly in every response."} Counting since{" "}
        {stats ? fmtTime(stats.since) : "…"}. Raw JSON: <a href="/api/v1/numbers" target="_blank" rel="noopener noreferrer" className="mono">/api/v1/numbers</a>
      </div>
    </div>
  );
}
