/**
 * POST /api/v1/check/invoice - multipart `file` (PDF, ≤ 5 MB). Extracts text server-side and returns the addresses, a best-effort
 * vendor name and the total. Nothing is stored. Free; same-origin or 20/min per IP.
 */
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { isSameOriginBrowser } from "@/lib/payments";
import { extractFromInvoiceText } from "@/lib/check/extract";
import { TokenBucket, clientIp } from "@/lib/check/ratelimit";
import { ApiError, handle, ok } from "../../../_lib/respond";

const MAX_BYTES = 5 * 1024 * 1024;
const bucket = new TokenBucket(20, 60_000);

export const POST = handle(async (req: Request) => {
  if (!isSameOriginBrowser(req)) {
    const t = bucket.take(clientIp(req));
    if (!t.ok) throw new ApiError("VALIDATION_ERROR", "Rate limit: 20 uploads per minute per IP.", { retryAfterMs: t.retryAfterMs }, 429);
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new ApiError("VALIDATION_ERROR", "Send multipart/form-data with a `file` field.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw new ApiError("VALIDATION_ERROR", "Missing `file` (PDF).");
  if (file.size > MAX_BYTES) throw new ApiError("VALIDATION_ERROR", "PDF larger than 5 MB.");
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new ApiError("VALIDATION_ERROR", "Not a PDF.");
  let text = "";
  let pages = 0;
  try {
    const parsed = await pdfParse(buf, { max: 20 });
    text = parsed.text ?? "";
    pages = parsed.numpages ?? 0;
  } catch (e) {
    throw new ApiError("VALIDATION_ERROR", `Could not read the PDF: ${(e as Error)?.message ?? "unknown error"}`);
  }
  const x = extractFromInvoiceText(text);
  return ok({ fileName: file.name, bytes: file.size, pages, chars: text.length, ...x, snippet: text.replace(/\s+/g, " ").trim().slice(0, 280) });
});
