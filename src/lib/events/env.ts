/**
 * Event reactor tunables. Read straight from process.env (config.ts is owned by the lead). All optional:
 *
 *   # ── Event-driven tier changes (USDC blocklist reactor; worker/events.ts or POST /api/internal/events) ──
 *   # EVENTS_TICK_MS=20000        # worker loop interval
 *   # EVENTS_MAX_BLOCKS=500       # blocks polled per tick (Arc ≈ 2 blocks/s → 500 ≈ 4 min of chain)
 *   # EVENTS_MAX_LAG=5000         # cursor further behind head than this → skip ahead (live reactor, not an indexer)
 *   # EVENTS_RPC_BUDGET=12        # max RPC calls per tick (getBlockNumber + getLogs incl. bisection)
 *   # EVENTS_SCREENED_DAYS=30     # an address screened by anyone within this window is re-screened on an event
 */
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) ? n : d;
};

export function eventsEnv() {
  const e = process.env;
  return {
    tickMs: Math.max(5_000, num(e.EVENTS_TICK_MS, 20_000)),
    maxBlocks: Math.max(1, Math.floor(num(e.EVENTS_MAX_BLOCKS, 500))),
    maxLag: Math.max(1, Math.floor(num(e.EVENTS_MAX_LAG, 5_000))),
    rpcBudget: Math.max(2, Math.floor(num(e.EVENTS_RPC_BUDGET, 12))),
    screenedDays: Math.max(1, num(e.EVENTS_SCREENED_DAYS, 30)),
  };
}
