/**
 * Enhanced Due Diligence (EDD) answer flow — spec C14.
 *
 * MEDIUM/HIGH verdicts carry `eddRequested: string[]` (questions written by the Risk Analyst). The pipeline (or an
 * operator) opens an EDD request for the counterparty, who answers it on the public page `/edd/<id>`. The answers are
 * stored privately; the hash-chained decision log only receives `answersHash` (keccak256 over the canonical answers),
 * so the log proves what was said without publishing it. Answering triggers a RESCREEN and the new decision id + tier
 * are recorded on the request.
 *
 * Storage: `edd_requests` (src/lib/store/db.ts). `response` is JSON: { answers, contact, answersHash, answeredAt, rescreen }.
 */
import { db, migrate } from "../store";
import { maskAddress } from "../store";
import { appendDecision, getDecision } from "../ledger";
import { decisionHash } from "../attest/canonical";
import { config } from "../config";
import { screen } from "../pipeline";
import type { Address, Tier } from "../types";

export type EddStatus = "OPEN" | "ANSWERED" | "REVIEWED";

export interface EddRescreen {
  decisionId: string;
  tier: Tier;
  /** tier of the decision that raised the EDD (null when it could not be loaded) */
  previousTier: Tier | null;
  changed: boolean;
  score: number;
}
export interface EddResponse {
  answers: string[];
  contact: string | null;
  answersHash: `0x${string}`;
  answeredAt: number;
  /** null until the re-screen completes; `error` set when it failed */
  rescreen: EddRescreen | null;
  rescreenError?: string;
  ledgerEntryId: string | null;
}
export interface EddRequest {
  id: string;
  subject: Address;
  decisionId: string;
  questions: string[];
  status: EddStatus;
  createdAt: number;
  answeredAt: number | null;
  /** private — never return from a public route */
  response: EddResponse | null;
}
/** What the public GET route / page may show: no answers, no contact, masked subject. */
export interface EddPublicView {
  id: string;
  subjectMasked: string;
  decisionId: string;
  questions: string[];
  status: EddStatus;
  createdAt: string;
  answeredAt: string | null;
  rescreen: EddRescreen | null;
  ledgerEntryId: string | null;
  url: string;
}

export const MAX_EDD_ANSWER_CHARS = 1000;
export const MAX_EDD_QUESTIONS = 10;

export class EddError extends Error {
  constructor(readonly code: "NOT_FOUND" | "ALREADY_ANSWERED" | "VALIDATION", message: string) {
    super(message);
    this.name = "EddError";
  }
}

const now = () => Math.floor(Date.now() / 1000);
const iso = (unix: number) => new Date(unix * 1000).toISOString();

export function newEddId(): string {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
  return `edd_${rand}`;
}
export function eddUrl(id: string): string {
  return `${config().PUBLIC_BASE_URL.replace(/\/$/, "")}/edd/${id}`;
}
/** keccak256 over canonical JSON of {eddId, answers}. The eddId salts the hash so identical short answers differ per request. */
export function answersHash(eddId: string, answers: string[]): `0x${string}` {
  return decisionHash({ eddId, answers });
}

function rowToRequest(r: Record<string, unknown>): EddRequest {
  return {
    id: String(r.id),
    subject: String(r.subject).toLowerCase() as Address,
    decisionId: String(r.decision_id),
    questions: JSON.parse(String(r.questions)),
    status: String(r.status) as EddStatus,
    createdAt: Number(r.created_at),
    answeredAt: r.answered_at == null ? null : Number(r.answered_at),
    response: r.response == null ? null : (JSON.parse(String(r.response)) as EddResponse),
  };
}

export async function createEddRequest(input: { subject: Address | string; decisionId: string; questions: string[] }): Promise<{ id: string; url: string }> {
  const questions = input.questions.map((q) => String(q).trim()).filter(Boolean).slice(0, MAX_EDD_QUESTIONS);
  if (questions.length === 0) throw new EddError("VALIDATION", "at least one question is required");
  await migrate();
  const id = newEddId();
  await db().execute({
    sql: `INSERT INTO edd_requests (id, subject, decision_id, questions, response, status, created_at, answered_at) VALUES (?,?,?,?,NULL,'OPEN',?,NULL)`,
    args: [id, String(input.subject).toLowerCase(), input.decisionId, JSON.stringify(questions), now()],
  });
  return { id, url: eddUrl(id) };
}

export async function getEddRequest(id: string): Promise<EddRequest | null> {
  await migrate();
  const r = await db().execute({ sql: `SELECT * FROM edd_requests WHERE id = ?`, args: [id] });
  return r.rows[0] ? rowToRequest(r.rows[0] as Record<string, unknown>) : null;
}

