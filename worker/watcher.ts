/**
 * Long-running watcher loop (not for Vercel serverless; use /api/internal/watcher with a cron there).
 * Run: `npx tsx --env-file=.env.local worker/watcher.ts`
 */
import { runWatcherOnce } from "../src/lib/watcher";

const loop = async () => {
  try { const r = await runWatcherOnce(); if (r.checked) console.log("[watcher]", new Date().toISOString(), r); }
  catch (e) { console.error("[watcher] tick failed", (e as Error)?.message); }
  setTimeout(loop, 60_000);
};
loop();
