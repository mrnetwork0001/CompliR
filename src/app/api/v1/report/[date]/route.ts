/**
 * GET /api/v1/report/:date - one signed daily report. Free.
 *   /api/v1/report/2026-10-13      → JSON { date, hash, signature, signer, ledgerId, createdAt, report }
 *   /api/v1/report/2026-10-13.md   → text/markdown  (also ?format=md)
 *   /api/v1/report/latest(.md)     → alias for the newest one
 */
import { DATE_RE, getReport, latestReport } from "@/lib/reports";
import { ApiError, handle, ok } from "../../../_lib/respond";

type Ctx = { params: Promise<{ date: string }> };

export const GET = handle<Ctx>(async (req, { params }) => {
  const { date: raw } = await params;
  const md = raw.endsWith(".md") || new URL(req.url).searchParams.get("format") === "md";
  const date = raw.replace(/\.(md|json)$/, "");
  if (date !== "latest" && !DATE_RE.test(date)) {
    throw new ApiError("VALIDATION_ERROR", "Invalid report date", { issues: [{ path: "path.date", message: "expected YYYY-MM-DD, YYYY-MM-DD.md or latest" }] });
  }
  const r = date === "latest" ? await latestReport() : await getReport(date);
  if (!r) throw new ApiError("NOT_FOUND", date === "latest" ? "No report published yet" : `No report for ${date}`);
  if (md) {
    return new Response(r.markdown, { status: 200, headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store", "X-CompliR-Report-Hash": r.hash, "X-CompliR-Report-Signature": r.signature } });
  }
  return ok({ date: r.date, hash: r.hash, signature: r.signature, signer: r.signer, ledgerId: r.ledgerId, createdAt: r.createdAt, report: r.report });
});
