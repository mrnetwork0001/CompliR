/**
 * Operator decision: deterministic candidate actions under hard guards, then a guard-railed model step.
 *
 *   candidateActions(snapshot)  - code enumerates what is *allowed* right now (and why the rest is not)
 *   chooseWithModel(...)        - the model may only (a) pick among the listed candidates, (b) write the rationale,
 *                                 (c) set the next check interval in [15 min, 6 h]. Same pattern as analyst/analyze.ts:
 *                                 forced-tool structured output through the LLM provider seam (src/lib/llm: Anthropic or
 *                                 0G Compute, chosen by env), zod-parsed, deterministic fallback on any failure.
 *   validateAction(...)         - re-derives the candidate set and rejects anything not in it; run.ts calls this
 *                                 again right before executing, so the model can never add an action.
 */
import { resolveProvider, type AnalystModel } from "../analyst/client";
import { modelLabel } from "../llm";
import { planSweep } from "../usyc/sweep";
import { z } from "zod";
import { PRICE_BOUNDS, steppedPrice, validatePriceChange, type PriceKey } from "./pricing";
import type { CompanySnapshot } from "./state";

export type OperatorActionType = "SWEEP_TO_USYC" | "REDEEM_FROM_USYC" | "RUN_PAYOUTS" | "ADJUST_PRICE" | "HOLD";
export const OPERATOR_ACTIONS: readonly OperatorActionType[] = ["SWEEP_TO_USYC", "REDEEM_FROM_USYC", "RUN_PAYOUTS", "ADJUST_PRICE", "HOLD"] as const;

export interface OperatorAction {
  /** stable id inside one plan (c1, c2, …); what the model refers to */
  id: string;
  type: OperatorActionType;
  params: { amountUsdc?: number; key?: PriceKey; fromUsdc?: number; toUsdc?: number; pendingInvoices?: number; effectiveFloatUsdc?: number };
  reason: string;
}
export interface RejectedAction { type: OperatorActionType; reason: string }
export interface OperatorPlan {
  candidates: OperatorAction[];
  rejected: RejectedAction[];
  chosen: OperatorAction[];
  rationale: string;
  nextCheckInSeconds: number;
  meta: { model: string; fallback: boolean; latencyMs: number; error?: string; guardNotes: string[] };
}

export const NEXT_CHECK_MIN_S = 15 * 60;
export const NEXT_CHECK_MAX_S = 6 * 3600;
export const NEXT_CHECK_DEFAULT_S = 3600;
export const MAX_RATIONALE_WORDS = 160;

export interface DecideOptions {
  now?: number;
  /** paid calls / 24 h above which a price raise becomes a candidate (env OPERATOR_RAISE_CALLS_24H, default 50) */
  raiseCallsThreshold?: number;
  /** p95 latency ceiling for a raise, ms (env OPERATOR_MAX_P95_MS, default 8000) */
  maxP95Ms?: number;
  /** relative size of a price step (default 0.1 = 10%, always ≤ the 20% hard cap) */
  stepPct?: number;
  /** undefined → provider from env; null → deterministic plan; an LlmProvider or a mock Anthropic client (tests) */
  client?: AnalystModel | null;
}

function envNum(k: string, d: number): number {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && process.env[k] !== undefined && process.env[k] !== "" ? v : d;
}
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

