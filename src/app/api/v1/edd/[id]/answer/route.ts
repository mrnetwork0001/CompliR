/**
 * POST /api/v1/edd/:id/answer - the counterparty answers the EDD questions. Public, one answer per request
 * (a second submission gets 409). Body: { answers: string[] (same length as questions, each ≤ 1000 chars), contact?: email }.
 * Stores the answers privately, logs keccak(answers) to the decision log, then re-screens the subject.
 */
import { z } from "zod";
import { answerEdd, getEddRequest, EddError, MAX_EDD_ANSWER_CHARS } from "@/lib/edd";
import { ApiError, handle, ok } from "../../../../_lib/respond";
import { parseJson } from "../../../../_lib/parse";

type Ctx = { params: Promise<{ id: string }> };

const AnswerSchema = z.object({
  answers: z.array(z.string().trim().min(1).max(MAX_EDD_ANSWER_CHARS)).min(1).max(10),
  contact: z.string().trim().email().max(200).optional(),
});

export const POST = handle<Ctx>(async (req, { params }) => {
  const { id } = await params;
  if (!/^edd_[0-9a-f]{8,64}$/.test(id)) throw new ApiError("VALIDATION_ERROR", "Invalid EDD id");
  const existing = await getEddRequest(id);
  if (!existing) throw new ApiError("NOT_FOUND", `No EDD request ${id}`);
  if (existing.status !== "OPEN") throw new ApiError("VALIDATION_ERROR", "This request has already been answered", { reason: "ALREADY_ANSWERED" }, 409);
  const body = await parseJson(req, AnswerSchema);
  if (body.answers.length !== existing.questions.length) {
    throw new ApiError("VALIDATION_ERROR", `Expected ${existing.questions.length} answers`, { issues: [{ path: "answers", message: `got ${body.answers.length}` }] });
  }
  try {
    const result = await answerEdd(id, body.answers, body.contact);
    return ok(result);
  } catch (e) {
    if (e instanceof EddError) {
      if (e.code === "ALREADY_ANSWERED") throw new ApiError("VALIDATION_ERROR", e.message, { reason: "ALREADY_ANSWERED" }, 409);
      if (e.code === "NOT_FOUND") throw new ApiError("NOT_FOUND", e.message);
      throw new ApiError("VALIDATION_ERROR", e.message);
    }
    throw e;
  }
});