export function toPublicView(r: EddRequest): EddPublicView {
  return {
    id: r.id,
    subjectMasked: maskAddress(r.subject),
    decisionId: r.decisionId,
    questions: r.questions,
    status: r.status,
    createdAt: iso(r.createdAt),
    answeredAt: r.answeredAt == null ? null : iso(r.answeredAt),
    rescreen: r.response?.rescreen ?? null,
    ledgerEntryId: r.response?.ledgerEntryId ?? null,
    url: eddUrl(r.id),
  };
}

export async function listOpenEdd(limit = 50): Promise<EddRequest[]> {
  await migrate();
  const r = await db().execute({ sql: `SELECT * FROM edd_requests WHERE status = 'OPEN' ORDER BY created_at DESC LIMIT ?`, args: [Math.min(Math.max(limit, 1), 500)] });
  return r.rows.map((x) => rowToRequest(x as Record<string, unknown>));
}

export interface AnswerResult {
  id: string;
  status: EddStatus;
  answersHash: `0x${string}`;
  ledgerEntryId: string;
  rescreen: EddRescreen | null;
  rescreenError?: string;
}

/**
 * Store the answers (one shot — a second answer is rejected), log the hash, then re-screen the subject.
 * The claim `UPDATE … WHERE status='OPEN'` is atomic, so concurrent double-submits cannot both succeed.
 */
export async function answerEdd(id: string, answers: string[], contact?: string): Promise<AnswerResult> {
  const req = await getEddRequest(id);
  if (!req) throw new EddError("NOT_FOUND", `No EDD request ${id}`);
  if (req.status !== "OPEN") throw new EddError("ALREADY_ANSWERED", "This request has already been answered");
  if (!Array.isArray(answers) || answers.length !== req.questions.length) {
    throw new EddError("VALIDATION", `expected ${req.questions.length} answers, got ${Array.isArray(answers) ? answers.length : 0}`);
  }
  const clean = answers.map((a) => String(a ?? "").trim());
  if (clean.some((a) => a.length === 0 || a.length > MAX_EDD_ANSWER_CHARS)) {
    throw new EddError("VALIDATION", `each answer must be 1–${MAX_EDD_ANSWER_CHARS} characters`);
  }
  const answeredAt = now();
  const hash = answersHash(id, clean);
  const response: EddResponse = { answers: clean, contact: contact?.trim() || null, answersHash: hash, answeredAt, rescreen: null, ledgerEntryId: null };

  const claim = await db().execute({
    sql: `UPDATE edd_requests SET status = 'ANSWERED', response = ?, answered_at = ? WHERE id = ? AND status = 'OPEN'`,
    args: [JSON.stringify(response), answeredAt, id],
  });
  if (claim.rowsAffected !== 1) throw new EddError("ALREADY_ANSWERED", "This request has already been answered");

  // Ledger: proves what was said (hash) without exposing it.
  const entry = await appendDecision({
    kind: "EDD_RESPONSE", subject: req.subject, clientId: "edd",
    payload: { eddId: id, subject: req.subject, decisionId: req.decisionId, answersHash: hash, answeredAt, questionCount: req.questions.length },
  });
  response.ledgerEntryId = entry.id;

  // Re-screen with the answers on file (the analyst sees prior history; the hash is in the log).
  let previousTier: Tier | null = null;
  try {
    const prev = await getDecision(req.decisionId);
    const t = (prev?.payload as { tier?: Tier } | null)?.tier;
    if (t === "LOW" || t === "MEDIUM" || t === "HIGH") previousTier = t;
  } catch { /* previous decision unavailable */ }
  try {
    const v = await screen({ address: req.subject, clientId: "edd" }, { kind: "RESCREEN" });
    response.rescreen = { decisionId: v.decisionId, tier: v.tier, previousTier, changed: previousTier !== null && previousTier !== v.tier, score: v.score };
  } catch (e) {
    response.rescreenError = (e as Error)?.message ?? String(e);
    console.warn("[edd] rescreen failed", id, response.rescreenError);
  }
  await db().execute({ sql: `UPDATE edd_requests SET response = ? WHERE id = ?`, args: [JSON.stringify(response), id] });

  return { id, status: "ANSWERED", answersHash: hash, ledgerEntryId: entry.id, rescreen: response.rescreen, ...(response.rescreenError ? { rescreenError: response.rescreenError } : {}) };
}

/** Operator acknowledgement (not exposed publicly). */
export async function markEddReviewed(id: string): Promise<boolean> {
  await migrate();
  const r = await db().execute({ sql: `UPDATE edd_requests SET status = 'REVIEWED' WHERE id = ? AND status = 'ANSWERED'`, args: [id] });
  return r.rowsAffected === 1;
}