// ─── 1. deterministic candidates ────────────────────────────────────────────
export function candidateActions(s: CompanySnapshot, opts: DecideOptions = {}): { candidates: OperatorAction[]; rejected: RejectedAction[] } {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const raiseAt = opts.raiseCallsThreshold ?? envNum("OPERATOR_RAISE_CALLS_24H", 50);
  const maxP95 = opts.maxP95Ms ?? envNum("OPERATOR_MAX_P95_MS", 8000);
  const stepPct = opts.stepPct ?? 0.1;
  const candidates: OperatorAction[] = [];
  const rejected: RejectedAction[] = [];
  let n = 0;
  const add = (type: OperatorActionType, params: OperatorAction["params"], reason: string) => candidates.push({ id: `c${++n}`, type, params, reason });

  if (s.mode?.paused) {
    rejected.push({ type: "RUN_PAYOUTS", reason: "COMPLIR_PAUSED" }, { type: "SWEEP_TO_USYC", reason: "COMPLIR_PAUSED" }, { type: "ADJUST_PRICE", reason: "COMPLIR_PAUSED" });
    add("HOLD", {}, "service paused; nothing moves");
    return { candidates, rejected };
  }

  // ── liquidity: keep float ≥ obligations due in 48 h + USYC_FLOAT_USDC, park the rest, redeem a shortfall ──
  const res = s.reserves;
  const due48h = s.obligations?.due48hUsdc ?? null;
  if (!res || res.floatUsdc == null) {
    rejected.push({ type: "SWEEP_TO_USYC", reason: `float unknown (${res?.error ?? s.errors.reserves ?? "no revenue wallet"})` });
  } else if (due48h == null) {
    rejected.push({ type: "SWEEP_TO_USYC", reason: `obligations unknown (${s.errors.obligations ?? "treasury unreadable"}) - never sweep blind` });
  } else {
    const effectiveFloat = r6(res.usycFloatUsdc + due48h);
    const plan = planSweep({ balanceUsdc: res.floatUsdc, floatUsdc: effectiveFloat, minSweepUsdc: res.usycMinSweepUsdc, usycUsdc: res.usycUsdc ?? 0 });
    if (plan.action === "DEPOSIT") add("SWEEP_TO_USYC", { amountUsdc: plan.amount, effectiveFloatUsdc: effectiveFloat }, `${plan.reason}; float keeps ${res.usycFloatUsdc} + ${due48h} due within 48 h`);
    else if (plan.action === "REDEEM") add("REDEEM_FROM_USYC", { amountUsdc: plan.amount, effectiveFloatUsdc: effectiveFloat }, plan.reason);
    else rejected.push({ type: "SWEEP_TO_USYC", reason: `${plan.reason} (effective float ${effectiveFloat} = ${res.usycFloatUsdc} USYC float + ${due48h} due 48 h)` });
  }

  // ── payouts: only when there is something pending and the daily cap still has room ──
  const ob = s.obligations;
  if (!ob) rejected.push({ type: "RUN_PAYOUTS", reason: `obligations unknown (${s.errors.obligations ?? "treasury unreadable"})` });
  else if (ob.pendingInvoices === 0) rejected.push({ type: "RUN_PAYOUTS", reason: "no pending invoices" });
  else if (ob.dailyHeadroomUsdc <= 0) rejected.push({ type: "RUN_PAYOUTS", reason: `daily cap exhausted (${ob.spentTodayUsdc} of ${ob.policy?.dailyCapUsdc ?? "?"} USDC spent today)` });
  else if (s.mode?.treasury === "live" && res?.floatUsdc != null && res.floatUsdc <= 0 && (res.usycUsdc ?? 0) <= 0) rejected.push({ type: "RUN_PAYOUTS", reason: "live treasury with zero reserves - refill before paying" });
  else add("RUN_PAYOUTS", { pendingInvoices: ob.pendingInvoices, amountUsdc: ob.dueTodayUsdc }, `${ob.pendingInvoices} pending invoice(s) totalling ${ob.pendingUsdc} USDC; ${ob.dailyHeadroomUsdc} USDC daily headroom (${s.mode?.treasury ?? "dry-run"}); every payee is screened and GuardedTreasury re-checks the tier on-chain`);

  // ── pricing: raise on demand, lower on silence, always within bounds / step / cooldown ──
  const pr = s.pricing;
  const rev = s.revenue;
  if (!pr || !rev) rejected.push({ type: "ADJUST_PRICE", reason: `pricing/revenue unknown (${s.errors.pricing ?? s.errors.revenue ?? "unreadable"})` });
  else if (s.mode?.x402 === "disabled") rejected.push({ type: "ADJUST_PRICE", reason: "x402 disabled (X402_DISABLED=1): nobody is charged, so there is no demand signal to price against" });
  else {
    const p95 = s.screening?.p95LatencyMs ?? null;
    const latencyOk = p95 == null || p95 <= maxP95;
    for (const key of ["screen", "watch"] as const) {
      const st = pr[key];
      let direction: "up" | "down" | null = null;
      let why = "";
      if (rev.callsPaid24h > raiseAt && latencyOk) { direction = "up"; why = `${rev.callsPaid24h} paid calls in 24 h > ${raiseAt} threshold${p95 == null ? " (latency unmeasured)" : ` (p95 ${p95} ms ≤ ${maxP95})`}`; }
      else if (rev.callsPaid24h > raiseAt && !latencyOk) { rejected.push({ type: "ADJUST_PRICE", reason: `${key}: demand is there (${rev.callsPaid24h} calls) but p95 ${p95} ms > ${maxP95} ms - fix latency before raising` }); continue; }
      else if (rev.outsideCalls48h === 0 && st.priceUsdc > PRICE_BOUNDS[key].min) { direction = "down"; why = `zero outside paid calls in 48 h`; }
      if (!direction) { rejected.push({ type: "ADJUST_PRICE", reason: `${key}: ${rev.callsPaid24h} paid calls / 24 h (raise above ${raiseAt}), ${rev.outsideCalls48h} outside calls / 48 h - price ${st.priceUsdc} holds` }); continue; }
      const target = steppedPrice(key, st.priceUsdc, direction, stepPct);
      if (target == null) { rejected.push({ type: "ADJUST_PRICE", reason: `${key}: already at the ${direction === "up" ? "ceiling" : "floor"} ${st.priceUsdc} USDC` }); continue; }
      const check = validatePriceChange(key, st.priceUsdc, target, st.changedAt, now);
      if (!check.ok) { rejected.push({ type: "ADJUST_PRICE", reason: `${key}: ${check.reason}` }); continue; }
      add("ADJUST_PRICE", { key, fromUsdc: st.priceUsdc, toUsdc: target }, `${direction === "up" ? "raise" : "lower"} ${key} ${st.priceUsdc} → ${target} USDC: ${why}; within [${PRICE_BOUNDS[key].min}, ${PRICE_BOUNDS[key].max}], ≤ 20% step, ≥ 6 h since last change`);
    }
  }

  add("HOLD", {}, candidates.length ? "do nothing this tick" : rejected.length ? `no allowed action - ${rejected.map((r) => `${r.type}: ${r.reason}`).join("; ")}` : "nothing to do: reserves, obligations and prices are where the guards want them");
  return { candidates, rejected };
}

