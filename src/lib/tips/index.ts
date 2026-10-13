/**
 * Tip Market - public surface + the agent tick.
 *
 *   submitTip(input, meta)          create a tip (stake already settled by x402 or 0 for the same-origin demo) + ledger TIP/SUBMIT
 *   runTipsOnce(opts)               verify every SUBMITTED tip, pay every VERIFIED tip (daily cap), ledger entries for all of it
 *   reviewTip(id, decision, note)   human override for NEEDS_REVIEW (or any undecided) tips; pays immediately on VERIFIED
 *   tipEvidenceFor(address)         VERIFIED tips as oracle evidence (hook for src/lib/evidence/collect.ts)
 */
import { appendDecision } from "../ledger";
import { config } from "../config";
import type { Address } from "../types";
import {
  ANON_SUBMITTER, DEMO_SUBMITTER, TIPS_CLIENT_ID, anonSubmitter, bumpStats, claimForVerification, createTip, findStakePayment, getTip, listTips,
  recordTipOverride, removeTipOverride, reputationFor, tipsEnv, updateTip, type NewTip, type Tip, type TipVerification,
} from "./model";
import { payTip, payoutStatus, type PayOutcome, type Transfer } from "./payout";
import { bountyFor, corroborationStrength, verifyTip, type ReceiptClient, type ScreenFn } from "./verify";

export * from "./model";
export * from "./verify";
export * from "./payout";

const nowS = () => Math.floor(Date.now() / 1000);

// ─── Ledger helper: every market event is a hash-chained "TIP" entry ─────────
async function ledgerTip(event: "SUBMIT" | "VERIFY" | "PAY" | "SLASH" | "REVIEW" | "DROP", tip: Tip, extra: Record<string, unknown>): Promise<string> {
  const entry = await appendDecision({
    kind: "TIP",
    subject: tip.subject,
    clientId: TIPS_CLIENT_ID,
    payload: { type: "TIP", event, tipId: tip.id, subject: tip.subject, category: tip.category, submitter: anonSubmitter(tip.submitter), stakeUsdc: tip.stakeUsdc, ...extra },
  });
  return entry.id;
}

// ─── Submit ──────────────────────────────────────────────────────────────────
export interface SubmitMeta {
  /** x402 payer address, "demo" (same-origin) or "anonymous" (x402 disabled) */
  submitter: string;
  stakeUsdc: number;
  stakeTx?: string | null;
}
export async function submitTip(input: NewTip, meta: SubmitMeta): Promise<Tip> {
  const t = await createTip(input, { submitter: meta.submitter, stakeUsdc: meta.stakeUsdc });
  const submit = await ledgerTip("SUBMIT", t, { claimLength: t.claim.length, evidenceUrls: t.evidenceUrls.length, evidenceTxs: t.evidenceTxs.length, stakeTx: meta.stakeTx ?? null, demo: meta.submitter === DEMO_SUBMITTER });
  return (await updateTip(t.id, { ledger: { submit }, stakeTx: meta.stakeTx ?? null }))!;
}

// ─── Verify one tip (claimed SUBMITTED → VERIFYING → outcome) ─────────────────
export interface TickOptions {
  screenFn?: ScreenFn;
  client?: ReceiptClient | null;
  transfer?: Transfer;
  now?: number;
  /** max tips verified / paid per tick */
  limit?: number;
}

export interface TipOutcome {
  tipId: string;
  subject: Address;
  status: Tip["status"];
  decision: TipVerification["decision"] | null;
  tier: TipVerification["tier"];
  bountyUsdc: number;
  payoutUsdc: number;
  payoutTx: `0x${string}` | null;
  payoutMode: Tip["payoutMode"];
  note: string;
}

