"use client";

import { useEffect, useState } from "react";
import type { PublicStats } from "@/app/api/_lib/public-types";
import { HttpError, apiFetch } from "./api";

/** How often the public counters re-poll /api/v1/numbers while the tab is visible. */
export const NUMBERS_REFRESH_MS = 10_000;

export type PublicStatsState = { stats: PublicStats | null; error: string | null; updatedAt: number | null };

/**
 * Live public counters: fetches /api/v1/numbers on mount, every NUMBERS_REFRESH_MS while the tab is visible,
 * and immediately when the tab becomes visible again. A failed poll keeps the last good numbers on screen.
 */
export function usePublicStats(): PublicStatsState {
  const [state, setState] = useState<PublicStatsState>({ stats: null, error: null, updatedAt: null });

  useEffect(() => {
    let alive = true;
    let inFlight = false;
    const load = () => {
      if (inFlight) return;
      inFlight = true;
      apiFetch<PublicStats>("/api/v1/numbers")
        .then((stats) => alive && setState({ stats, error: null, updatedAt: Date.now() }))
        .catch((e) => alive && setState((s) => ({ ...s, error: e instanceof HttpError ? `${e.code}: ${e.message}` : String(e) })))
        .finally(() => { inFlight = false; });
    };
    load();
    const id = setInterval(() => { if (document.visibilityState === "visible") load(); }, NUMBERS_REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return state;
}