/** Same action as a listed candidate? (type + every param equal) */
export function sameAction(a: Pick<OperatorAction, "type" | "params">, b: Pick<OperatorAction, "type" | "params">): boolean {
  if (a.type !== b.type) return false;
  const keys = new Set([...Object.keys(a.params ?? {}), ...Object.keys(b.params ?? {})]) as Set<keyof OperatorAction["params"]>;
  for (const k of keys) if (a.params?.[k] !== b.params?.[k]) return false;
  return true;
}

/** Re-derive the candidates from the snapshot and accept `action` only if it is one of them. */
export function validateAction(action: Pick<OperatorAction, "type" | "params">, s: CompanySnapshot, opts: DecideOptions = {}): { ok: boolean; reason: string } {
  if (!OPERATOR_ACTIONS.includes(action.type)) return { ok: false, reason: `unknown action type ${String(action.type)}` };
  const { candidates } = candidateActions(s, opts);
  const match = candidates.find((c) => sameAction(c, action));
  return match ? { ok: true, reason: match.reason } : { ok: false, reason: `${action.type}${Object.keys(action.params ?? {}).length ? " " + JSON.stringify(action.params) : ""} is not an allowed candidate for this snapshot` };
}

// ─── 2. deterministic choice (fallback) ──────────────────────────────────────
export function fallbackChoice(candidates: OperatorAction[], s: CompanySnapshot): { chosen: OperatorAction[]; rationale: string; nextCheckInSeconds: number } {
  const acts = candidates.filter((c) => c.type !== "HOLD");
  const chosen = acts.length ? acts : candidates.filter((c) => c.type === "HOLD").slice(0, 1);
  const rev = s.revenue, ob = s.obligations, res = s.reserves;
  const lines = [
    `Revenue ${rev ? `${rev.totalUsdc} USDC all-time (${rev.last24hUsdc} last 24 h, ${rev.callsPaid24h} paid calls)` : "unknown"}; reserves ${res?.floatUsdc != null ? `${res.floatUsdc} USDC float + ${res.usycUsdc ?? 0} in USYC` : "unknown"}; obligations ${ob ? `${ob.pendingInvoices} pending (${ob.pendingUsdc} USDC), ${ob.heldInvoices} held` : "unknown"}.`,
    acts.length ? `Acting: ${acts.map((a) => `${a.type} - ${a.reason}`).join(" · ")}.` : `Holding: ${candidates.find((c) => c.type === "HOLD")?.reason ?? "no allowed action"}.`,
  ];
  return { chosen, rationale: lines.join(" "), nextCheckInSeconds: acts.length ? NEXT_CHECK_MIN_S * 2 : NEXT_CHECK_DEFAULT_S };
}

