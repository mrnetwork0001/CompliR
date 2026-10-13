/**
 * GET /api/v1/report/monthly/:period - one signed monthly transparency rollup. Free.
 *   /api/v1/report/monthly/2026-10      → JSON { period, hash, signature, signer, ledgerId, createdAt, report, archive }
 *   /api/v1/report/monthly/2026-10.md   → text/markdown  (also ?format=md)
 *   /api/v1/report/monthly/latest(.md)  → alias for the newest one
 */
import { MONTH_RE, getMonthly, latestMonthly, listMonthlyPeriods } from "@/lib/reports";
import { ApiError, handle, ok } from "../../../../_lib/respond";

type Ctx = { params: Promise<{ period: string }> };

export const GET = handle<Ctx>(async (req, { params }) => {
  const { period: raw } = await params;
  const md = raw.endsWith(".md") || new URL(req.url).searchParams.get("format") === "md";
  const period = raw.replace(/\.(md|json)$/, "");
  if (period !== "latest" && !MONTH_RE.test(period)) {
    throw new ApiError("VALIDATION_ERROR", "Invalid report period", { issues: [{ path: "path.period", message: "expected YYYY-MM, YYYY-MM.md or latest" }] });
  }
  const r = period === "latest" ? await latestMonthly() : await getMonthly(period);
  if (!r) throw new ApiError("NOT_FOUND", period === "latest" ? "No monthly report published yet" : `No monthly report for ${period}`);
  if (md) {
    return new Response(r.markdown, { status: 200, headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store", "X-CompliR-Report-Hash": r.hash, "X-CompliR-Report-Signature": r.signature } });
  }
  return ok({ period: r.period, hash: r.hash, signature: r.signature, signer: r.signer, ledgerId: r.ledgerId, createdAt: r.createdAt, report: r.report, archive: await listMonthlyPeriods(120) });
});
