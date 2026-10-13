"use client";

/**
 * Client-side data for the console. Every endpoint is fetched independently and degrades to null
 * (a 404 on /report, a 503 on /health, a cold sqlite) — the page always renders, with skeletons then zeros.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanyResponse } from "@/app/api/v1/company/route";
import type { PayoutsResponse } from "@/app/api/v1/payouts/route";
import type { TipsResponse } from "@/app/api/v1/tips/route";
import type { MapSnapshot } from "@/lib/trustmap/types";
import type { DecisionLogEntry } from "@/lib/types";
import type { FeedResponse, HealthResponse, LedgerListResponse, LedgerVerifyResponse, PublicStats } from "@/app/api/_lib/public-types";
import { apiFetch } from "@/components/api";

export interface ReportLite {
  date: string;
  hash: string;
  signer: string;
  createdAt: number;
  archive: { date: string; hash: string; final: boolean }[];
  report?: { period?: { final?: boolean } };
}

export interface ConsoleData {
  health: HealthResponse | null;
  company: CompanyResponse | null;
  numbers: PublicStats | null;
  map: MapSnapshot["stats"] | null;
  payouts: Pick<PayoutsResponse, "mode" | "totals"> | null;
  verify: LedgerVerifyResponse | null;
  tips: Pick<TipsResponse, "totals" | "config"> | null;
  /** null = no report published yet (404) or unreachable */
  report: ReportLite | null;
  feed: FeedResponse | null;
  /** first round of fetches has settled */
  ready: boolean;
  updatedAt: number | null;
}

const EMPTY: ConsoleData = { health: null, company: null, numbers: null, map: null, payouts: null, verify: null, tips: null, report: null, feed: null, ready: false, updatedAt: null };

const quiet = <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

/** /health answers 503 with a useful body when env is broken; read the body regardless of status. */
async function fetchHealth(): Promise<HealthResponse | null> {
  try {
    const r = await fetch("/api/v1/health", { cache: "no-store", headers: { Accept: "application/json" } });
    return (await r.json()) as HealthResponse;
  } catch {
    return null;
  }
}

export const CONSOLE_REFRESH_MS = 30_000;
export const TICKER_REFRESH_MS = 20_000;

export function useConsoleData(): ConsoleData & { reload: () => void } {
  const [data, setData] = useState<ConsoleData>(EMPTY);
  const alive = useRef(true);

  const load = useCallback(async () => {
    const [health, company, numbers, map, payouts, verify, tips, report, feed] = await Promise.all([
      fetchHealth(),
      quiet(apiFetch<CompanyResponse>("/api/v1/company")),
      quiet(apiFetch<PublicStats>("/api/v1/numbers")),
      quiet(apiFetch<MapSnapshot>("/api/v1/map?limit=1")),
      quiet(apiFetch<PayoutsResponse>("/api/v1/payouts")),
      quiet(apiFetch<LedgerVerifyResponse>("/api/v1/ledger/verify")),
      quiet(apiFetch<TipsResponse>("/api/v1/tips")),
      quiet(apiFetch<ReportLite>("/api/v1/report")),
      quiet(apiFetch<FeedResponse>("/api/v1/feed?limit=1")),
    ]);
    if (!alive.current) return;
    setData({
      health,
      company,
      numbers,
      map: map?.stats ?? null,
      payouts: payouts ? { mode: payouts.mode, totals: payouts.totals } : null,
      verify,
      tips: tips ? { totals: tips.totals, config: tips.config } : null,
      report,
      feed,
      ready: true,
      updatedAt: Date.now(),
    });
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, CONSOLE_REFRESH_MS);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, [load]);

  return { ...data, reload: () => void load() };
}

/** Last N ledger entries, refreshed every 20 s while the tab is visible. */
export function useTicker(limit = 5): { entries: DecisionLogEntry[] | null; at: number | null } {
  const [state, setState] = useState<{ entries: DecisionLogEntry[] | null; at: number | null }>({ entries: null, at: null });
  useEffect(() => {
    let alive = true;
    const tick = () =>
      apiFetch<LedgerListResponse>(`/api/v1/ledger?limit=${limit}`)
        .then((r) => alive && setState({ entries: r.entries, at: Date.now() }))
        .catch(() => alive && setState((s) => ({ entries: s.entries ?? [], at: Date.now() })));
    void tick();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void tick();
    }, TICKER_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [limit]);
  return state;
}

/** A clock that re-renders every `ms` so relative times ("3 min ago") stay honest between refreshes. */
export function useNow(ms = 10_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
