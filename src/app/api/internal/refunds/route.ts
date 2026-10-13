/**
 * /api/internal/refunds — refund queue, protected by `Authorization: Bearer $CRON_SECRET`.
 *   GET  → one processing tick, then {status, refunds}            (Vercel Cron uses GET)
 *   POST {}                                             → tick
 *   POST {payer, amountUsdc, reason, originalTx?}       → human-initiated refund, queued + tick
 *   POST {requeue: "<refund id>"}                        → put a DRY_RUN / FAILED refund back in the queue + tick
 */
import { z } from "zod";
import { installRefundSink, listRefunds, processRefunds, queueRefund, refundStatus, requeueRefund, RefundInputError } from "@/lib/refunds";

installRefundSink();

const ManualSchema = z.object({
  payer: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  amountUsdc: z.union([z.number().positive(), z.string().regex(/^\d+(\.\d{1,6})?$/)]),
  reason: z.string().trim().min(3).max(500),
  originalTx: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  endpoint: z.string().max(200).optional(),
});
const RequeueSchema = z.object({ requeue: z.string().regex(/^ref_[a-z0-9]+$/) });

function unauthorized(req: Request): Response | null {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: { code: "UNAUTHORIZED", message: "missing or invalid CRON_SECRET" } }, { status: 401 });
  }
  return null;
}
async function view(extra: Record<string, unknown> = {}): Promise<Response> {
  return Response.json({ ...extra, status: await refundStatus(), refunds: await listRefunds({ limit: 200 }) }, { headers: { "Cache-Control": "no-store" } });
}

export async function GET(req: Request): Promise<Response> {
  const denied = unauthorized(req);
  if (denied) return denied;
  const tick = await processRefunds();
  return view({ tick });
}

export async function POST(req: Request): Promise<Response> {
  const denied = unauthorized(req);
  if (denied) return denied;
  let body: unknown = {};
  try { const t = await req.text(); body = t.trim() ? JSON.parse(t) : {}; } catch { return Response.json({ error: { code: "INVALID_JSON", message: "body must be JSON" } }, { status: 400 }); }
  try {
    const requeue = RequeueSchema.safeParse(body);
    if (requeue.success) {
      const r = await requeueRefund(requeue.data.requeue);
      if (!r) return Response.json({ error: { code: "NOT_FOUND", message: `no refund ${requeue.data.requeue}` } }, { status: 404 });
      return view({ requeued: r, tick: await processRefunds() });
    }
    if (body && typeof body === "object" && Object.keys(body as object).length) {
      const parsed = ManualSchema.safeParse(body);
      if (!parsed.success) return Response.json({ error: { code: "VALIDATION_ERROR", message: "expected {payer, amountUsdc, reason, originalTx?}", details: parsed.error.flatten() } }, { status: 400 });
      const q = await queueRefund({ ...parsed.data, source: "manual" });
      return view({ queued: q.refund, created: q.created, tick: await processRefunds() });
    }
    return view({ tick: await processRefunds() });
  } catch (e) {
    if (e instanceof RefundInputError) return Response.json({ error: { code: "VALIDATION_ERROR", message: e.message } }, { status: 400 });
    throw e;
  }
}
