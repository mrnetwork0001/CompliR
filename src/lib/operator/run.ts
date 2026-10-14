/**
 * One operator tick: snapshot → decide → execute (each executor honours its own dry-run mode) → ONE signed ledger
 * entry of kind "OPERATOR" with the snapshot summary, candidates, chosen actions + results, rationale and the next
 * check time. The ledger entry is the company's own record of why it did what it did.
 */
import { appendDecision } from "../ledger";
import { runTreasuryOnce } from "../treasury";
import { runRevenueYieldOnce } from "../earn";
import { config } from "../config";
import type { DecisionLogEntry } from "../types";
import { decideOperations, validateAction, type DecideOptions, type OperatorAction, type OperatorPlan } from "./decide";
import { setPrice } from "./pricing";
import { companySnapshot, type CompanySnapshot } from "./state";

export const OPERATOR_CLIENT_ID = "operator";

export interface ActionResult {
  action: OperatorAction;
  ok: boolean;
  /** executor output (TickResult summary, SweepResult summary, SetPriceResult) */
  result: unknown;
  error?: string;
  /** guard re-check right before execution */
  revalidated: { ok: boolean; reason: string };
}
export interface OperatorTick {
  entry: DecisionLogEntry;
  snapshot: CompanySnapshot;
  plan: OperatorPlan;
  results: ActionResult[];
  nextCheckAt: number;
}
export interface RunOptions extends DecideOptions {
  snapshotFn?: () => Promise<CompanySnapshot>;
  executors?: Partial<Executors>;
}
export interface Executors {
  payouts: () => Promise<unknown>;
  sweep: (effectiveFloatUsdc: number | undefined) => Promise<unknown>;
  price: (key: "screen" | "watch", to: number, reason: string, now: number) => Promise<unknown>;
}

/** One yield tick with the operator's effective float (cushion + obligations due in 48 h - never less than the env float). */
async function sweepWithFloat(effectiveFloatUsdc: number | undefined): Promise<unknown> {
  const r = await runRevenueYieldOnce({ floatUsdc: effectiveFloatUsdc });
  return { backend: r.backend, mode: r.mode, executed: r.executed, plan: r.plan, balances: r.balances, txs: r.txs, decisionId: r.decisionId, skipped: r.skipped, error: r.error, floatUsdc: effectiveFloatUsdc };
}

const defaultExecutors: Executors = {
  payouts: async () => {
    const r = await runTreasuryOnce();
    return { mode: r.mode, processed: r.processed, paid: r.paid, limited: r.limited, held: r.held, failed: r.failed, results: r.results.map((x) => ({ invoiceId: x.invoiceId, label: x.label, status: x.status, tier: x.tier, paidUsdc: x.paidUsdc, heldUsdc: x.heldUsdc, txHash: x.txHash, payoutDecisionId: x.payoutDecisionId })) };
  },
  sweep: sweepWithFloat,
  price: (key, to, reason, now) => setPrice(key, to, reason, { now }),
};

/** Order of execution: payouts (treasury funds) → prices → liquidity sweep (revenue wallet). */
const ORDER: Record<OperatorAction["type"], number> = { RUN_PAYOUTS: 0, ADJUST_PRICE: 1, SWEEP_TO_YIELD: 2, REDEEM_FROM_YIELD: 2, HOLD: 3 };

function snapshotSummary(s: CompanySnapshot) {
  return {
    asOf: s.asOf, errors: s.errors,
    revenue: s.revenue, obligations: s.obligations, screening: s.screening, mode: s.mode,
    pricing: s.pricing ? { screenUsdc: s.pricing.screenUsdc, watchUsdc: s.pricing.watchUsdc, lastChangeAt: s.pricing.lastChangeAt, reason: s.pricing.reason } : null,
    reserves: s.reserves ? {
      floatUsdc: s.reserves.floatUsdc, yieldUsdc: s.reserves.yieldUsdc, positions: s.reserves.positions, revenueWallet: s.reserves.revenueWallet, yieldBackend: s.reserves.yieldBackend, yieldMode: s.reserves.yieldMode, yieldFloatUsdc: s.reserves.yieldFloatUsdc,
      preferredVault: s.reserves.preferredVault,
      circle: { enabled: s.reserves.circle.enabled, wallets: s.reserves.circle.wallets.map((w) => ({ role: w.role, address: w.address, status: w.status, balances: w.balances })) },
    } : null,
  };
}

export async function runOperatorOnce(opts: RunOptions = {}): Promise<OperatorTick> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const ex: Executors = { ...defaultExecutors, ...(opts.executors ?? {}) };
  const snapshot = await (opts.snapshotFn ?? companySnapshot)();
  const plan = await decideOperations(snapshot, { ...opts, now });

  const results: ActionResult[] = [];
  const chosen = [...plan.chosen].sort((a, b) => ORDER[a.type] - ORDER[b.type]);
  for (const action of chosen) {
    // code has the last word: re-derive the guards right before touching anything
    const revalidated = validateAction(action, snapshot, { ...opts, now });
    if (!revalidated.ok) { results.push({ action, ok: false, result: null, error: `rejected by guards: ${revalidated.reason}`, revalidated }); continue; }
    try {
      let result: unknown = null;
      switch (action.type) {
        case "RUN_PAYOUTS": result = await ex.payouts(); break;
        case "SWEEP_TO_YIELD":
        case "REDEEM_FROM_YIELD": result = await ex.sweep(action.params.effectiveFloatUsdc); break;
        case "ADJUST_PRICE": result = await ex.price(action.params.key!, action.params.toUsdc!, action.reason, now); break;
        case "HOLD": result = { held: true }; break;
      }
      const failed = typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === false;
      results.push({ action, ok: !failed, result, revalidated, ...(failed ? { error: String((result as { reason?: unknown }).reason ?? "executor refused") } : {}) });
    } catch (e) {
      results.push({ action, ok: false, result: null, error: (e as Error)?.message ?? String(e), revalidated });
    }
  }

  const nextCheckAt = now + plan.nextCheckInSeconds;
  const payload = {
    type: "OPERATOR",
    snapshot: snapshotSummary(snapshot),
    candidates: plan.candidates,
    rejected: plan.rejected,
    chosen: results.map((r) => ({ id: r.action.id, type: r.action.type, params: r.action.params, ok: r.ok, result: r.result, error: r.error ?? null })),
    rationale: plan.rationale,
    nextCheckInSeconds: plan.nextCheckInSeconds,
    nextCheckAt,
    meta: { ...plan.meta, paused: Boolean(snapshot.mode?.paused), chainId: safeChainId() },
    at: now,
  };
  const entry = await appendDecision({ kind: "OPERATOR", subject: null, clientId: OPERATOR_CLIENT_ID, payload });
  return { entry, snapshot, plan, results, nextCheckAt };
}

function safeChainId(): number | null {
  try { return config().ARC_CHAIN_ID; } catch { return null; }
}
