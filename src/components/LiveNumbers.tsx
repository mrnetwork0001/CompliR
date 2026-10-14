"use client";

import Link from "next/link";
import { fmtUsdc } from "./api";
import { usePublicStats } from "./usePublicStats";
import styles from "./LiveNumbers.module.css";

/**
 * Three honest counters from /api/v1/numbers (screenings, outside payers, USDC paid).
 * Polls live (every 10 s while visible). Graceful zeros: if the API is unreachable we show 0s, never a broken strip.
 */
export function LiveNumbers({ compact = false }: { compact?: boolean }) {
  const { stats, error } = usePublicStats();
  const loading = !stats && !error;
  const v = (n: number | undefined) => (loading ? null : (n ?? 0).toLocaleString());

  const items: { label: string; value: string | null }[] = [
    { label: "Screenings", value: v(stats?.screenings) },
    { label: "Outside payers", value: v(stats?.outsidePayers) },
    { label: "USDC paid", value: loading ? null : fmtUsdc(stats?.totalPaidUsdc ?? 0) },
  ];

  return (
    <div className={`${styles.strip} ${compact ? styles.compact : ""}`} aria-live="polite">
      {items.map((it) => (
        <div key={it.label} className={styles.stat}>
          <span className={styles.value}>{it.value === null ? <span className="skeleton" style={{ width: 64, height: "1.2em" }} /> : it.value}</span>
          <span className={styles.label}>{it.label}</span>
        </div>
      ))}
      <div className={`${styles.note} muted small`}>
        Own wallets excluded{stats?.ownWalletsExcluded ? " (confirmed by the API)" : ""}. <Link href="/numbers">All numbers →</Link>
      </div>
    </div>
  );
}
