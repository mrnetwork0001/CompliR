/**
 * GET /api/v1/stats/:date - one signed daily row, or the flat CSV. Free.
 *   /api/v1/stats/2026-10-13(.json)  → { date, final, hash, signature, signer, createdAt, headline, stats }
 *   /api/v1/stats/latest(.json)      → newest row
 *   /api/v1/stats/latest.csv         → every stored day (newest first, up to 365) as text/csv for analysts
 *   /api/v1/stats/2026-10-13.csv     → that one day as CSV (header + 1 row)
 */
import { DATE_RE, getDailyStats, headline, latestDailyStats, listDailyStats, statsCsv } from "@/lib/stats";
import { ApiError, handle, ok } from "../../../_lib/respond";

type Ctx = { params: Promise<{ date: string }> };

export const GET = handle<Ctx>(async (_req, { params }) => {
  const { date: raw } = await params;
  const csv = raw.endsWith(".csv");
  const date = raw.replace(/\.(csv|json)$/, "");
  if (date !== "latest" && !DATE_RE.test(date)) {
    throw new ApiError("VALIDATION_ERROR", "Invalid stats date", { issues: [{ path: "path.date", message: "expected YYYY-MM-DD, YYYY-MM-DD.json, YYYY-MM-DD.csv, latest, latest.json or latest.csv" }] });
  }
  if (csv && date === "latest") {
    const rows = await listDailyStats(365);
    return new Response(statsCsv(rows), { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="complir-stats.csv"` } });
  }
  const r = date === "latest" ? await latestDailyStats() : await getDailyStats(date);
  if (!r) throw new ApiError("NOT_FOUND", date === "latest" ? "No stats published yet. The agent computes one row per UTC day; see /stats." : `No stats for ${date}`);
  if (csv) {
    return new Response(statsCsv([r]), { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store", "X-CompliR-Stats-Hash": r.hash, "X-CompliR-Stats-Signature": r.signature } });
  }
  return ok({ date: r.date, final: r.stats.period.final, hash: r.hash, signature: r.signature, signer: r.signer, createdAt: r.createdAt, headline: headline(r.stats), stats: r.stats });
});
