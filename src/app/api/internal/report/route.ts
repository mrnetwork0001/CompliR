/**
 * /api/internal/report — generate + sign + store the daily traction report (Vercel Cron / scheduler; CRON_SECRET).
 *   GET|POST ?date=YYYY-MM-DD (default: today UTC) &force=1 (regenerate; otherwise idempotent per date)
 *   `?date=yesterday` publishes the last complete UTC day (what worker/report.ts does at 00:05 UTC).
 */
import { DATE_RE, publishReport, todayUtc, yesterdayUtc } from "@/lib/reports";
import { installRefundSink } from "@/lib/refunds";

installRefundSink();

async function run(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: { code: "UNAUTHORIZED", message: "missing or invalid CRON_SECRET" } }, { status: 401 });
  }
  const url = new URL(req.url);
  const raw = url.searchParams.get("date")?.trim() || "today";
  const date = raw === "today" ? todayUtc() : raw === "yesterday" ? yesterdayUtc() : raw;
  if (!DATE_RE.test(date)) return Response.json({ error: { code: "VALIDATION_ERROR", message: "date must be YYYY-MM-DD, today or yesterday" } }, { status: 400 });
  const force = /^(1|true|yes)$/i.test(url.searchParams.get("force") ?? "");
  try {
    const r = await publishReport(date, { force });
    return Response.json({ date: r.date, created: r.created, hash: r.hash, signature: r.signature, signer: r.signer, ledgerId: r.ledgerId, final: r.report.period.final, totals: r.report.totals, url: `/api/v1/report/${r.date}` }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    if (/report date|calendar date/.test(message)) return Response.json({ error: { code: "VALIDATION_ERROR", message } }, { status: 400 });
    throw e;
  }
}
export const POST = run;
export const GET = run; // Vercel Cron uses GET