// ─── 3. model step ───────────────────────────────────────────────────────────
const PlanOutputSchema = z.object({
  actionIds: z.array(z.string()),
  rationale: z.string(),
  nextCheckInSeconds: z.number(),
});
const TOOL = {
  name: "submit_plan",
  description: "Submit the operator plan. You may only reference candidate ids that were listed; anything else is discarded by code.",
  input_schema: {
    type: "object" as const,
    properties: {
      actionIds: { type: "array", items: { type: "string" }, description: "ids of the candidates to execute this tick (HOLD alone, or one or more non-HOLD candidates)" },
      rationale: { type: "string", description: "plain-English reasoning for the company page, ≤ 160 words, cite the numbers you used" },
      nextCheckInSeconds: { type: "number", description: "seconds until the next operator tick, between 900 and 21600" },
    },
    required: ["actionIds", "rationale", "nextCheckInSeconds"],
  },
};
export const OPERATOR_SYSTEM_PROMPT = `You are the operator of CompliR, a company on the Arc blockchain that sells risk screening (x402-paid API calls), holds its USDC in Circle wallets and USYC, and pays contributors through a GuardedTreasury that only releases to payees its own oracle cleared.
Code has already decided which actions are allowed this tick; you cannot add, alter or parameterise actions. Choose among the listed candidate ids, explain the choice to a human reader in plain English using the numbers in the snapshot, and set when to look again (900–21600 s). Prefer acting on allowed liquidity and payout candidates unless the snapshot shows a reason to wait; prefer shorter intervals when something is pending or just changed. Be concrete and honest; never invent numbers.`;

export function buildOperatorMessage(s: CompanySnapshot, candidates: OperatorAction[], rejected: RejectedAction[]): string {
  const slim = { ...s, reserves: s.reserves ? { ...s.reserves, circle: { enabled: s.reserves.circle.enabled, wallets: s.reserves.circle.wallets.map((w) => ({ role: w.role, status: w.status, balances: w.balances })) } } : null };
  return [
    "COMPANY SNAPSHOT (JSON):", JSON.stringify(slim),
    "", "ALLOWED CANDIDATES (choose by id):", ...candidates.map((c) => `${c.id}: ${c.type}${Object.keys(c.params).length ? " " + JSON.stringify(c.params) : ""} - ${c.reason}`),
    "", "NOT ALLOWED THIS TICK (for your rationale only):", ...(rejected.length ? rejected.map((r) => `${r.type}: ${r.reason}`) : ["(none)"]),
    "", "Call submit_plan.",
  ].join("\n");
}

