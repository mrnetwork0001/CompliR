/**
 * Hourly revenue-yield loop (not for Vercel serverless; use /api/internal/usyc with a cron there).
 * Run: `npx tsx --env-file=.env.local worker/usyc.ts`
 * Default backend is Circle Earn (Morpho USDC vaults on Arc); YIELD_BACKEND=usyc runs the legacy USYC Teller sweep.
 * Dry-run (logs the plan) unless YIELD_MODE=live - see docs/YIELD.md.
 */
import { runRevenueYieldOnce } from "../src/lib/earn";

const HOUR = 60 * 60 * 1000;
const loop = async () => {
  try { console.log("[yield]", new Date().toISOString(), JSON.stringify(await runRevenueYieldOnce())); }
  catch (e) { console.error("[yield] tick failed", (e as Error)?.message); }
  setTimeout(loop, HOUR);
};
loop();
