/**
 * GET /api/v1/report - latest signed daily traction report. Free.
 *   JSON: { date, hash, signature, signer, ledgerId, createdAt, report, archive: [{date, hash, final}] }
 *   ?format=md → text/markdown (the exact text pasted into Discord). 404 until the first report is published.
 */
import { latestReport, listReportDates } from "@/lib/reports";
import { ApiError, handle, ok } from "../../_lib/respond";

export const GET = handle(async (req) => {
  const r = await latestReport();
  if (!r) throw new ApiError("NOT_FOUND", "No report published yet. The agent publishes one per UTC day; see /report.");
  const url = new URL(req.url);
  if (url.searchParams.get("format") === "md") {
    return new Response(r.markdown, { status: 200, headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store", "X-CompliR-Report-Hash": r.hash, "X-CompliR-Report-Signature": r.signature } });
  }
  const archive = await listReportDates(365);
  return ok({ date: r.date, hash: r.hash, signature: r.signature, signer: r.signer, ledgerId: r.ledgerId, createdAt: r.createdAt, report: r.report, archive });
});
