/**
 * Daily traction-report publisher (not for Vercel serverless; use /api/internal/report with a cron there).
 * Run: `npx tsx --env-file=.env.local worker/report.ts`
 * At 00:05 UTC every day it generates, signs and stores the report for the UTC day that just ended; on start it
 * back-fills yesterday if missing. Also drains the refund queue every 5 minutes so refunds never wait for a human.
 */
import { installRefundSink, processRefunds } from "../src/lib/refunds";
import { getReport, publishReport, yesterdayUtc } from "../src/lib/reports";

installRefundSink();
const REPORT_AT_UTC = { hour: 0, minute: 5 };

function msUntilNextRun(now = Date.now()): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), REPORT_AT_UTC.hour, REPORT_AT_UTC.minute, 0, 0);
  return (next > now ? next : next + 86_400_000) - now;
}

async function publishYesterday(force = false) {
  const date = yesterdayUtc();
  try {
    const r = await publishReport(date, { force });
    console.log(`[report] ${r.created ? "published" : "already published"} ${date} hash=${r.hash} outsidePayers=${r.report.totals.outsidePayers} usdcIn=${r.report.totals.usdcIn} refunds=${r.report.refunds.count}`);
  } catch (e) {
    console.error("[report] publish failed", date, (e as Error)?.message ?? e);
  }
}

const schedule = () => {
  const wait = msUntilNextRun();
  console.log(`[report] next report in ${(wait / 60_000).toFixed(1)} min (00:05 UTC)`);
  setTimeout(async () => { await publishYesterday(true); schedule(); }, wait);
};

(async () => {
  if (!(await getReport(yesterdayUtc()))) await publishYesterday();
  schedule();
  const refundLoop = async () => {
    try { const r = await processRefunds(); if (r.processed) console.log("[refunds]", new Date().toISOString(), r); }
    catch (e) { console.error("[refunds] tick failed", (e as Error)?.message); }
    setTimeout(refundLoop, 5 * 60_000);
  };
  refundLoop();
})();
