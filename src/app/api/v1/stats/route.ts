/**
 * GET /api/v1/stats - public risk dataset, last 30 UTC days (newest first), each row signed by the attester. Free.
 *   { signer, count, headline, days: [{ date, final, hash, signature, signer, createdAt, stats }] }
 *   ?days=N (1..365) · ?format=csv → the same rows as text/csv (see /api/v1/stats/latest.csv)
 * Verify a row: hash = keccak256(canonical(stats)); viem verifyMessage({ address: signer, message: hash, signature }).
 */
import { headline, listDailyStats, statsCsv } from "@/lib/stats";
import { handle, ok } from "../../_lib/respond";

export const GET = handle(async (req) => {
  const url = new URL(req.url);
  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 30) || 30, 1), 365);
  const rows = await listDailyStats(days);
  if (url.searchParams.get("format") === "csv") {
    return new Response(statsCsv(rows), { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="complir-stats-${days}d.csv"` } });
  }
  return ok({
    signer: rows[0]?.signer ?? null,
    count: rows.length,
    headline: rows[0] ? headline(rows[0].stats) : null,
    days: rows.map((r) => ({ date: r.date, final: r.stats.period.final, hash: r.hash, signature: r.signature, signer: r.signer, createdAt: r.createdAt, stats: r.stats })),
    docs: "/docs#stats",
    csv: "/api/v1/stats/latest.csv",
  });
});
