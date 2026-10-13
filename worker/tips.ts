/**
 * Long-running Tip Market loop: every 5 minutes verify SUBMITTED tips and pay VERIFIED ones.
 * (Not for Vercel serverless; there use a cron → /api/internal/tips.)
 * Run: `npx tsx --env-file=.env.local worker/tips.ts`
 */
import { runTipsOnce } from "../src/lib/tips";

const EVERY_MS = 5 * 60_000;

const loop = async () => {
  try {
    const r = await runTipsOnce();
    if (r.results.length) console.log("[tips]", new Date().toISOString(), { mode: r.payoutMode, verified: r.verified, rejected: r.rejected, needsReview: r.needsReview, paid: r.paid, deferred: r.deferred, dropped: r.dropped, failed: r.failed });
  } catch (e) {
    console.error("[tips] tick failed", (e as Error)?.message);
  }
  setTimeout(loop, EVERY_MS);
};
loop();
