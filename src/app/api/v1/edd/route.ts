/**
 * POST /api/v1/edd — open an Enhanced Due Diligence request for a counterparty (spec C14).
 * Internal only: `Authorization: Bearer $CRON_SECRET` or a same-origin browser call (sec-fetch-site: same-origin).
 * Body: { subject, decisionId, questions[] }. Response: { id, url, status: "OPEN" }.
 */
import { z } from "zod";
import { AddressSchema } from "@/lib/types";
import { createEddRequest, MAX_EDD_QUESTIONS } from "@/lib/edd";
import { isInternalCaller } from "@/lib/edd/auth";
import { ApiError, handle, ok } from "../../_lib/respond";
import { parseJson } from "../../_lib/parse";

const CreateEddSchema = z.object({
  subject: AddressSchema,
  decisionId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/, "expected dec_<id>"),
  questions: z.array(z.string().trim().min(1).max(500)).min(1).max(MAX_EDD_QUESTIONS),
});

export const POST = handle(async (req) => {
  if (!isInternalCaller(req)) {
    throw new ApiError("VALIDATION_ERROR", "EDD requests can only be opened by CompliR itself (CRON_SECRET or same-origin)", { reason: "UNAUTHORIZED" }, 401);
  }
  const body = await parseJson(req, CreateEddSchema);
  const { id, url } = await createEddRequest(body);
  return ok({ id, url, status: "OPEN" }, { status: 201 });
});