function clampNextCheck(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : NEXT_CHECK_DEFAULT_S;
  return Math.max(NEXT_CHECK_MIN_S, Math.min(NEXT_CHECK_MAX_S, v));
}
function trimRationale(r: unknown): string {
  const text = (typeof r === "string" ? r : "").replace(/\s+/g, " ").trim();
  const words = text.split(" ");
  return words.length > MAX_RATIONALE_WORDS ? words.slice(0, MAX_RATIONALE_WORDS).join(" ") + " [...]" : text;
}

/**
 * Apply the guards to a model (or fallback) output: unknown ids dropped, HOLD never mixed with actions,
 * empty selection → deterministic fallback, interval clamped, rationale trimmed. Never throws.
 */
export function applyPlanGuards(out: z.infer<typeof PlanOutputSchema>, candidates: OperatorAction[], s: CompanySnapshot): { chosen: OperatorAction[]; rationale: string; nextCheckInSeconds: number; notes: string[] } {
  const notes: string[] = [];
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const picked: OperatorAction[] = [];
  for (const id of out.actionIds ?? []) {
    const c = byId.get(String(id));
    if (!c) { notes.push(`dropped unlisted action id "${String(id)}"`); continue; }
    if (!picked.some((p) => p.id === c.id)) picked.push(c);
  }
  let chosen = picked;
  if (chosen.length > 1 && chosen.some((c) => c.type === "HOLD")) { chosen = chosen.filter((c) => c.type !== "HOLD"); notes.push("HOLD dropped: cannot hold and act in the same tick"); }
  const fb = fallbackChoice(candidates, s);
  if (!chosen.length) { chosen = fb.chosen; notes.push("model selected nothing valid → deterministic choice"); }
  const next = clampNextCheck(out.nextCheckInSeconds);
  if (next !== out.nextCheckInSeconds) notes.push(`nextCheck clamped ${String(out.nextCheckInSeconds)} → ${next}s`);
  let rationale = trimRationale(out.rationale);
  if (!rationale) { rationale = fb.rationale; notes.push("empty rationale → deterministic rationale"); }
  else if (rationale.endsWith("[...]")) notes.push(`rationale truncated to ${MAX_RATIONALE_WORDS} words`);
  return { chosen, rationale, nextCheckInSeconds: next, notes };
}

/** Snapshot → plan. The model is optional (no provider configured → deterministic plan with meta.fallback = true). */
export async function decideOperations(s: CompanySnapshot, opts: DecideOptions = {}): Promise<OperatorPlan> {
  const t0 = Date.now();
  const { candidates, rejected } = candidateActions(s, opts);
  const provider = resolveProvider(opts.client);
  if (!provider) {
    const fb = fallbackChoice(candidates, s);
    return { candidates, rejected, ...fb, meta: { model: "fallback", fallback: true, latencyMs: Date.now() - t0, guardNotes: [] } };
  }
  const model = modelLabel(provider);
  try {
    const res = await provider.structured({
      system: OPERATOR_SYSTEM_PROMPT,
      user: buildOperatorMessage(s, candidates, rejected),
      schema: TOOL.input_schema, toolName: TOOL.name, toolDescription: TOOL.description,
      maxTokens: 700, temperature: 0.2,
    });
    const parsed = PlanOutputSchema.parse(res.data);
    const g = applyPlanGuards(parsed, candidates, s);
    return { candidates, rejected, chosen: g.chosen, rationale: g.rationale, nextCheckInSeconds: g.nextCheckInSeconds, meta: { model, fallback: false, latencyMs: Date.now() - t0, guardNotes: g.notes } };
  } catch (e) {
    const fb = fallbackChoice(candidates, s);
    return { candidates, rejected, ...fb, meta: { model, fallback: true, latencyMs: Date.now() - t0, error: e instanceof Error ? e.message : String(e), guardNotes: [] } };
  }
}
