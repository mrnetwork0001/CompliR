/**
 * Long-running operator loop (not for Vercel serverless; use /api/internal/operator with a cron there).
 * Run: `npx tsx --env-file=.env.local worker/operator.ts`
 * Each tick: snapshot → decide → execute (treasury / USYC / pricing, each in its own dry-run or live mode) → one
 * OPERATOR ledger entry. Honours the plan's nextCheckAt (clamped to [15 min, 6 h]); defaults to 1 h after a failure.
 */
import { NEXT_CHECK_DEFAULT_S, NEXT_CHECK_MAX_S, NEXT_CHECK_MIN_S, runOperatorOnce } from "../src/lib/operator";

const loop = async () => {
  let waitS = NEXT_CHECK_DEFAULT_S;
  try {
    const t = await runOperatorOnce();
    const acts = t.results.map((r) => `${r.action.type}${r.ok ? "" : " (failed)"}`).join(", ") || "HOLD";
    console.log(`[operator] ${new Date().toISOString()} seq=${t.entry.seq} ${acts} · ${t.plan.meta.fallback ? "fallback" : t.plan.meta.model} · next ${new Date(t.nextCheckAt * 1000).toISOString()}`);
    console.log(`[operator] ${t.plan.rationale}`);
    waitS = Math.max(NEXT_CHECK_MIN_S, Math.min(NEXT_CHECK_MAX_S, t.nextCheckAt - Math.floor(Date.now() / 1000)));
  } catch (e) {
    console.error("[operator] tick failed", (e as Error)?.message);
  }
  setTimeout(loop, waitS * 1000);
};
loop();
