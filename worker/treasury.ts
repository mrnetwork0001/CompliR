/**
 * Long-running treasury-agent loop (not for Vercel serverless; use /api/internal/treasury with a cron there).
 * Run: `npx tsx --env-file=.env.local worker/treasury.ts`
 * Dry-run by default; goes live only with TREASURY_MODE=live + TREASURY_PRIVATE_KEY + GUARDED_TREASURY_ADDRESS + REGISTRY_ADDRESS.
 */
import { runTreasuryOnce, treasuryStatus } from "../src/lib/treasury";

const s = treasuryStatus();
console.log(`[treasury] mode=${s.mode} chain=${s.chainId} treasury=${s.treasuryAddress ?? "-"} agent=${s.agentAddress ?? "-"} policy=${JSON.stringify(s.policy)}`);
if (s.mode !== "live") console.log("[treasury] dry-run; missing for live:", s.missingForLive.join(", "));

const loop = async () => {
  try {
    const r = await runTreasuryOnce();
    if (r.processed) console.log("[treasury]", new Date().toISOString(), r);
  } catch (e) {
    console.error("[treasury] tick failed", (e as Error)?.message);
  }
  setTimeout(loop, 60_000);
};
loop();
