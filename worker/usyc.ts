/**
 * Hourly USYC revenue sweep loop (not for Vercel serverless; use /api/internal/usyc with a cron there).
 * Run: `npx tsx --env-file=.env.local worker/usyc.ts`
 * Default is DRY-RUN (logs the plan to the decision log). Set USYC_MODE=live + REVENUE_PRIVATE_KEY to execute — see docs/USYC.md.
 */
import { runSweepOnce } from "../src/lib/usyc";

const HOUR = 60 * 60 * 1000;
const loop = async () => {
  try { console.log("[usyc]", new Date().toISOString(), await runSweepOnce()); }
  catch (e) { console.error("[usyc] tick failed", (e as Error)?.message); }
  setTimeout(loop, HOUR);
};
loop();
