/**
 * /api/internal/report - generate + sign + store the daily traction report (Vercel Cron / scheduler; CRON_SECRET).
 *   GET|POST ?date=YYYY-MM-DD (default: today UTC) &force=1 (regenerate; otherwise idempotent per date)
 *   `?date=yesterday` publishes the last complete UTC day (what worker/report.ts does at 00:05 UTC).
 *   ?period=month&month=YYYY-MM|current|previous (default: current) publishes the monthly transparency rollup instead
 *   (`src/lib/reports/monthly.ts`); the daily cron also closes the previous month on its first run of a new month.
 */
import { DATE_RE, MONTH_RE, currentMonthUtc, previousMonthUtc, publishMonthly, publishReport, todayUtc, yesterdayUtc } from "@/lib/reports";
import { installRefundSink } from "@/lib/refunds";

installRefundSink();

async function run(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: { code: "UNAUTHORIZED", message: "missing or invalid CRON_SECRET" } }, { status: 401 });
  }
  const url = new URL(req.url);
  const force = /^(1|true|yes)$/i.test(url.searchParams.get("force") ?? "");
  if (url.searchParams.get("period") === "month") {
    const m = url.searchParams.get("month")?.trim() || "current";
    const month = m === "current" ? currentMonthUtc() : m === "previous" ? previousMonthUtc() : m;
    if (!MONTH_RE.test(month)) return Response.json({ error: { code: "VALIDATION_ERROR", message: "month must be YYYY-MM, current or previous" } }, { status: 400 });
    const r = await publishMonthly(month, { force });
    return Response.json({ period: r.period, created: r.created, hash: r.hash, signature: r.signature, signer: r.signer, ledgerId: r.ledgerId, final: r.report.range.final, verdicts: r.report.verdicts, revenue: r.report.revenue, uptime: r.report.uptime, url: `/api/v1/report/monthly/${r.period}` }, { headers: { "Cache-Control": "no-store" } });
  }
  const raw = url.searchParams.get("date")?.trim() || "today";
  const date = raw === "today" ? todayUtc() : raw === "yesterday" ? yesterdayUtc() : raw;
  if (!DATE_RE.test(date)) return Response.json({ error: { code: "VALIDATION_ERROR", message: "date must be YYYY-MM-DD, today or yesterday" } }, { status: 400 });
  try {
    const r = await publishReport(date, { force });
    if (raw === "yesterday" && date.slice(0, 7) !== todayUtc().slice(0, 7)) await publishMonthly(date.slice(0, 7)).catch((e) => console.warn("[complir/report] monthly rollup failed:", (e as Error)?.message ?? e));
    return Response.json({ date: r.date, created: r.created, hash: r.hash, signature: r.signature, signer: r.signer, ledgerId: r.ledgerId, final: r.report.period.final, totals: r.report.totals, url: `/api/v1/report/${r.date}` }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    if (/report date|calendar date/.test(message)) return Response.json({ error: { code: "VALIDATION_ERROR", message } }, { status: 400 });
    throw e;
  }
}
export const POST = run;
export const GET = run; // Vercel Cron uses GET
