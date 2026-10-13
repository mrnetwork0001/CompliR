/**
 * Long-running USDC blocklist reactor (not for Vercel serverless; use /api/internal/events with a cron there).
 * Run: `npx tsx --env-file=.env.local worker/events.ts`   (interval: EVENTS_TICK_MS, default 20 s)
 *
 * Each tick tails new Arc blocks for Blacklisted/UnBlacklisted on the USDC contract and re-screens every affected
 * address that is watched, on the Trust Map, or screened in the last 30 days — pushing tier.changed webhooks.
 */
import { pollBlocklistEvents } from "../src/lib/events";
import { eventsEnv } from "../src/lib/events/env";

const interval = eventsEnv().tickMs;
let stopping = false;
let lastRateLimited = false; // after a rate limit, wait one extra interval so the public RPC cools down

const loop = async () => {
  const t0 = Date.now();
  try {
    const r = await pollBlocklistEvents();
    const handled = r.handled.map((h) => `${h.address.slice(0, 8)}…${h.address.slice(-4)} ${h.kind} ${h.tierFrom ?? "-"}→${h.tierTo ?? "-"} hooks=${h.webhooks}/${h.watches}`).join(" ");
    if (r.logs || r.error || r.partial || process.env.EVENTS_VERBOSE) {
      console.log(
        `[events] ${new Date().toISOString()} blocks ${r.fromBlock ?? "-"}→${r.toBlock ?? "-"} (${r.blocksScanned}) head=${r.head ?? "-"} logs=${r.logs} handled=${r.handled.length} ignored=${r.ignored} webhooks=${r.webhooks} rpc=${r.rpcCalls}${r.skippedAhead ? " SKIPPED-AHEAD" : ""}${r.partial ? " PARTIAL" : ""}${r.rateLimited ? " RATE-LIMITED" : ""}${r.error ? ` error=${r.error}` : ""} ${r.tookMs}ms${handled ? "  " + handled : ""}`,
      );
    }
    lastRateLimited = r.rateLimited;
  } catch (e) {
    console.error("[events] tick failed", (e as Error)?.message ?? e);
  }
  if (stopping) return;
  setTimeout(loop, Math.max(1_000, interval - (Date.now() - t0)) + (lastRateLimited ? interval : 0));
};

process.on("SIGINT", () => { stopping = true; process.exit(0); });
process.on("SIGTERM", () => { stopping = true; process.exit(0); });
loop();
