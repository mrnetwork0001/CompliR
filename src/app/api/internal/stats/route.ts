/**
 * /api/internal/stats - compute + sign + store the public risk dataset row (Vercel Cron 00:10 UTC; CRON_SECRET).
 *   GET|POST ?date=YYYY-MM-DD|today|yesterday (default: today, plus yesterday when its stored row is not final yet)
 *             &force=1 (recompute a final day)
 */
import { DATE_RE, getDailyStats, publishDailyStats, todayUtc, yesterdayUtc } from "@/lib/stats";

async function run(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: { code: "UNAUTHORIZED", message: "missing or invalid CRON_SECRET" } }, { status: 401 });
  }
  const url = new URL(req.url);
  const raw = url.searchParams.get("date")?.trim() || "today";
  const force = /^(1|true|yes)$/i.test(url.searchParams.get("force") ?? "");
  const dates = raw === "today" ? [todayUtc()] : raw === "yesterday" ? [yesterdayUtc()] : [raw];
  if (raw === "today") {
    const y = await getDailyStats(yesterdayUtc());
    if (!y || !y.stats.period.final) dates.push(yesterdayUtc()); // close out the previous day on the first run after midnight
  }
  if (dates.some((d) => !DATE_RE.test(d))) return Response.json({ error: { code: "VALIDATION_ERROR", message: "date must be YYYY-MM-DD, today or yesterday" } }, { status: 400 });
  try {
    const out = [];
    for (const date of dates) {
      const r = await publishDailyStats(date, { force });
      out.push({ date: r.date, created: r.created, final: r.stats.period.final, hash: r.hash, signature: r.signature, signer: r.signer, graded: r.stats.graded.addresses, observed: r.stats.observed.wallets, volumeUsdc: r.stats.volume.usdc, flaggedShare: r.stats.volume.flaggedShare, url: `/api/v1/stats/${r.date}` });
    }
    return Response.json({ rows: out }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    if (/stats date|calendar date/.test(message)) return Response.json({ error: { code: "VALIDATION_ERROR", message } }, { status: 400 });
    throw e;
  }
}
export const POST = run;
export const GET = run; // Vercel Cron uses GET