async function settleVerification(tip: Tip, v: TipVerification, opts: TickOptions): Promise<TipOutcome> {
  const now = opts.now ?? nowS();
  const ledger = { ...tip.ledger };
  const base: TipOutcome = { tipId: tip.id, subject: tip.subject, status: tip.status, decision: v.decision, tier: v.tier, bountyUsdc: 0, payoutUsdc: 0, payoutTx: null, payoutMode: null, note: v.reason };

  if (v.decision === "VERIFIED") {
    const rep = await reputationFor(tip.submitter);
    const bounty = bountyFor(tip.category, rep);
    ledger.verify = await ledgerTip("VERIFY", tip, { decision: "VERIFIED", by: v.by, tier: v.tier, score: v.score, rescreenDecisionId: v.decisionId, reasonCodes: v.reasonCodes, strong: v.corroboration.strong, weak: v.corroboration.weak, bountyUsdc: bounty, reputation: rep, reason: v.reason });
    await recordTipOverride({ tipId: tip.id, subject: tip.subject, category: tip.category, strength: corroborationStrength(v), tierAtVerification: v.tier, summary: `${tip.category}: ${tip.claim.slice(0, 140)}`, verifiedAt: v.verifiedAt });
    await bumpStats(tip.submitter, { verified: 1 });
    const updated = (await updateTip(tip.id, { status: "VERIFIED", verification: v, payoutUsdc: bounty, ledger, decidedAt: now }))!;
    const paid = await settlePayout(updated, opts);
    return { ...base, ...paid, bountyUsdc: bounty, decision: "VERIFIED" };
  }

  if (v.decision === "REJECTED") {
    const slashed = tip.stakeUsdc > 0;
    ledger.verify = await ledgerTip("VERIFY", tip, { decision: "REJECTED", by: v.by, tier: v.tier, score: v.score, rescreenDecisionId: v.decisionId, reasonCodes: v.reasonCodes, strong: v.corroboration.strong, weak: v.corroboration.weak, reason: v.reason });
    if (slashed) ledger.slash = await ledgerTip("SLASH", tip, { slashedUsdc: tip.stakeUsdc, stakeTx: tip.stakeTx, keptBy: config().X402_PAY_TO ?? null, reason: v.reason });
    await bumpStats(tip.submitter, { rejected: 1 });
    await removeTipOverride(tip.id);
    const status = slashed ? "SLASHED" : "REJECTED";
    await updateTip(tip.id, { status, verification: v, ledger, decidedAt: now });
    return { ...base, status, note: slashed ? `${v.reason} Stake ${tip.stakeUsdc} USDC slashed.` : v.reason };
  }

  ledger.verify = await ledgerTip("VERIFY", tip, { decision: "NEEDS_REVIEW", by: v.by, tier: v.tier, score: v.score, rescreenDecisionId: v.decisionId, reasonCodes: v.reasonCodes, strong: v.corroboration.strong, weak: v.corroboration.weak, reason: v.reason });
  await updateTip(tip.id, { status: "NEEDS_REVIEW", verification: v, ledger });
  return { ...base, status: "NEEDS_REVIEW" };
}

async function settlePayout(tip: Tip, opts: TickOptions): Promise<Pick<TipOutcome, "status" | "payoutUsdc" | "payoutTx" | "payoutMode" | "note">> {
  const now = opts.now ?? nowS();
  let out: PayOutcome;
  try {
    out = await payTip(tip, tip.payoutUsdc, { transfer: opts.transfer, now });
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    console.warn("[tips] payout failed for", tip.id, msg);
    return { status: "VERIFIED", payoutUsdc: tip.payoutUsdc, payoutTx: null, payoutMode: null, note: `payout failed, will retry: ${msg}` };
  }
  if (!out.paid) return { status: "VERIFIED", payoutUsdc: tip.payoutUsdc, payoutTx: null, payoutMode: null, note: out.note };
  const ledger = { ...tip.ledger, pay: await ledgerTip("PAY", tip, { amountUsdc: out.amountUsdc, mode: out.mode, txHash: out.txHash, simulated: out.txHash == null, note: out.note }) };
  await bumpStats(tip.submitter, { earnedUsdc: out.amountUsdc });
  await updateTip(tip.id, { status: "PAID", payoutUsdc: out.amountUsdc, payoutTx: out.txHash, payoutMode: out.mode, ledger, paidAt: now });
  return { status: "PAID", payoutUsdc: out.amountUsdc, payoutTx: out.txHash, payoutMode: out.mode, note: out.note };
}

// ─── The tick ────────────────────────────────────────────────────────────────
export interface TipsTickResult {
  payoutMode: Tip["payoutMode"];
  verified: number;
  rejected: number;
  needsReview: number;
  paid: number;
  deferred: number;
  dropped: number;
  failed: number;
  results: TipOutcome[];
}

let chain: Promise<unknown> = Promise.resolve(); // one tick at a time per process
export function runTipsOnce(opts: TickOptions = {}): Promise<TipsTickResult> {
  const p = chain.then(() => tick(opts), () => tick(opts));
  chain = p.catch(() => undefined);
  return p;
}

