/**
 * Long-running Trust Map tailer loop (not for Vercel serverless; use /api/internal/trustmap with a cron there).
 * Run: `npx tsx --env-file=.env.local worker/trustmap.ts`   (interval: TRUSTMAP_TICK_MS, default 30 s)
 */
import { tailOnce } from "../src/lib/trustmap/tailer";
import { trustmapEnv } from "../src/lib/trustmap/env";

const interval = trustmapEnv().tickMs;
let stopping = false;
let lastRateLimited = false; // after a rate limit, wait one extra interval so the public RPC cools down

const loop = async () => {
  const t0 = Date.now();
  try {
    const r = await tailOnce();
    const graded = r.gradedNodes.map((g) => `${g.address.slice(0, 8)}…${g.address.slice(-4)}=${g.tier}${g.changed ? `(was ${g.prevTier})` : ""}`).join(" ");
    console.log(
      `[trustmap] ${new Date().toISOString()} blocks ${r.fromBlock ?? "-"}→${r.toBlock ?? "-"} (${r.blocksScanned}) logs=${r.logs} recipients=${r.recipients} candidates=${r.candidates} graded=${r.graded} skipped[recent=${r.skippedRecent} contract=${r.skippedContracts} budget=${r.skippedBudget}] changes=${r.tierChanges} edges=${r.edges} rpc=${r.rpcCalls}${r.partial ? " PARTIAL" : ""}${r.rateLimited ? " RATE-LIMITED" : ""} ${r.tookMs}ms${graded ? "  " + graded : ""}`,
    );
    for (const f of r.failures) console.warn("[trustmap] grade failed", f.address, f.error);
    lastRateLimited = r.rateLimited;
  } catch (e) {
    console.error("[trustmap] tick failed", (e as Error)?.message ?? e);
  }
  if (stopping) return;
  setTimeout(loop, Math.max(1_000, interval - (Date.now() - t0)) + (lastRateLimited ? interval : 0));
};

process.on("SIGINT", () => { stopping = true; process.exit(0); });
process.on("SIGTERM", () => { stopping = true; process.exit(0); });
loop();