async function tick(opts: TickOptions): Promise<TipsTickResult> {
  const now = opts.now ?? nowS();
  const limit = opts.limit ?? 10;
  const r: TipsTickResult = { payoutMode: payoutStatus().mode, verified: 0, rejected: 0, needsReview: 0, paid: 0, deferred: 0, dropped: 0, failed: 0, results: [] };
  if (config().COMPLIR_PAUSED) return r;
  const grace = tipsEnv().stakeGraceSeconds;

  // 1. verify
  for (const tip of await listTips({ status: "SUBMITTED", order: "ASC", limit })) {
    // API tips: the stake must have settled (x402 sink → payments). settleFirst makes this immediate; the grace is for retries.
    if (tip.stakeUsdc > 0 && !tip.stakeTx) {
      const pay = await findStakePayment(tip);
      if (pay) await updateTip(tip.id, { stakeTx: pay.txHash ?? "settled" });
      else if (now - tip.createdAt > grace) {
        const drop = await ledgerTip("DROP", tip, { reason: `stake not settled within ${grace}s` });
        await updateTip(tip.id, { status: "REJECTED", ledger: { ...tip.ledger, verify: drop }, decidedAt: now, verification: { tier: null, score: null, decisionId: null, reasonCodes: [], corroboration: { txs: [], urls: [], strong: 0, weak: 0 }, decision: "REJECTED", reason: "stake never settled", by: "agent", verifiedAt: now } });
        r.dropped++;
        r.results.push({ tipId: tip.id, subject: tip.subject, status: "REJECTED", decision: "REJECTED", tier: null, bountyUsdc: 0, payoutUsdc: 0, payoutTx: null, payoutMode: null, note: "stake never settled - dropped (nothing to slash)" });
        continue;
      } else continue; // wait for the settlement to land
    }
    if (!(await claimForVerification(tip.id))) continue;
    try {
      const fresh = (await getTip(tip.id))!;
      const v = await verifyTip(fresh, { screenFn: opts.screenFn, client: opts.client, now });
      const out = await settleVerification(fresh, v, opts);
      if (out.decision === "VERIFIED") r.verified++; else if (out.decision === "REJECTED") r.rejected++; else r.needsReview++;
      if (out.status === "PAID") r.paid++; else if (out.status === "VERIFIED") r.deferred++;
      r.results.push(out);
    } catch (e) {
      r.failed++;
      console.warn("[tips] verify failed for", tip.id, (e as Error)?.message);
      await updateTip(tip.id, { status: "SUBMITTED" }); // release the claim; retried next tick
      r.results.push({ tipId: tip.id, subject: tip.subject, status: "SUBMITTED", decision: null, tier: null, bountyUsdc: 0, payoutUsdc: 0, payoutTx: null, payoutMode: null, note: `verify failed: ${(e as Error)?.message ?? String(e)}` });
    }
  }

  // 2. pay what is VERIFIED but unpaid (deferred by the cap / an earlier payout failure)
  for (const tip of await listTips({ status: "VERIFIED", order: "ASC", limit })) {
    if (r.results.some((x) => x.tipId === tip.id)) continue; // handled above this tick
    const paid = await settlePayout(tip, opts);
    if (paid.status === "PAID") r.paid++; else r.deferred++;
    r.results.push({ tipId: tip.id, subject: tip.subject, status: paid.status, decision: "VERIFIED", tier: tip.verification?.tier ?? null, bountyUsdc: tip.payoutUsdc, payoutUsdc: paid.payoutUsdc, payoutTx: paid.payoutTx, payoutMode: paid.payoutMode, note: paid.note });
  }
  return r;
}

// ─── Human review ────────────────────────────────────────────────────────────
export async function reviewTip(id: string, decision: "VERIFIED" | "REJECTED", note?: string, opts: TickOptions = {}): Promise<TipOutcome | null> {
  const tip = await getTip(id);
  if (!tip) return null;
  if (tip.status === "PAID") return { tipId: tip.id, subject: tip.subject, status: tip.status, decision: "VERIFIED", tier: tip.verification?.tier ?? null, bountyUsdc: tip.payoutUsdc, payoutUsdc: tip.payoutUsdc, payoutTx: tip.payoutTx, payoutMode: tip.payoutMode, note: "already paid; nothing to review" };
  const now = opts.now ?? nowS();
  const prev = tip.verification;
  const v: TipVerification = {
    tier: prev?.tier ?? null, score: prev?.score ?? null, decisionId: prev?.decisionId ?? null, reasonCodes: prev?.reasonCodes ?? [],
    corroboration: prev?.corroboration ?? { txs: [], urls: [], strong: 0, weak: 0 },
    decision, reason: `Human review: ${decision}${note ? ` - ${note}` : ""}${prev ? ` (agent said ${prev.decision}: ${prev.reason})` : ""}`, by: "human", verifiedAt: now,
  };
  // undo a previous automatic outcome's counters so stats stay consistent
  if (tip.status === "VERIFIED") await bumpStats(tip.submitter, { verified: -1 });
  if (tip.status === "REJECTED" || tip.status === "SLASHED") await bumpStats(tip.submitter, { rejected: -1 });
  const review = await ledgerTip("REVIEW", tip, { decision, note: note ?? null, previousStatus: tip.status });
  const claimed = (await updateTip(tip.id, { status: "VERIFYING", ledger: { ...tip.ledger, review } }))!;
  return settleVerification(claimed, v, opts);
}

export { ANON_SUBMITTER, DEMO_SUBMITTER };
